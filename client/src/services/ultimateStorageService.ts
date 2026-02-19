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

class UltimateStorageService {
  private db: any;
  private fileIndex: Map<string, FileMetadata> = new Map();
  private fileData: Map<string, ArrayBuffer> = new Map();
  private storageQuota: StorageQuota = {
    totalGB: 1,
    usedGB: 0,
    availableGB: 1,
    costPerMonth: 1,
  };
  
  // Storage keys
  private readonly METADATA_KEY = 'p2p-files-metadata-v2';
  private readonly FILES_KEY = 'p2p-files-data-v2';
  private readonly PEER_ID_KEY = 'p2p-peer-id';
  private readonly DB_NAME = 'p2p-storage-ultimate';
  private readonly DB_VERSION = 4;

  async initialize() {
    try {
      console.log('🔄 Initializing Ultimate Storage Service...');
      
      // Initialize IndexedDB
      await this.initializeIndexedDB();
      
      // Load from localStorage first
      await this.loadFromLocalStorage();
      
      // Load from IndexedDB
      await this.loadFromIndexedDB();
      
      // Validate all stored files
      await this.validateAllFiles();
      
      console.log(`✅ Storage initialized with ${this.fileIndex.size} files`);
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize storage:', error);
      throw error;
    }
  }

  private initializeIndexedDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.DB_NAME, this.DB_VERSION);

      request.onerror = () => {
        console.error('❌ IndexedDB error:', request.error);
        reject(request.error);
      };

      request.onsuccess = (event: any) => {
        this.db = event.target.result;
        console.log('✅ IndexedDB initialized');
        resolve();
      };

      request.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        
        // Create object stores
        const stores = ['files', 'metadata', 'cache', 'backup'];
        for (const store of stores) {
          if (!db.objectStoreNames.contains(store)) {
            db.createObjectStore(store, { keyPath: 'hash' });
          }
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

      console.log(`📤 Adding file: ${file.name}`);

      const fileId = uuidv4();
      const fileBuffer = await file.arrayBuffer();
      const fileHash = this.calculateHash(fileBuffer);

      if (!fileHash) {
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

      // Store in memory
      this.fileIndex.set(fileHash, metadata);
      this.fileData.set(fileHash, fileBuffer);

      // Store in localStorage (primary backup)
      await this.saveToLocalStorage();

      // Store in IndexedDB (secondary backup)
      if (this.db) {
        await this.saveToIndexedDB(fileHash, fileBuffer, metadata);
      }

      this.updateStorageQuota();
      console.log(`✅ File saved: ${file.name}`);

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

      // Try to get from memory first
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
      fileBuffer = await this.getFromLocalStorage(fileHash);
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

      // Delete from memory
      this.fileIndex.delete(fileHash);
      this.fileData.delete(fileHash);

      // Delete from IndexedDB
      if (this.db) {
        await this.deleteFromIndexedDB(fileHash);
      }

      // Delete from localStorage
      await this.deleteFromLocalStorage(fileHash);

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

      return results;
    } catch (error) {
      console.error('❌ Failed to search files:', error);
      throw error;
    }
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
  private createFileFromBuffer(buffer: ArrayBuffer, metadata: FileMetadata): File {
    const blob = new Blob([buffer], { type: metadata.mimeType });
    return new File([blob], metadata.name, { type: metadata.mimeType });
  }

  private async saveToLocalStorage(): Promise<void> {
    try {
      const metadataArray = Array.from(this.fileIndex.values());
      localStorage.setItem(this.METADATA_KEY, JSON.stringify(metadataArray));

      // Save file data for small files
      const filesData: Record<string, string> = {};
      for (const [hash, buffer] of this.fileData.entries()) {
        if (buffer.byteLength < 10 * 1024 * 1024) { // 10MB limit
          const uint8Array = new Uint8Array(buffer);
          const binaryString = String.fromCharCode.apply(null, Array.from(uint8Array));
          filesData[hash] = btoa(binaryString);
        }
      }
      
      if (Object.keys(filesData).length > 0) {
        localStorage.setItem(this.FILES_KEY, JSON.stringify(filesData));
      }

      console.log('✅ Data saved to localStorage');
    } catch (error) {
      console.warn('⚠️ Failed to save to localStorage:', error);
    }
  }

  private async loadFromLocalStorage(): Promise<void> {
    try {
      const metadataStr = localStorage.getItem(this.METADATA_KEY);
      if (metadataStr) {
        const metadataArray = JSON.parse(metadataStr);
        for (const metadata of metadataArray) {
          this.fileIndex.set(metadata.hash, metadata);
        }
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
            console.warn(`Failed to decode file ${hash}:`, err);
          }
        }
      }

      console.log(`✅ Loaded ${this.fileIndex.size} files from localStorage`);
    } catch (error) {
      console.warn('⚠️ Failed to load from localStorage:', error);
    }
  }

  private async saveToIndexedDB(
    hash: string,
    buffer: ArrayBuffer,
    metadata: FileMetadata
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        const transaction = this.db.transaction(['files', 'metadata', 'backup'], 'readwrite');
        const filesStore = transaction.objectStore('files');
        const metadataStore = transaction.objectStore('metadata');
        const backupStore = transaction.objectStore('backup');

        filesStore.put({
          hash,
          data: buffer,
          timestamp: Date.now(),
        });

        metadataStore.put({
          hash,
          ...metadata,
        });

        backupStore.put({
          hash,
          data: buffer,
          metadata,
          timestamp: Date.now(),
        });

        transaction.oncomplete = () => {
          console.log(`✅ File saved to IndexedDB: ${hash}`);
          resolve();
        };

        transaction.onerror = () => {
          console.error('❌ IndexedDB transaction error:', transaction.error);
          reject(transaction.error);
        };
      } catch (error) {
        reject(error);
      }
    });
  }

  private async loadFromIndexedDB(): Promise<void> {
    return new Promise((resolve) => {
      try {
        if (!this.db) {
          resolve();
          return;
        }

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
      try {
        if (!this.db) {
          resolve(null);
          return;
        }

        const transaction = this.db.transaction(['files', 'backup'], 'readonly');
        const filesStore = transaction.objectStore('files');
        const backupStore = transaction.objectStore('backup');

        const fileRequest = filesStore.get(hash);
        fileRequest.onsuccess = (event: any) => {
          const file = event.target.result;
          if (file && file.data) {
            resolve(file.data);
            return;
          }

          const backupRequest = backupStore.get(hash);
          backupRequest.onsuccess = (event: any) => {
            const backup = event.target.result;
            resolve(backup ? backup.data : null);
          };
        };

        fileRequest.onerror = () => resolve(null);
      } catch (error) {
        console.warn('⚠️ IndexedDB get error:', error);
        resolve(null);
      }
    });
  }

  private async deleteFromIndexedDB(hash: string): Promise<void> {
    return new Promise((resolve) => {
      try {
        if (!this.db) {
          resolve();
          return;
        }

        const transaction = this.db.transaction(['files', 'metadata', 'backup'], 'readwrite');
        transaction.objectStore('files').delete(hash);
        transaction.objectStore('metadata').delete(hash);
        transaction.objectStore('backup').delete(hash);

        transaction.oncomplete = () => resolve();
        transaction.onerror = () => resolve();
      } catch (error) {
        resolve();
      }
    });
  }

  private async getFromLocalStorage(hash: string): Promise<ArrayBuffer | null> {
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
      console.warn('⚠️ localStorage get error:', error);
      return null;
    }
  }

  private async deleteFromLocalStorage(hash: string): Promise<void> {
    try {
      const filesStr = localStorage.getItem(this.FILES_KEY);
      if (filesStr) {
        const filesData = JSON.parse(filesStr);
        delete filesData[hash];
        localStorage.setItem(this.FILES_KEY, JSON.stringify(filesData));
      }

      const metadataStr = localStorage.getItem(this.METADATA_KEY);
      if (metadataStr) {
        const metadataArray = JSON.parse(metadataStr);
        const filtered = metadataArray.filter((m: any) => m.hash !== hash);
        localStorage.setItem(this.METADATA_KEY, JSON.stringify(filtered));
      }
    } catch (error) {
      console.warn('⚠️ localStorage delete error:', error);
    }
  }

  private async validateAllFiles(): Promise<void> {
    const invalidHashes: string[] = [];

    for (const [hash, metadata] of this.fileIndex.entries()) {
      const hasData = this.fileData.has(hash);
      if (!hasData) {
        console.warn(`⚠️ File data missing for ${metadata.name}, trying to recover...`);
        
        // Try to recover from IndexedDB
        if (this.db) {
          const buffer = await this.getFromIndexedDB(hash);
          if (buffer) {
            this.fileData.set(hash, buffer);
            console.log(`✅ Recovered file from IndexedDB: ${metadata.name}`);
            continue;
          }
        }

        // Try to recover from localStorage
        const buffer = await this.getFromLocalStorage(hash);
        if (buffer) {
          this.fileData.set(hash, buffer);
          console.log(`✅ Recovered file from localStorage: ${metadata.name}`);
          continue;
        }

        invalidHashes.push(hash);
      }
    }

    // Remove invalid files
    for (const hash of invalidHashes) {
      const metadata = this.fileIndex.get(hash);
      console.warn(`🗑️ Removing invalid file: ${metadata?.name}`);
      this.fileIndex.delete(hash);
    }
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
}

export const ultimateStorageService = new UltimateStorageService();
