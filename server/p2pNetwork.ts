import { EventEmitter } from 'events';

/**
 * P2P Network Service
 * Manages peer-to-peer connections and file distribution across the network
 * Each peer (computer) connects to others and shares files
 */

export interface PeerNode {
  peerId: string;
  address: string;
  port: number;
  lastSeen: Date;
  filesCount: number;
  storageUsed: number;
  isOnline: boolean;
}

export interface FileMetadata {
  hash: string;
  name: string;
  size: number;
  uploadedBy: string;
  uploadedAt: Date;
  indexed: boolean;
  replicatedOn: string[]; // List of peer IDs that have this file
}

export interface P2PMessage {
  type: 'file-upload' | 'file-delete' | 'peer-discovery' | 'heartbeat' | 'file-request';
  payload: any;
  senderId: string;
  timestamp: Date;
}

class P2PNetworkService extends EventEmitter {
  private peers: Map<string, PeerNode> = new Map();
  private fileMetadata: Map<string, FileMetadata> = new Map();
  private peerId: string;
  private port: number;
  private address: string;

  constructor(peerId: string, port: number = 5000, address: string = 'localhost') {
    super();
    this.peerId = peerId;
    this.port = port;
    this.address = address;
    this.initializeNetwork();
  }

  private initializeNetwork() {
    console.log(`🌐 P2P Network initialized`);
    console.log(`   Peer ID: ${this.peerId}`);
    console.log(`   Address: ${this.address}:${this.port}`);

    // Start heartbeat to keep peers alive
    this.startHeartbeat();
  }

  /**
   * Register a new peer on the network
   */
  registerPeer(peerId: string, address: string, port: number): void {
    if (peerId === this.peerId) return; // Don't register self

    const peer: PeerNode = {
      peerId,
      address,
      port,
      lastSeen: new Date(),
      filesCount: 0,
      storageUsed: 0,
      isOnline: true,
    };

    this.peers.set(peerId, peer);
    console.log(`✅ Peer registered: ${peerId} (${address}:${port})`);
    this.emit('peer-joined', peer);
  }

  /**
   * Broadcast a file to all connected peers
   */
  broadcastFile(fileMetadata: FileMetadata): void {
    console.log(`📡 Broadcasting file: ${fileMetadata.name}`);
    console.log(`   Hash: ${fileMetadata.hash}`);
    console.log(`   Replicated on: ${fileMetadata.replicatedOn.length} peer(s)`);

    const message: P2PMessage = {
      type: 'file-upload',
      payload: fileMetadata,
      senderId: this.peerId,
      timestamp: new Date(),
    };

    // Send to all connected peers
    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.isOnline) {
        this.sendMessageToPeer(peerId, message);
      }
    }

    // Add this peer to replication list
    if (!fileMetadata.replicatedOn.includes(this.peerId)) {
      fileMetadata.replicatedOn.push(this.peerId);
    }

    this.fileMetadata.set(fileMetadata.hash, fileMetadata);
  }

  /**
   * Broadcast file deletion to all peers
   */
  broadcastFileDeletion(fileHash: string): void {
    const metadata = this.fileMetadata.get(fileHash);
    if (!metadata) return;

    console.log(`🗑️ Broadcasting file deletion: ${metadata.name}`);

    const message: P2PMessage = {
      type: 'file-delete',
      payload: { hash: fileHash },
      senderId: this.peerId,
      timestamp: new Date(),
    };

    for (const [peerId, peer] of this.peers.entries()) {
      if (peer.isOnline) {
        this.sendMessageToPeer(peerId, message);
      }
    }

    this.fileMetadata.delete(fileHash);
  }

  /**
   * Request a file from a specific peer
   */
  async requestFileFromPeer(fileHash: string, fromPeerId: string): Promise<ArrayBuffer | null> {
    const peer = this.peers.get(fromPeerId);
    if (!peer || !peer.isOnline) {
      console.warn(`⚠️ Peer ${fromPeerId} is not available`);
      return null;
    }

    console.log(`📥 Requesting file ${fileHash} from peer ${fromPeerId}`);

    const message: P2PMessage = {
      type: 'file-request',
      payload: { hash: fileHash },
      senderId: this.peerId,
      timestamp: new Date(),
    };

    return this.sendMessageToPeer(fromPeerId, message);
  }

  /**
   * Send a message to a specific peer
   */
  private sendMessageToPeer(peerId: string, message: P2PMessage): any {
    const peer = this.peers.get(peerId);
    if (!peer) {
      console.warn(`⚠️ Peer ${peerId} not found`);
      return null;
    }

    try {
      // In a real implementation, this would use WebSocket or HTTP
      // For now, we'll emit an event that can be handled by the application
      this.emit('message-to-peer', { peerId, message });
      console.log(`📤 Message sent to ${peerId}: ${message.type}`);
      return true;
    } catch (error) {
      console.error(`❌ Failed to send message to ${peerId}:`, error);
      peer.isOnline = false;
      return null;
    }
  }

  /**
   * Get all connected peers
   */
  getConnectedPeers(): PeerNode[] {
    return Array.from(this.peers.values()).filter(p => p.isOnline);
  }

  /**
   * Get all files in the network
   */
  getNetworkFiles(): FileMetadata[] {
    return Array.from(this.fileMetadata.values());
  }

  /**
   * Get files from a specific peer
   */
  getPeerFiles(peerId: string): FileMetadata[] {
    return Array.from(this.fileMetadata.values()).filter(f =>
      f.replicatedOn.includes(peerId)
    );
  }

  /**
   * Search for files across the network
   */
  searchFiles(query: string): FileMetadata[] {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.fileMetadata.values()).filter(f =>
      f.name.toLowerCase().includes(lowerQuery) || f.hash.includes(query)
    );
  }

  /**
   * Update peer statistics
   */
  updatePeerStats(peerId: string, filesCount: number, storageUsed: number): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      peer.filesCount = filesCount;
      peer.storageUsed = storageUsed;
      peer.lastSeen = new Date();
      console.log(`📊 Updated stats for ${peerId}: ${filesCount} files, ${(storageUsed / 1024 / 1024 / 1024).toFixed(2)} GB`);
    }
  }

  /**
   * Start heartbeat to detect offline peers
   */
  private startHeartbeat(): void {
    setInterval(() => {
      const now = new Date();
      for (const [peerId, peer] of this.peers.entries()) {
        const timeSinceLastSeen = now.getTime() - peer.lastSeen.getTime();
        // Mark as offline if not seen for 30 seconds
        if (timeSinceLastSeen > 30000) {
          if (peer.isOnline) {
            peer.isOnline = false;
            console.log(`⚠️ Peer ${peerId} went offline`);
            this.emit('peer-offline', peer);
          }
        }
      }
    }, 10000); // Check every 10 seconds
  }

  /**
   * Mark peer as online (heartbeat response)
   */
  markPeerOnline(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (peer) {
      const wasOffline = !peer.isOnline;
      peer.isOnline = true;
      peer.lastSeen = new Date();
      if (wasOffline) {
        console.log(`✅ Peer ${peerId} came back online`);
        this.emit('peer-online', peer);
      }
    }
  }

  /**
   * Get network statistics
   */
  getNetworkStats() {
    const onlinePeers = this.getConnectedPeers();
    const totalFiles = this.fileMetadata.size;
    let totalStorage = 0;

    for (const peer of onlinePeers) {
      totalStorage += peer.storageUsed;
    }

    return {
      peerId: this.peerId,
      onlinePeers: onlinePeers.length,
      totalPeers: this.peers.size,
      totalFiles,
      totalStorage,
      averageReplication: totalFiles > 0
        ? Array.from(this.fileMetadata.values()).reduce((sum, f) => sum + f.replicatedOn.length, 0) / totalFiles
        : 0,
    };
  }

  /**
   * Discover peers on the local network
   */
  async discoverPeers(): Promise<PeerNode[]> {
    console.log(`🔍 Discovering peers on local network...`);
    // In a real implementation, this would use mDNS or broadcast discovery
    // For now, return connected peers
    return this.getConnectedPeers();
  }
}

export const p2pNetworkService = new P2PNetworkService(
  `peer-${Math.random().toString(36).substr(2, 9)}`,
  5000,
  'localhost'
);
