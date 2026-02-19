import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';

export interface FileMetadata {
  id: string;
  name: string;
  size: number;
  hash: string;
  uploadedAt: number;
  indexed: boolean;
  peerId: string;
  mimeType: string;
  checksum: string;
  replicatedOn: string[]; // List of peer IDs that have this file
  lastModified: number;
}

export interface StorageQuota {
  totalGB: number;
  usedGB: number;
  availableGB: number;
  costPerMonth: number;
}

export interface PeerInfo {
  peerId: string;
  address: string;
  port: number;
  isConnected: boolean;
  lastSeen: number;
  filesCount: number;
}

class PersistentStorageService {
  private db: any;
  private fileIndex: Map<string, FileMetadata> = new Map();
  private storageQuota: StorageQuota = {
    totalGB: 1, // Default 1TB
    usedGB: 0,
    availableGB: 1,
    costPerMonth: 1,
  };
  private peers: Map<string, PeerInfo> = new Map();
  private localStorageKey = 'p2p-storage-metadata';
  private peersStorageKey = 'p2p-storage-peers';

  async initialize() {
    try {
      // Initialize IndexedDB for browser storage
      const dbRequest = indexedDB.open('p2p-storage-persistent', 2);

      return new Promise((resolve, reject) => {
        dbRequest.onerror = () => {
          console.error('Failed to open IndexedDB');
          reject(dbRequest.error);
        };

        dbRequest.onsuccess = (event: any) => {
          this.db = event.target.result;
          this.loadFileIndex();
          this.loadPeers();
          resolve(this.db);
        };

        dbRequest.onupgradeneeded = (event: any) => {
          const db = event.target.result;
          
          // Create object stores if they don't exist
          if (!db.objectStoreNames.contains('files')) {
            db.createObjectStore('files', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('metadata')) {
            db.createObjectStore('metadata', { keyPath: 'hash' });
          }
          if (!db.objectStoreNames.contains('peers')) {
            db.createObjectStore('peers', { keyPath: 'peerId' });
          }
          if (!db.objectStoreNames.contains('replication')) {
            db.createObjectStore('replication', { keyPath: 'fileHash' });
          }
        };
      });
    } catch (error) {
      console.error('Failed to initialize persistent storage:', error);
      throw error;
    }
  }

  async addFile(
    file: File,
    indexed: boolean = false,
    peerId: string = ''
  ): Promise<FileMetadata> {
    try {
      const fileId = uuidv4();
      const fileBuffer = await file.arrayBuffer();
      const fileHash = this.calculateHash(fileBuffer);
      const checksum = CryptoJS.SHA256(
        CryptoJS.enc.Hex.parse(fileHash)
      ).toString();

      const metadata: FileMetadata = {
        id: fileId,
        name: file.name,
        size: file.size,
        hash: fileHash,
        uploadedAt: Date.now(),
        lastModified: Date.now(),
        indexed,
        peerId: peerId || this.getLocalPeerId(),
        mimeType: file.type,
        checksum,
        replicatedOn: [peerId || this.getLocalPeerId()],
      };

      // Store in IndexedDB
      if (this.db) {
        await this.storeFileInDB(fileId, fileBuffer, metadata);
      }

      // Also store in localStorage as backup
      this.storeFileInLocalStorage(metadata);

      // Update file index
      this.fileIndex.set(fileHash, metadata);

      // Update storage quota
      this.updateStorageQuota();

      // Trigger replication to connected peers
      await this.replicateFileToPeers(metadata, fileBuffer);

      return metadata;
    } catch (error) {
      console.error('Failed to add file:', error);
      throw error;
    }
  }

  async getFile(fileHash: string): Promise<File | null> {
    try {
      // First try to get from IndexedDB
      if (this.db) {
        const file = await this.getFileFromDB(fileHash);
        if (file) return file;
      }

      // If not found, try to get from a peer that has it
      const metadata = this.fileIndex.get(fileHash);
      if (metadata && metadata.replicatedOn.length > 0) {
        // Try to fetch from a peer
        for (const peerId of metadata.replicatedOn) {
          const peer = this.peers.get(peerId);
          if (peer && peer.isConnected) {
            try {
              const file = await this.fetchFileFromPeer(peerId, fileHash);
              if (file) {
                // Cache it locally
                const fileBuffer = await file.arrayBuffer();
                await this.storeFileInDB(metadata.id, fileBuffer, metadata);
                return file;
              }
            } catch (err) {
              console.error(`Failed to fetch from peer ${peerId}:`, err);
            }
          }
        }
      }

      return null;
    } catch (error) {
      console.error('Failed to get file:', error);
      throw error;
    }
  }

  async deleteFile(fileHash: string): Promise<boolean> {
    try {
      if (!this.db) return false;

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(
          ['files', 'metadata', 'replication'],
          'readwrite'
        );
        const fileStore = transaction.objectStore('files');
        const metadataStore = transaction.objectStore('metadata');
        const replicationStore = transaction.objectStore('replication');

        // Delete from metadata
        metadataStore.delete(fileHash);

        // Delete replication info
        replicationStore.delete(fileHash);

        // Delete from files
        const fileRequest = fileStore.getAll();
        fileRequest.onsuccess = (event: any) => {
          const files = event.target.result;
          const fileToDelete = files.find(
            (f: any) => f.metadata.hash === fileHash
          );
          if (fileToDelete) {
            fileStore.delete(fileToDelete.id);
          }
        };

        transaction.oncomplete = () => {
          this.fileIndex.delete(fileHash);
          this.updateStorageQuota();
          
          // Remove from localStorage backup
          this.removeFileFromLocalStorage(fileHash);
          
          // Notify peers to delete the file
          this.notifyPeersToDeleteFile(fileHash);
          
          resolve(true);
        };

        transaction.onerror = () => reject(transaction.error);
      });
    } catch (error) {
      console.error('Failed to delete file:', error);
      throw error;
    }
  }

  async searchFiles(query: string): Promise<FileMetadata[]> {
    try {
      const results: FileMetadata[] = [];
      const lowerQuery = query.toLowerCase();

      for (const metadata of this.fileIndex.values()) {
        if (
          metadata.name.toLowerCase().includes(lowerQuery) ||
          metadata.hash.includes(query)
        ) {
          results.push(metadata);
        }
      }

      return results;
    } catch (error) {
      console.error('Failed to search files:', error);
      throw error;
    }
  }

  // Peer management
  async registerPeer(peerId: string, address: string, port: number): Promise<void> {
    const peerInfo: PeerInfo = {
      peerId,
      address,
      port,
      isConnected: true,
      lastSeen: Date.now(),
      filesCount: 0,
    };

    this.peers.set(peerId, peerInfo);

    // Store in IndexedDB
    if (this.db) {
      const transaction = this.db.transaction(['peers'], 'readwrite');
      const store = transaction.objectStore('peers');
      store.put(peerInfo);
    }

    // Store in localStorage
    this.savePeersToLocalStorage();
  }

  async disconnectPeer(peerId: string): Promise<void> {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.isConnected = false;
      peer.lastSeen = Date.now();
      this.peers.set(peerId, peer);

      if (this.db) {
        const transaction = this.db.transaction(['peers'], 'readwrite');
        const store = transaction.objectStore('peers');
        store.put(peer);
      }

      this.savePeersToLocalStorage();
    }
  }

  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values());
  }

  getConnectedPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).filter((p) => p.isConnected);
  }

  // File index and quota
  getFileIndex(): FileMetadata[] {
    return Array.from(this.fileIndex.values());
  }

  getStorageQuota(): StorageQuota {
    return this.storageQuota;
  }

  setStorageQuota(totalGB: number): void {
    this.storageQuota.totalGB = totalGB;
    this.storageQuota.costPerMonth = totalGB * 1; // $1 per TB
    this.updateStorageQuota();
  }

  // Private helper methods
  private async storeFileInDB(
    fileId: string,
    fileBuffer: ArrayBuffer,
    metadata: FileMetadata
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['files', 'metadata'], 'readwrite');
      const fileStore = transaction.objectStore('files');
      const metadataStore = transaction.objectStore('metadata');

      fileStore.put({
        id: fileId,
        data: fileBuffer,
        metadata,
      });

      metadataStore.put(metadata);

      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  }

  private async getFileFromDB(fileHash: string): Promise<File | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(['files'], 'readonly');
      const store = transaction.objectStore('files');
      const request = store.getAll();

      request.onsuccess = (event: any) => {
        const files = event.target.result;
        const fileData = files.find(
          (f: any) => f.metadata.hash === fileHash
        );

        if (fileData) {
          const blob = new Blob([fileData.data], {
            type: fileData.metadata.mimeType,
          });
          const file = new File([blob], fileData.metadata.name, {
            type: fileData.metadata.mimeType,
          });
          resolve(file);
        } else {
          resolve(null);
        }
      };

      request.onerror = () => reject(request.error);
    });
  }

  private storeFileInLocalStorage(metadata: FileMetadata): void {
    try {
      const stored = localStorage.getItem(this.localStorageKey);
      const files = stored ? JSON.parse(stored) : {};
      files[metadata.hash] = metadata;
      localStorage.setItem(this.localStorageKey, JSON.stringify(files));
    } catch (error) {
      console.error('Failed to store in localStorage:', error);
    }
  }

  private removeFileFromLocalStorage(fileHash: string): void {
    try {
      const stored = localStorage.getItem(this.localStorageKey);
      if (stored) {
        const files = JSON.parse(stored);
        delete files[fileHash];
        localStorage.setItem(this.localStorageKey, JSON.stringify(files));
      }
    } catch (error) {
      console.error('Failed to remove from localStorage:', error);
    }
  }

  private loadFileIndex(): void {
    if (!this.db) return;

    const transaction = this.db.transaction(['metadata'], 'readonly');
    const store = transaction.objectStore('metadata');
    const request = store.getAll();

    request.onsuccess = (event: any) => {
      const files = event.target.result;
      for (const metadata of files) {
        this.fileIndex.set(metadata.hash, metadata);
      }
      this.updateStorageQuota();
    };
  }

  private updateStorageQuota(): void {
    let usedBytes = 0;
    for (const metadata of this.fileIndex.values()) {
      usedBytes += metadata.size;
    }

    this.storageQuota.usedGB = usedBytes / (1024 * 1024 * 1024);
    this.storageQuota.availableGB = Math.max(
      0,
      this.storageQuota.totalGB - this.storageQuota.usedGB
    );
  }

  private calculateHash(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hash = '';
    for (let i = 0; i < bytes.length; i++) {
      hash += bytes[i].toString(16).padStart(2, '0');
    }
    return hash;
  }

  private getLocalPeerId(): string {
    let peerId = localStorage.getItem('local-peer-id');
    if (!peerId) {
      peerId = `peer-${uuidv4()}`;
      localStorage.setItem('local-peer-id', peerId);
    }
    return peerId;
  }

  private savePeersToLocalStorage(): void {
    try {
      const peersArray = Array.from(this.peers.values());
      localStorage.setItem(this.peersStorageKey, JSON.stringify(peersArray));
    } catch (error) {
      console.error('Failed to save peers to localStorage:', error);
    }
  }

  private loadPeers(): void {
    try {
      const stored = localStorage.getItem(this.peersStorageKey);
      if (stored) {
        const peersArray = JSON.parse(stored);
        for (const peer of peersArray) {
          this.peers.set(peer.peerId, peer);
        }
      }
    } catch (error) {
      console.error('Failed to load peers from localStorage:', error);
    }
  }

  private async replicateFileToPeers(
    metadata: FileMetadata,
    fileBuffer: ArrayBuffer
  ): Promise<void> {
    const connectedPeers = this.getConnectedPeers();
    
    for (const peer of connectedPeers) {
      try {
        await this.sendFileToPeer(peer.peerId, metadata, fileBuffer);
        
        // Update replication info
        if (!metadata.replicatedOn.includes(peer.peerId)) {
          metadata.replicatedOn.push(peer.peerId);
          this.fileIndex.set(metadata.hash, metadata);
        }
      } catch (error) {
        console.error(`Failed to replicate to peer ${peer.peerId}:`, error);
      }
    }
  }

  private async sendFileToPeer(
    peerId: string,
    metadata: FileMetadata,
    fileBuffer: ArrayBuffer
  ): Promise<void> {
    // This would be implemented with actual P2P communication
    // For now, we'll simulate it
    console.log(`Sending file ${metadata.name} to peer ${peerId}`);
    
    // In a real implementation, this would use libp2p or similar
    // to send the file to the peer
  }

  private async fetchFileFromPeer(
    peerId: string,
    fileHash: string
  ): Promise<File | null> {
    // This would be implemented with actual P2P communication
    console.log(`Fetching file ${fileHash} from peer ${peerId}`);
    
    // In a real implementation, this would use libp2p or similar
    // to fetch the file from the peer
    return null;
  }

  private async notifyPeersToDeleteFile(fileHash: string): Promise<void> {
    const connectedPeers = this.getConnectedPeers();
    
    for (const peer of connectedPeers) {
      try {
        console.log(`Notifying peer ${peer.peerId} to delete file ${fileHash}`);
        // In a real implementation, this would send a delete notification
      } catch (error) {
        console.error(`Failed to notify peer ${peer.peerId}:`, error);
      }
    }
  }
}

export const persistentStorageService = new PersistentStorageService();
