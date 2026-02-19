import { useState, useEffect } from 'react';
import { useWallet } from '@/hooks/useWallet';
import { useStorage } from '@/hooks/useStorage';
import { p2pPersistentService, FileMetadata as P2PFileMetadata, PeerInfo } from '@/services/p2pPersistentService';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Upload, Download, Trash2, Search, Wallet, LogOut } from 'lucide-react';
import { toast } from 'sonner';

export default function HomeFixed() {
  const wallet = useWallet();
  const storage = useStorage();
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isIndexing, setIsIndexing] = useState(false);
  const [files, setFiles] = useState<P2PFileMetadata[]>([]);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    // Initialize P2P storage service
    const init = async () => {
      try {
        await p2pPersistentService.initialize();
        loadFiles();
        loadPeers();
      } catch (error) {
        console.error('Failed to initialize storage:', error);
        toast.error('Failed to initialize storage');
      }
    }
    init();
  }, []);

  const loadFiles = () => {
    try {
      const fileList = p2pPersistentService.getFileIndex();
      setFiles(fileList);
    } catch (error) {
      console.error('Failed to load files:', error);
    }
  };

  const loadPeers = () => {
    try {
      const peerList = p2pPersistentService.getConnectedPeers();
      setPeers(peerList);
    } catch (error) {
      console.error('Failed to load peers:', error);
    }
  };

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

    setIsLoading(true);
    try {
      for (const file of selectedFiles) {
        await p2pPersistentService.addFile(file, isIndexing);
      }
      toast.success(`✅ ${selectedFiles.length} file(s) uploaded successfully`);
      setSelectedFiles([]);
      loadFiles();
    } catch (error) {
      console.error('Upload error:', error);
      toast.error('Failed to upload files: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      loadFiles();
      return;
    }

    try {
      const results = await p2pPersistentService.searchFiles(searchQuery);
      setFiles(results);
      toast.success(`Found ${results.length} file(s)`);
    } catch (error) {
      console.error('Search error:', error);
      toast.error('Search failed');
    }
  };

  const handleDownload = async (fileHash: string, fileName: string) => {
    setIsLoading(true);
    try {
      console.log(`Downloading file: ${fileName} (${fileHash})`);
      const file = await p2pPersistentService.getFile(fileHash);
      
      if (!file) {
        throw new Error('File not found in storage');
      }

      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      
      toast.success(`✅ ${fileName} downloaded successfully`);
    } catch (error) {
      console.error('Download error:', error);
      toast.error('Failed to download file: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (fileHash: string, fileName: string) => {
    setIsLoading(true);
    try {
      await p2pPersistentService.deleteFile(fileHash);
      toast.success(`✅ ${fileName} deleted`);
      loadFiles();
    } catch (error) {
      console.error('Delete error:', error);
      toast.error('Failed to delete file');
    } finally {
      setIsLoading(false);
    }
  };

  const quota = p2pPersistentService.getStorageQuota();
  const connectedPeers = peers;

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 via-slate-800 to-slate-900">
      {/* Header */}
      <header className="border-b border-slate-700 bg-slate-800/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="container mx-auto px-4 py-4 flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-white">P2P Storage Browser</h1>
            <p className="text-sm text-slate-400">Decentralized file storage network</p>
          </div>

          <div className="flex items-center gap-4">
            {wallet.isConnected && (
              <div className="text-right">
                <p className="text-sm text-slate-400">Connected Wallet</p>
                <p className="text-sm font-mono text-white">
                  {wallet.address?.slice(0, 6)}...{wallet.address?.slice(-4)}
                </p>
                <p className="text-xs text-slate-400">{wallet.balance} ETH</p>
              </div>
            )}
            
            {wallet.isConnected ? (
              <Button
                variant="outline"
                size="sm"
                onClick={wallet.disconnect}
                className="gap-2"
              >
                <LogOut className="w-4 h-4" />
                Disconnect
              </Button>
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
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="browser" className="space-y-6">
          <TabsList className="bg-slate-800 border-slate-700">
            <TabsTrigger value="browser">File Browser</TabsTrigger>
            <TabsTrigger value="upload">Upload Files</TabsTrigger>
            <TabsTrigger value="stats">Statistics</TabsTrigger>
            <TabsTrigger value="peers">Network</TabsTrigger>
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

              {files.length === 0 ? (
                <div className="text-center py-12">
                  <p className="text-slate-400">No files uploaded yet</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {files.map((file) => (
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
                          {file.replicatedOn.length} replica(s)
                        </p>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDownload(file.hash, file.name)}
                          disabled={isLoading}
                          className="gap-2"
                        >
                          <Download className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleDelete(file.hash, file.name)}
                          disabled={isLoading}
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

                <Button
                  onClick={handleUpload}
                  disabled={isLoading || selectedFiles.length === 0}
                  className="w-full gap-2"
                  size="lg"
                >
                  <Upload className="w-4 h-4" />
                  {isLoading ? 'Uploading...' : 'Upload Files'}
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
                  {files.length}
                </p>
              </Card>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <p className="text-sm text-slate-400 mb-2">Storage Used</p>
                <p className="text-3xl font-bold text-white">
                  {quota.usedGB.toFixed(2)} GB
                </p>
              </Card>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <p className="text-sm text-slate-400 mb-2">Available Storage</p>
                <p className="text-3xl font-bold text-white">
                  {quota.availableGB.toFixed(2)} GB
                </p>
              </Card>

              <Card className="p-6 bg-slate-800 border-slate-700">
                <p className="text-sm text-slate-400 mb-2">Monthly Cost</p>
                <p className="text-3xl font-bold text-white">
                  ${quota.costPerMonth.toFixed(2)}
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
                    onClick={() => p2pPersistentService.setStorageQuota(tb)}
                  >
                    <span>{tb} TB Storage</span>
                    <span className="text-green-400">${tb * 1}/month</span>
                  </Button>
                ))}
              </div>
            </Card>
          </TabsContent>

          {/* Network Tab */}
          <TabsContent value="peers" className="space-y-4">
            <Card className="p-6 bg-slate-800 border-slate-700">
              <h3 className="text-lg font-bold text-white mb-4">
                Connected Peers
              </h3>
              
              {connectedPeers.length === 0 ? (
                <div className="text-center py-8">
                  <p className="text-slate-400">No peers connected yet</p>
                  <p className="text-sm text-slate-500 mt-2">
                    Start the app on another device to connect
                  </p>
                </div>
              ) : (
                <div className="space-y-3">
                  {connectedPeers.map((peer) => (
                    <div
                      key={peer.peerId}
                      className="p-4 bg-slate-700 rounded-lg border border-slate-600"
                    >
                      <div className="flex justify-between items-start">
                        <div>
                          <p className="text-white font-mono text-sm">
                            {peer.peerId.slice(0, 20)}...
                          </p>
                          <p className="text-xs text-slate-400 mt-1">
                            {peer.address}:{peer.port}
                          </p>
                        </div>
                        <div className="text-right">
                          <p className="text-sm text-green-400">🟢 Connected</p>
                          <p className="text-xs text-slate-400">
                            {peer.filesCount} files
                          </p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
