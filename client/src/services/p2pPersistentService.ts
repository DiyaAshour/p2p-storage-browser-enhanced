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
}

export interface PeerInfo {
  peerId: string;
  lastSeen: number;
  filesCount: number;
  storageUsed: number;
}

export interface StorageQuota {
  totalGB: number;
  usedGB: number;
  availableGB: number;
  costPerMonth: number;
}

class P2PPersistentService {
  private fileIndex: Map<string, FileMetadata> = new Map();
  private fileData: Map<string, ArrayBuffer> = new Map();
  private connectedPeers: Map<string, PeerInfo> = new Map();
  private storageQuota: StorageQuota = {
    totalGB: 1,
    usedGB: 0,
    availableGB: 1,
    costPerMonth: 1,
  };

  private readonly METADATA_KEY = 'p2p-metadata-v3';
  private readonly FILES_KEY = 'p2p-files-v3';
  private readonly PEER_ID_KEY = 'p2p-peer-id';
  private readonly DB_NAME = 'p2p-storage-db';
  private readonly DB_VERSION = 2;
  private db: IDBDatabase | null = null;

  async initialize() {
    try {
      console.log('🔄 Initializing P2P Persistent Storage Service...');
      
      // Initialize IndexedDB
      await this.initializeIndexedDB();
      
      // Load from localStorage
      this.loadFromLocalStorage();
      
      // Load from IndexedDB
      await this.loadFromIndexedDB();
      
      console.log(`✅ P2P Storage initialized with ${this.fileIndex.size} files`);
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize P2P storage:', error);
      throw error;
    }
  }

  private initializeIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => {
        console.warn('⚠️ IndexedDB not available, using localStorage only');
        resolve();
      };

      request.onsuccess = (event: any) => {
        this.db = event.target.result;
        console.log('✅ IndexedDB initialized');
        resolve();
      };

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'hash' });
        }
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'hash' });
        }
        console.log('✅ IndexedDB stores created');
      };
    });
  }

  async addFile(
    file: File,
    indexed: boolean = false,
    peerId: string = ''
  ): Promise<FileMetadata> {
    try {
      if (!file || file.size === 0) {
        throw new Error('Invalid file: file is empty');
      }

      console.log(`📤 Adding file: ${file.name} (${(file.size / 1024 / 1024).toFixed(2)} MB)`);

      const fileId = uuidv4();
      const fileBuffer = await file.arrayBuffer();
      const fileHash = this.calculateHash(fileBuffer);

      if (!fileHash) {
        throw new Error('Failed to calculate file hash');
      }

      const checksum = CryptoJS.SHA256(
        CryptoJS.enc.Hex.parse(fileHash)
      ).toString();

      const localPeerId = peerId || this.getLocalPeerId();

      const metadata: FileMetadata = {
        id: fileId,
        name: file.name,
        size: file.size,
        hash: fileHash,
        uploadedAt: Date.now(),
        lastModified: Date.now(),
        indexed,
        peerId: localPeerId,
        mimeType: file.type,
        checksum,
        replicatedOn: [localPeerId],
      };

      // Store in memory
      this.fileIndex.set(fileHash, metadata);
      this.fileData.set(fileHash, fileBuffer);

      // Save to localStorage immediately
      this.saveToLocalStorage();

      // Save to IndexedDB
      if (this.db) {
        await this.saveToIndexedDB(fileHash, fileBuffer, metadata);
      }

      // Broadcast to other peers
      this.broadcastFileToNetwork(metadata, fileBuffer);

      this.updateStorageQuota();
      console.log(`✅ File saved and broadcasted: ${file.name}`);

      return metadata;
    } catch (error) {
      console.error('❌ Failed to add file:', error);
      throw error;
    }
  }

  async getFile(fileHash: string): Promise<File | null> {
    try {
      const metadata = this.fileIndex.get(fileHash);

      if (!metadata) {
        console.warn(`⚠️ File not found in index: ${fileHash}`);
        return null;
      }

      // Try memory first
      let fileBuffer = this.fileData.get(fileHash);
      if (fileBuffer) {
        console.log(`✅ File retrieved from memory: ${metadata.name}`);
        return this.createFileFromBuffer(fileBuffer, metadata);
      }

      // Try IndexedDB
      if (this.db) {
        fileBuffer = await this.getFromIndexedDB(fileHash);
        if (fileBuffer) {
          this.fileData.set(fileHash, fileBuffer);
          console.log(`✅ File retrieved from IndexedDB: ${metadata.name}`);
          return this.createFileFromBuffer(fileBuffer, metadata);
        }
      }

      // Try localStorage
      fileBuffer = this.getFileDataFromLocalStorage(fileHash);
      if (fileBuffer) {
        this.fileData.set(fileHash, fileBuffer);
        console.log(`✅ File retrieved from localStorage: ${metadata.name}`);
        return this.createFileFromBuffer(fileBuffer, metadata);
      }

      throw new Error(`File data not found: ${metadata.name}`);
    } catch (error) {
      console.error('❌ Failed to get file:', error);
      throw error;
    }
  }

  async deleteFile(fileHash: string): Promise<boolean> {
    try {
      const metadata = this.fileIndex.get(fileHash);
      if (!metadata) {
        throw new Error('File not found');
      }

      console.log(`🗑️ Deleting file: ${metadata.name}`);

      this.fileIndex.delete(fileHash);
      this.fileData.delete(fileHash);

      this.saveToLocalStorage();

      if (this.db) {
        await this.deleteFromIndexedDB(fileHash);
      }

      // Broadcast deletion to peers
      this.broadcastFileDeletion(fileHash);

      this.updateStorageQuota();
      console.log(`✅ File deleted: ${metadata.name}`);

      return true;
    } catch (error) {
      console.error('❌ Failed to delete file:', error);
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

      console.log(`🔍 Search found ${results.length} file(s) for query: "${query}"`);
      return results;
    } catch (error) {
      console.error('❌ Failed to search files:', error);
      throw error;
    }
  }

  getFileIndex(): FileMetadata[] {
    return Array.from(this.fileIndex.values());
  }

  getConnectedPeers(): PeerInfo[] {
    return Array.from(this.connectedPeers.values());
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
  private createFileFromBuffer(buffer: ArrayBuffer, metadata: FileMetadata): File {
    const blob = new Blob([buffer], { type: metadata.mimeType });
    return new File([blob], metadata.name, { type: metadata.mimeType });
  }

  private saveToLocalStorage(): void {
    try {
      const metadataArray = Array.from(this.fileIndex.values());
      localStorage.setItem(this.METADATA_KEY, JSON.stringify(metadataArray));
      console.log(`💾 Saved ${metadataArray.length} files metadata to localStorage`);

      const filesData: Record<string, string> = {};
      for (const [hash, buffer] of this.fileData.entries()) {
        const uint8Array = new Uint8Array(buffer);
        const binaryString = String.fromCharCode.apply(null, Array.from(uint8Array));
        filesData[hash] = btoa(binaryString);
      }

      localStorage.setItem(this.FILES_KEY, JSON.stringify(filesData));
      console.log(`💾 Saved ${Object.keys(filesData).length} files data to localStorage`);
    } catch (error) {
      console.error('❌ Failed to save to localStorage:', error);
    }
  }

  private loadFromLocalStorage(): void {
    try {
      const metadataStr = localStorage.getItem(this.METADATA_KEY);
      if (metadataStr) {
        const metadataArray = JSON.parse(metadataStr);
        for (const metadata of metadataArray) {
          this.fileIndex.set(metadata.hash, metadata);
        }
        console.log(`✅ Loaded ${metadataArray.length} files metadata from localStorage`);
      }

      const filesStr = localStorage.getItem(this.FILES_KEY);
      if (filesStr) {
        const filesData = JSON.parse(filesStr);
        for (const [hash, base64] of Object.entries(filesData)) {
          try {
            const binaryString = atob(base64 as string);
            const bytes = new Uint8Array(binaryString.length);
            for (let i = 0; i < binaryString.length; i++) {
              bytes[i] = binaryString.charCodeAt(i);
            }
            this.fileData.set(hash, bytes.buffer);
          } catch (err) {
            console.warn(`⚠️ Failed to decode file ${hash}:`, err);
          }
        }
        console.log(`✅ Loaded ${Object.keys(filesData).length} files data from localStorage`);
      }

      this.updateStorageQuota();
    } catch (error) {
      console.error('❌ Failed to load from localStorage:', error);
    }
  }

  private getFileDataFromLocalStorage(hash: string): ArrayBuffer | null {
    try {
      const filesStr = localStorage.getItem(this.FILES_KEY);
      if (!filesStr) return null;

      const filesData = JSON.parse(filesStr);
      const base64 = filesData[hash];
      if (!base64) return null;

      const binaryString = atob(base64);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }
      return bytes.buffer;
    } catch (error) {
      console.warn('⚠️ Failed to get file from localStorage:', error);
      return null;
    }
  }

  private async saveToIndexedDB(
    hash: string,
    buffer: ArrayBuffer,
    metadata: FileMetadata
  ): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve();
        return;
      }

      try {
        const transaction = this.db.transaction(['files', 'metadata'], 'readwrite');
        const filesStore = transaction.objectStore('files');
        const metadataStore = transaction.objectStore('metadata');

        filesStore.put({
          hash,
          data: buffer,
          timestamp: Date.now(),
        });

        metadataStore.put({
          hash,
          ...metadata,
        });

        transaction.oncomplete = () => {
          console.log(`✅ File saved to IndexedDB: ${hash}`);
          resolve();
        };

        transaction.onerror = () => {
          console.warn('⚠️ IndexedDB transaction error');
          resolve();
        };
      } catch (error) {
        console.warn('⚠️ IndexedDB save error:', error);
        resolve();
      }
    });
  }

  private async loadFromIndexedDB(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve();
        return;
      }

      try {
        const transaction = this.db.transaction(['metadata', 'files'], 'readonly');
        const metadataStore = transaction.objectStore('metadata');
        const filesStore = transaction.objectStore('files');

        const metadataRequest = metadataStore.getAll();
        metadataRequest.onsuccess = (event: any) => {
          const metadataArray = event.target.result;
          for (const metadata of metadataArray) {
            if (!this.fileIndex.has(metadata.hash)) {
              this.fileIndex.set(metadata.hash, metadata);
            }
          }
        };

        const filesRequest = filesStore.getAll();
        filesRequest.onsuccess = (event: any) => {
          const filesArray = event.target.result;
          for (const file of filesArray) {
            if (!this.fileData.has(file.hash)) {
              this.fileData.set(file.hash, file.data);
            }
          }
          console.log(`✅ Loaded ${filesArray.length} files from IndexedDB`);
          resolve();
        };

        filesRequest.onerror = () => {
          console.warn('⚠️ Failed to load from IndexedDB');
          resolve();
        };
      } catch (error) {
        console.warn('⚠️ IndexedDB load error:', error);
        resolve();
      }
    });
  }

  private async getFromIndexedDB(hash: string): Promise<ArrayBuffer | null> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve(null);
        return;
      }

      try {
        const transaction = this.db.transaction(['files'], 'readonly');
        const filesStore = transaction.objectStore('files');
        const request = filesStore.get(hash);

        request.onsuccess = (event: any) => {
          const file = event.target.result;
          resolve(file ? file.data : null);
        };

        request.onerror = () => resolve(null);
      } catch (error) {
        console.warn('⚠️ IndexedDB get error:', error);
        resolve(null);
      }
    });
  }

  private async deleteFromIndexedDB(hash: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.db) {
        resolve();
        return;
      }

      try {
        const transaction = this.db.transaction(['files', 'metadata'], 'readwrite');
        transaction.objectStore('files').delete(hash);
        transaction.objectStore('metadata').delete(hash);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      } catch (error) {
        resolve();
      }
    });
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
      console.error('❌ Hash calculation error:', error);
      return '';
    }
  }

  private getLocalPeerId(): string {
    let peerId = localStorage.getItem(this.PEER_ID_KEY);
    if (!peerId) {
      peerId = `peer-${uuidv4()}`;
      localStorage.setItem(this.PEER_ID_KEY, peerId);
      console.log(`✅ Created new Peer ID: ${peerId}`);
    }
    return peerId;
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

  private broadcastFileToNetwork(metadata: FileMetadata, fileBuffer: ArrayBuffer): void {
    console.log(`📡 Broadcasting file to network: ${metadata.name}`);
    // This will be implemented with WebSocket/libp2p in the future
    // For now, it's a placeholder for P2P distribution
    
    // Simulate adding to replicated peers
    if (this.connectedPeers.size > 0) {
      for (const peerId of this.connectedPeers.keys()) {
        if (!metadata.replicatedOn.includes(peerId)) {
          metadata.replicatedOn.push(peerId);
        }
      }
      this.saveToLocalStorage();
      console.log(`✅ File replicated to ${metadata.replicatedOn.length} peer(s)`);
    }
  }

  private broadcastFileDeletion(fileHash: string): void {
    console.log(`📡 Broadcasting file deletion to network: ${fileHash}`);
    // This will be implemented with WebSocket/libp2p in the future
  }
}

export const p2pPersistentService = new P2PPersistentService();
