import { useState, useEffect } from 'react';
import { useAuth } from '@repo/hooks/useAuth';
import { useWallet } from '@/hooks/useWallet';
import { useStorage } from '@/hooks/useStorage';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Trash2, Search, Wallet, LogOut } from 'lucide-react';
import { toast } from 'sonner';

export default function Home() {
  // The userAuth hooks provides authentication state
  // To implement login/logout functionality, simply call logout() or redirect to getLoginUrl()
  let { user, loading, error, isAuthenticated, logout } = useAuth();

  const wallet = useWallet();
  const storage = useStorage();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [isEncrypting, setIsEncrypting] = useState(false);
  const [tempEncryptionKey, setTempEncryptionKey] = useState('');

  useEffect(() => {
    // Initialize storage
    storage.refreshFiles();
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      setSelectedFiles(Array.from(e.target.files));
    }
  };

  const handleUpload = async () => {
    if (selectedFiles.length === 0) {
      toast.error('Please select files to upload');
      return;
    }

    if (!wallet.isConnected) {
      toast.error('Please connect your wallet first');
      return;
    }

    if (isEncrypting && !tempEncryptionKey) {
      toast.error('Please enter an encryption key');
      return;
    }

    try {
      for (const file of selectedFiles) {
        if (isEncrypting) {
          storage.setEncryptionKey(tempEncryptionKey);
          await storage.uploadFile(file, isIndexing, '', true);
        } else {
          await storage.uploadFile(file, isIndexing, '', false);
        }
      }
      toast.success(`${selectedFiles.length} file(s) uploaded successfully`);
      setSelectedFiles([]);
      setTempEncryptionKey('');
      setIsEncrypting(false);
    } catch (error) {
      toast.error('Failed to upload files');
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      storage.refreshFiles();
      return;
    }

    try {
      const results = await storage.searchFiles(searchQuery);
      toast.success(`Found ${results.length} file(s)`);
    } catch (error) {
      toast.error('Search failed');
    }
  };

  const handleDownload = async (fileHash: string, fileName: string, isEncrypted: boolean) => {
    try {
      const file = await storage.downloadFile(fileHash, isEncrypted);
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      a.click();
      URL.revokeObjectURL(url);
      toast.success('File downloaded');
    } catch (error) {
      toast.error('Failed to download file');
    }
  };

  const handleDelete = async (fileHash: string) => {
    try {
      await storage.deleteFile(fileHash);
      toast.success('File deleted');
    } catch (error) {
      toast.error('Failed to delete file');
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-700 bg-slate-800/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-white">P2P Storage Browser</h1>
            <p className="text-sm text-slate-400">Decentralized file storage network with E2E encryption</p>
          </div>

          {wallet.isConnected ? (
            <div className="flex items-center gap-4">
              <div className="text-right">
                <p className="text-sm text-slate-400">Connected Wallet</p>
                <p className="text-sm font-mono text-white">
                  {wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}
                </p>
                <p className="text-xs text-slate-400">{wallet.balance} ETH</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={wallet.disconnect}
                className="gap-2"
              >
                <LogOut className="w-4 h-4" />
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              onClick={wallet.connect}
              disabled={wallet.isLoading}
              className="gap-2"
            >
              <Wallet className="w-4 h-4" />
              {wallet.isLoading ? 'Connecting...' : 'Connect Wallet'}
            </Button>
          )}
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        {!wallet.isConnected ? (
          <Card className="p-12 text-center bg-slate-800 border-slate-700">
            <Wallet className="w-16 h-16 mx-auto mb-4 text-slate-400" />
            <h2 className="text-2xl font-bold text-white mb-2">Connect Your Wallet</h2>
            <p className="text-slate-400 mb-6">
              To use P2P Storage, please connect your MetaMask wallet first
            </p>
            <Button onClick={wallet.connect} disabled={wallet.isLoading} size="lg">
              {wallet.isLoading ? 'Connecting...' : 'Connect MetaMask'}
            </Button>
          </Card>
        ) : (
          <Tabs defaultValue="browser" className="space-y-6">
            <TabsList className="bg-slate-800 border-slate-700">
              <TabsTrigger value="browser">File Browser</TabsTrigger>
              <TabsTrigger value="upload">Upload Files</TabsTrigger>
              <TabsTrigger value="stats">Statistics</TabsTrigger>
            </TabsList>

            {/* File Browser Tab */}
            <TabsContent value="browser" className="space-y-4">
              <Card className="p-6 bg-slate-800 border-slate-700">
                <div className="flex gap-2 mb-6">
                  <Input
                    placeholder="Search files by name or hash..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-slate-700 border-slate-600 text-white"
                  />
                  <Button onClick={handleSearch} className="gap-2">
                    <Search className="w-4 h-4" />
                    Search
                  </Button>
                </div>

                {storage.files.length === 0 ? (
                  <div className="text-center py-12">
                    <p className="text-slate-400">No files uploaded yet</p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {storage.files.map((file) => (
                      <div
                        key={file.hash}
                        className="flex items-center justify-between p-4 bg-slate-700 rounded-lg hover:bg-slate-600 transition"
                      >
                        <div className="flex-1">
                          <p className="text-white font-medium">{file.name}</p>
                          <p className="text-xs text-slate-400">
                            {(file.size / 1024 / 1024).toFixed(2)} MB •{' '}
                            {new Date(file.uploadedAt).toLocaleDateString()} •{' '}
                            {file.indexed ? '📑 Indexed' : '🔒 Private'} •{' '}
                            {file.isEncrypted ? '🔑 Encrypted' : '🔓 Unencrypted'}
                          </p>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDownload(file.hash, file.name, file.isEncrypted || false)}
                            className="gap-2"
                          >
                            <Download className="w-4 h-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDelete(file.hash)}
                            className="gap-2 text-red-400 hover:text-red-300"
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            </TabsContent>

            {/* Upload Tab */}
            <TabsContent value="upload" className="space-y-4">
              <Card className="p-6 bg-slate-800 border-slate-700">
                <div className="space-y-4">
                  <div>
                    <label className="block text-sm font-medium text-white mb-2">
                      Select Files to Upload
                    </label>
                    <input
                      type="file"
                      multiple
                      onChange={handleFileSelect}
                      className="block w-full text-sm text-slate-400
                        file:mr-4 file:py-2 file:px-4
                        file:rounded-md file:border-0
                        file:text-sm file:font-semibold
                        file:bg-blue-600 file:text-white
                        hover:file:bg-blue-700"
                    />
                  </div>

                  {selectedFiles.length > 0 && (
                    <div className="bg-slate-700 rounded-lg p-4">
                      <p className="text-sm font-medium text-white mb-2">
                        Selected Files ({selectedFiles.length})
                      </p>
                      <div className="space-y-1">
                        {selectedFiles.map((file, idx) => (
                          <p key={idx} className="text-xs text-slate-400">
                            {file.name} ({(file.size / 1024 / 1024).toFixed(2)} MB)
                          </p>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-2 p-3 bg-slate-700 rounded-lg">
                    <input
                      type="checkbox"
                      id="indexing"
                      checked={isIndexing}
                      onChange={(e) => setIsIndexing(e.target.checked)}
                      className="w-4 h-4"
                    />
                    <label htmlFor="indexing" className="text-sm text-white">
                      Index files for network search (make files discoverable)
                    </label>
                  </div>

                  <div className="flex items-center gap-2 p-3 bg-slate-700 rounded-lg">
                    <input
                      type="checkbox"
                      id="encrypting"
                      checked={isEncrypting}
                      onChange={(e) => setIsEncrypting(e.target.checked)}
                      className="w-4 h-4"
                    />
                    <label htmlFor="encrypting" className="text-sm text-white">
                      🔐 Encrypt files before upload (End-to-End Encryption)
                    </label>
                  </div>

                  {isEncrypting && (
                    <div className="space-y-2 p-3 bg-blue-900/30 border border-blue-700 rounded-lg">
                      <label htmlFor="encryptionKey" className="block text-sm font-medium text-white">
                        Encryption Key (AES-256)
                      </label>
                      <Input
                        id="encryptionKey"
                        type="password"
                        value={tempEncryptionKey}
                        onChange={(e) => setTempEncryptionKey(e.target.value)}
                        placeholder="Enter a strong encryption key (e.g., MyP@ssw0rd123!)"
                        className="bg-slate-700 border-slate-600 text-white"
                      />
                      <p className="text-xs text-slate-300">
                        ⚠️ Keep this key safe! You'll need it to decrypt your files. Store it securely.
                      </p>
                    </div>
                  )}

                  <Button
                    onClick={handleUpload}
                    disabled={storage.isLoading || selectedFiles.length === 0 || (isEncrypting && !tempEncryptionKey)}
                    className="w-full gap-2"
                    size="lg"
                  >
                    <Upload className="w-4 h-4" />
                    {storage.isLoading ? 'Uploading...' : 'Upload Files'}
                  </Button>
                </div>
              </Card>
            </TabsContent>

            {/* Statistics Tab */}
            <TabsContent value="stats" className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card className="p-6 bg-slate-800 border-slate-700">
                  <p className="text-sm text-slate-400 mb-2">Total Files</p>
                  <p className="text-3xl font-bold text-white">
                    {storage.files.length}
                  </p>
                </Card>

                <Card className="p-6 bg-slate-800 border-slate-700">
                  <p className="text-sm text-slate-400 mb-2">Storage Used</p>
                  <p className="text-3xl font-bold text-white">
                    {storage.quota.usedGB.toFixed(2)} GB
                  </p>
                </Card>

                <Card className="p-6 bg-slate-800 border-slate-700">
                  <p className="text-sm text-slate-400 mb-2">Available Storage</p>
                  <p className="text-3xl font-bold text-white">
                    {storage.quota.availableGB.toFixed(2)} GB
                  </p>
                </Card>

                <Card className="p-6 bg-slate-800 border-slate-700">
                  <p className="text-sm text-slate-400 mb-2">Monthly Cost</p>
                  <p className="text-3xl font-bold text-white">
                    ${storage.quota.costPerMonth.toFixed(2)}
                  </p>
                </Card>

                <Card className="p-6 bg-slate-800 border-slate-700">
                  <p className="text-sm text-slate-400 mb-2">Encrypted Files</p>
                  <p className="text-3xl font-bold text-green-400">
                    {storage.files.filter(f => f.isEncrypted).length}
                  </p>
                </Card>

                <Card className="p-6 bg-slate-800 border-slate-700">
                  <p className="text-sm text-slate-400 mb-2">Indexed Files</p>
                  <p className="text-3xl font-bold text-blue-400">
                    {storage.files.filter(f => f.indexed).length}
                  </p>
                </Card>
              </div>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <h3 className="text-lg font-bold text-white mb-4">
                  Upgrade Storage
                </h3>
                <div className="space-y-3">
                  {[1, 3, 5, 10].map((tb) => (
                    <Button
                      key={tb}
                      variant="outline"
                      className="w-full justify-between"
                      onClick={() => storage.setStorageQuota(tb)}
                    >
                      <span>{tb} TB Storage</span>
                      <span className="text-green-400">${tb * 1}/month</span>
                    </Button>
                  ))}
                </div>
              </Card>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <h3 className="text-lg font-bold text-white mb-4">
                  🔐 Set Global Decryption Key
                </h3>
                <div className="space-y-2">
                  <Input
                    type="password"
                    value={storage.encryptionKey || ''}
                    onChange={(e) => storage.setEncryptionKey(e.target.value)}
                    placeholder="Enter your encryption key for decrypting files"
                    className="bg-slate-700 border-slate-600 text-white"
                  />
                  <p className="text-xs text-slate-400">
                    This key will be used to decrypt encrypted files during download. Make sure it matches the key used during upload.
                  </p>
                </div>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}
