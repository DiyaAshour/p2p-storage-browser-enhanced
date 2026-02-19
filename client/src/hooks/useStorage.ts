import { useState, useCallback } from 'react';
import { storageService, FileMetadata, StorageQuota } from '@/services/storageService';

export function useStorage() {
  const [encryptionKey, setEncryptionKey] = useState<string | null>(null);
  const [files, setFiles] = useState<FileMetadata[]>([]);
  const [quota, setQuota] = useState<StorageQuota>(storageService.getStorageQuota());
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadFile = useCallback(
    async (file: File, indexed: boolean = false, peerId: string = "", encrypt: boolean = false) => {
      setIsLoading(true);
      setError(null);
      try {
                const key = encrypt && encryptionKey ? encryptionKey : undefined;
        const metadata = await storageService.addFile(file, indexed, peerId, key);
        setFiles(storageService.getFileIndex());
        setQuota(storageService.getStorageQuota());
        return metadata;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Failed to upload file';
        setError(errorMessage);
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    []
  );

  const downloadFile = useCallback(async (fileHash: string, decrypt: boolean = false) => {
    setIsLoading(true);
    setError(null);
    try {
              const key = decrypt && encryptionKey ? encryptionKey : undefined;
        const file = await storageService.getFile(fileHash, key);
      if (!file) {
        throw new Error('File not found');
      }
      return file;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to download file';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const deleteFile = useCallback(async (fileHash: string, decrypt: boolean = false) => {
    setIsLoading(true);
    setError(null);
    try {
      await storageService.deleteFile(fileHash);
      setFiles(storageService.getFileIndex());
      setQuota(storageService.getStorageQuota());
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to delete file';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const searchFiles = useCallback(async (query: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const results = await storageService.searchFiles(query);
      return results;
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Failed to search files';
      setError(errorMessage);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setStorageQuota = useCallback((totalGB: number) => {
    storageService.setStorageQuota(totalGB);
    setQuota(storageService.getStorageQuota());
  }, []);

  const refreshFiles = useCallback(() => {
    setFiles(storageService.getFileIndex());
    setQuota(storageService.getStorageQuota());
  }, []);

  return {
    files,
    quota,
    isLoading,
    error,
    uploadFile,
    downloadFile,
    encryptionKey,
    setEncryptionKey,
    deleteFile,
    searchFiles,
    setStorageQuota,
    refreshFiles,
  };
}
