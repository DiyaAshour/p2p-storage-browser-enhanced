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
  replicatedOn: string[];
  lastModified: number;
  isValid: boolean;
  retryCount: number;
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

class ImprovedStorageService {
  private db: any;
  private fileIndex: Map<string, FileMetadata> = new Map();
  private storageQuota: StorageQuota = {
    totalGB: 1,
    usedGB: 0,
    availableGB: 1,
    costPerMonth: 1,
  };
  private peers: Map<string, PeerInfo> = new Map();
  private localStorageKey = 'p2p-storage-metadata';
  private peersStorageKey = 'p2p-storage-peers';
  private filesStorageKey = 'p2p-storage-files';
  private maxRetries = 3;

  async initialize() {
    try {
      const dbRequest = indexedDB.open('p2p-storage-improved', 3);

      return new Promise((resolve, reject) => {
        dbRequest.onerror = () => {
          console.error('Failed to open IndexedDB');
          reject(dbRequest.error);
        };

        dbRequest.onsuccess = (event: any) => {
          this.db = event.target.result;
          this.loadFileIndex();
          this.loadPeers();
          this.validateStoredFiles();
          resolve(this.db);
        };

        dbRequest.onupgradeneeded = (event: any) => {
          const db = event.target.result;
          
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
          if (!db.objectStoreNames.contains('cache')) {
            db.createObjectStore('cache', { keyPath: 'hash' });
          }
        };
      });
    } catch (error) {
      console.error('Failed to initialize storage:', error);
      throw error;
    }
  }

  async addFile(
    file: File,
    indexed: boolean = false,
    peerId: string = ''
  ): Promise<FileMetadata> {
    try {
      // Validate file
      if (!file || file.size === 0) {
        throw new Error('Invalid file: file is empty');
      }

      const fileId = uuidv4();
      const fileBuffer = await file.arrayBuffer();
      
      // Calculate hash with error checking
      const fileHash = this.calculateHash(fileBuffer);
      if (!fileHash || fileHash.length === 0) {
        throw new Error('Failed to calculate file hash');
      }

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
        isValid: true,
        retryCount: 0,
      };

      // Store in IndexedDB with error handling
      if (this.db) {
        await this.storeFileInDB(fileId, fileBuffer, metadata);
      }

      // Store in localStorage as backup
      this.storeFileInLocalStorage(metadata, fileBuffer);

      // Update file index
      this.fileIndex.set(fileHash, metadata);

      // Update storage quota
      this.updateStorageQuota();

      // Trigger replication
      await this.replicateFileToPeers(metadata, fileBuffer);

      console.log(`✅ File stored successfully: ${file.name}`);
      return metadata;
    } catch (error) {
      console.error('Failed to add file:', error);
      throw error;
    }
  }

  async getFile(fileHash: string): Promise<File | null> {
    try {
      const metadata = this.fileIndex.get(fileHash);
      
      if (!metadata) {
        throw new Error(`File not found: ${fileHash}`);
      }

      // Try to get from IndexedDB first
      if (this.db) {
        try {
          const file = await this.getFileFromDB(fileHash);
          if (file) {
            console.log(`✅ File retrieved from IndexedDB: ${metadata.name}`);
            return file;
          }
        } catch (err) {
          console.warn(`Failed to get from IndexedDB: ${err}`);
        }
      }

      // Try localStorage backup
      try {
        const file = await this.getFileFromLocalStorage(fileHash);
        if (file) {
          console.log(`✅ File retrieved from localStorage: ${metadata.name}`);
          return file;
        }
      } catch (err) {
        console.warn(`Failed to get from localStorage: ${err}`);
      }

      // Try to get from connected peers
      if (metadata.replicatedOn && metadata.replicatedOn.length > 0) {
        for (const peerId of metadata.replicatedOn) {
          if (peerId === this.getLocalPeerId()) continue;
          
          const peer = this.peers.get(peerId);
          if (peer && peer.isConnected) {
            try {
              const file = await this.fetchFileFromPeer(peerId, fileHash);
              if (file) {
                console.log(`✅ File retrieved from peer ${peerId}: ${metadata.name}`);
                // Cache it locally
                const fileBuffer = await file.arrayBuffer();
                await this.storeFileInDB(metadata.id, fileBuffer, metadata);
                return file;
              }
            } catch (err) {
              console.warn(`Failed to fetch from peer ${peerId}: ${err}`);
            }
          }
        }
      }

      throw new Error(`Failed to retrieve file: ${metadata.name}`);
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
          ['files', 'metadata', 'replication', 'cache'],
          'readwrite'
        );
        const fileStore = transaction.objectStore('files');
        const metadataStore = transaction.objectStore('metadata');
        const replicationStore = transaction.objectStore('replication');
        const cacheStore = transaction.objectStore('cache');

        // Delete from metadata
        metadataStore.delete(fileHash);
        replicationStore.delete(fileHash);
        cacheStore.delete(fileHash);

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
          this.removeFileFromLocalStorage(fileHash);
          this.notifyPeersToDeleteFile(fileHash);
          console.log(`✅ File deleted: ${fileHash}`);
          resolve(true);
        };

        transaction.onerror = () => {
          console.error('Transaction error:', transaction.error);
          reject(transaction.error);
        };
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

    if (this.db) {
      const transaction = this.db.transaction(['peers'], 'readwrite');
      const store = transaction.objectStore('peers');
      store.put(peerInfo);
    }

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

  getFileIndex(): FileMetadata[] {
    return Array.from(this.fileIndex.values());
  }

  getStorageQuota(): StorageQuota {
    return this.storageQuota;
  }

  setStorageQuota(totalGB: number): void {
    this.storageQuota.totalGB = totalGB;
    this.storageQuota.costPerMonth = totalGB * 1;
    this.updateStorageQuota();
  }

  // Private methods
  private async storeFileInDB(
    fileId: string,
    fileBuffer: ArrayBuffer,
    metadata: FileMetadata
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['files', 'metadata', 'cache'], 'readwrite');
        const fileStore = transaction.objectStore('files');
        const metadataStore = transaction.objectStore('metadata');
        const cacheStore = transaction.objectStore('cache');

        fileStore.put({
          id: fileId,
          data: fileBuffer,
          metadata,
        });

        metadataStore.put(metadata);
        
        // Cache for quick access
        cacheStore.put({
          hash: metadata.hash,
          data: fileBuffer,
          timestamp: Date.now(),
        });

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      } catch (error) {
        reject(error);
      }
    });
  }

  private async getFileFromDB(fileHash: string): Promise<File | null> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['files', 'cache'], 'readonly');
        
        // Try cache first
        const cacheStore = transaction.objectStore('cache');
        const cacheRequest = cacheStore.get(fileHash);
        
        cacheRequest.onsuccess = (event: any) => {
          const cached = event.target.result;
          if (cached) {
            const metadata = this.fileIndex.get(fileHash);
            if (metadata) {
              const blob = new Blob([cached.data], {
                type: metadata.mimeType,
              });
              const file = new File([blob], metadata.name, {
                type: metadata.mimeType,
              });
              resolve(file);
              return;
            }
          }

          // Try main storage
          const fileStore = transaction.objectStore('files');
          const fileRequest = fileStore.getAll();

          fileRequest.onsuccess = (event: any) => {
            const files = event.target.result;
            const fileData = files.find(
              (f: any) => f.metadata.hash === fileHash
            );

            if (fileData && fileData.data) {
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

          fileRequest.onerror = () => reject(fileRequest.error);
        };

        cacheRequest.onerror = () => reject(cacheRequest.error);
      } catch (error) {
        reject(error);
      }
    });
  }

  private storeFileInLocalStorage(metadata: FileMetadata, fileBuffer: ArrayBuffer): void {
    try {
      const stored = localStorage.getItem(this.localStorageKey);
      const files = stored ? JSON.parse(stored) : {};
      files[metadata.hash] = metadata;
      localStorage.setItem(this.localStorageKey, JSON.stringify(files));

      // Store file data as base64 for small files
      if (fileBuffer.byteLength < 5 * 1024 * 1024) { // 5MB limit
        const uint8Array = new Uint8Array(fileBuffer);
        const binaryString = String.fromCharCode.apply(null, Array.from(uint8Array));
        const base64 = btoa(binaryString);
        const filesData = localStorage.getItem(this.filesStorageKey);
        const filesObj = filesData ? JSON.parse(filesData) : {};
        filesObj[metadata.hash] = base64;
        localStorage.setItem(this.filesStorageKey, JSON.stringify(filesObj));
      }
    } catch (error) {
      console.warn('Failed to store in localStorage:', error);
    }
  }

  private async getFileFromLocalStorage(fileHash: string): Promise<File | null> {
    try {
      const stored = localStorage.getItem(this.localStorageKey);
      if (!stored) return null;

      const files = JSON.parse(stored);
      const metadata = files[fileHash];
      if (!metadata) return null;

      const filesData = localStorage.getItem(this.filesStorageKey);
      if (!filesData) return null;

      const filesObj = JSON.parse(filesData);
      const base64 = filesObj[fileHash];
      if (!base64) return null;

      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      const blob = new Blob([bytes], { type: metadata.mimeType });
      const file = new File([blob], metadata.name, { type: metadata.mimeType });
      return file;
    } catch (error) {
      console.warn('Failed to get from localStorage:', error);
      return null;
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

      const filesData = localStorage.getItem(this.filesStorageKey);
      if (filesData) {
        const filesObj = JSON.parse(filesData);
        delete filesObj[fileHash];
        localStorage.setItem(this.filesStorageKey, JSON.stringify(filesObj));
      }
    } catch (error) {
      console.warn('Failed to remove from localStorage:', error);
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

  private validateStoredFiles(): void {
    const invalidFiles: string[] = [];

    for (const [hash, metadata] of this.fileIndex.entries()) {
      if (!metadata.isValid || metadata.retryCount >= this.maxRetries) {
        invalidFiles.push(hash);
      }
    }

    // Remove invalid files
    for (const hash of invalidFiles) {
      this.fileIndex.delete(hash);
      console.warn(`Removed invalid file: ${hash}`);
    }

    this.updateStorageQuota();
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
    try {
      const bytes = new Uint8Array(buffer);
      let hash = '';
      for (let i = 0; i < bytes.length; i++) {
        hash += bytes[i].toString(16).padStart(2, '0');
      }
      return hash;
    } catch (error) {
      console.error('Failed to calculate hash:', error);
      return '';
    }
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
      console.warn('Failed to save peers:', error);
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
      console.warn('Failed to load peers:', error);
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
        if (!metadata.replicatedOn.includes(peer.peerId)) {
          metadata.replicatedOn.push(peer.peerId);
          this.fileIndex.set(metadata.hash, metadata);
        }
      } catch (error) {
        console.warn(`Failed to replicate to peer ${peer.peerId}:`, error);
      }
    }
  }

  private async sendFileToPeer(
    peerId: string,
    metadata: FileMetadata,
    fileBuffer: ArrayBuffer
  ): Promise<void> {
    console.log(`Sending file ${metadata.name} to peer ${peerId}`);
  }

  private async fetchFileFromPeer(
    peerId: string,
    fileHash: string
  ): Promise<File | null> {
    console.log(`Fetching file ${fileHash} from peer ${peerId}`);
    return null;
  }

  private async notifyPeersToDeleteFile(fileHash: string): Promise<void> {
    const connectedPeers = this.getConnectedPeers();
    for (const peer of connectedPeers) {
      console.log(`Notifying peer ${peer.peerId} to delete file ${fileHash}`);
    }
  }
}

export const improvedStorageService = new ImprovedStorageService();
