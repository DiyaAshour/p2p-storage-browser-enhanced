import { v4 as uuidv4 } from 'uuid';
import CryptoJS from 'crypto-js';

export interface FileMetadata {
  isEncrypted?: boolean;
  encryptionKeyId?: string;
  id: string;
  name: string;
  size: number;
  hash: string;
  uploadedAt: number;
  indexed: boolean;
  peerId: string;
  mimeType: string;
  checksum: string;
}

export interface StorageQuota {
  totalGB: number;
  usedGB: number;
  availableGB: number;
  costPerMonth: number;
}

class StorageService {
  private db: any;
  private fileIndex: Map<string, FileMetadata> = new Map();
  private storageQuota: StorageQuota = {
    totalGB: 0,
    usedGB: 0,
    availableGB: 0,
    costPerMonth: 0,
  };

  async initialize(dbPath: string) {
    try {
      // Initialize IndexedDB for browser storage
      const dbRequest = indexedDB.open('p2p-storage', 1);

      dbRequest.onerror = () => {
        console.error('Failed to open IndexedDB');
      };

      dbRequest.onsuccess = (event: any) => {
        this.db = event.target.result;
        this.loadFileIndex();
      };

      dbRequest.onupgradeneeded = (event: any) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('metadata')) {
          db.createObjectStore('metadata', { keyPath: 'hash' });
        }
      };
    } catch (error) {
      console.error('Failed to initialize storage:', error);
      throw error;
    }
  }

  async addFile(
    file: File,
    indexed: boolean = false,
    peerId: string = '',
    encryptionKey?: string
  ): Promise<FileMetadata> {
    try {
      const fileId = uuidv4();
      let fileBuffer = await file.arrayBuffer();
      let isEncrypted = false;
      let encryptionKeyId: string | undefined;

      if (encryptionKey) {
        const wordArray = CryptoJS.lib.WordArray.create(fileBuffer as any);
        const encrypted = CryptoJS.AES.encrypt(wordArray, encryptionKey).toString();
        fileBuffer = new TextEncoder().encode(encrypted).buffer;
        isEncrypted = true;
        encryptionKeyId = CryptoJS.SHA256(encryptionKey).toString(); // Simple key ID
      }
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
        indexed,
        peerId,
        mimeType: file.type,
        checksum,
        isEncrypted,
        encryptionKeyId,
      };

      // Store in IndexedDB
      if (this.db) {
        const transaction = this.db.transaction(['files', 'metadata'], 'readwrite');
        const fileStore = transaction.objectStore('files');
        const metadataStore = transaction.objectStore('metadata');

        fileStore.add({
          id: fileId,
          data: fileBuffer,
          metadata,
        });

        metadataStore.add(metadata);
      }

      // Update file index
      this.fileIndex.set(fileHash, metadata);

      // Update storage quota
      this.updateStorageQuota();

      return metadata;
    } catch (error) {
      console.error('Failed to add file:', error);
      throw error;
    }
  }

  async getFile(fileHash: string, encryptionKey?: string): Promise<File | null> {
    try {
      if (!this.db) return null;

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['files'], 'readonly');
        const store = transaction.objectStore('files');
        const request = store.getAll();

        request.onsuccess = (event: any) => {
          const files = event.target.result;
            const fileData = files.find(
              (f: any) => f.metadata.hash === fileHash
            );

            if (fileData && fileData.metadata.isEncrypted && encryptionKey) {
              try {
                const decrypted = CryptoJS.AES.decrypt(new TextDecoder().decode(fileData.data), encryptionKey);
                const wordArray = decrypted.words;
                const byteArray = new Uint8Array(wordArray.length * 4);
                for (let i = 0; i < wordArray.length; i++) {
                  byteArray[i * 4] = (wordArray[i] >> 24) & 0xFF;
                  byteArray[i * 4 + 1] = (wordArray[i] >> 16) & 0xFF;
                  byteArray[i * 4 + 2] = (wordArray[i] >> 8) & 0xFF;
                  byteArray[i * 4 + 3] = wordArray[i] & 0xFF;
                }
                fileData.data = byteArray.buffer;
              } catch (e) {
                console.error('Decryption failed:', e);
                reject(new Error('Decryption failed'));
                return;
              }
            }

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
    } catch (error) {
      console.error('Failed to get file:', error);
      throw error;
    }
  }

  async deleteFile(fileHash: string): Promise<boolean> {
    try {
      if (!this.db) return false;

      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction(['files', 'metadata'], 'readwrite');
        const fileStore = transaction.objectStore('files');
        const metadataStore = transaction.objectStore('metadata');

        // Delete from metadata
        metadataStore.delete(fileHash);

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

  private updateStorageQuota(): void {
    let usedBytes = 0;
    for (const metadata of this.fileIndex.values()) {
      usedBytes += metadata.size;
    }

    this.storageQuota.usedGB = usedBytes / (1024 * 1024 * 1024);
    this.storageQuota.availableGB =
      this.storageQuota.totalGB - this.storageQuota.usedGB;
  }

  private calculateHash(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let hash = '';
    for (let i = 0; i < bytes.length; i++) {
      hash += bytes[i].toString(16).padStart(2, '0');
    }
    return hash;
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
}

export const storageService = new StorageService();
