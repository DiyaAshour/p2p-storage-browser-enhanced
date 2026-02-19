import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { webRTC } from '@libp2p/webrtc';
import { mplex } from '@libp2p/mplex';
import { noise } from '@libp2p/noise';
import { kadDHT } from '@libp2p/kad-dht';
import { identify } from '@libp2p/identify';
import { pubsubPeerDiscovery } from '@libp2p/pubsub-peer-discovery';
import { gossipsub } from '@chainsafe/libp2p-gossipsub';

class P2PService {
  private libp2p: any;
  private isInitialized = false;
  private peerId: string = '';
  private peers: Map<string, any> = new Map();
  private fileStore: Map<string, any> = new Map();

  async initialize() {
    if (this.isInitialized) return;

    try {
      this.libp2p = await createLibp2p({
        transports: [tcp(), webRTC()],
        streamMuxers: [mplex()],
        connectionEncryption: [noise()],
        dht: kadDHT(),
        services: {
          identify: identify(),
          pubsubPeerDiscovery: pubsubPeerDiscovery({
            interval: 10000,
          }),
          pubsub: gossipsub({
            emitSelf: true,
            allowPublishToZeroPeers: true,
          }),
        },
      });

      await this.libp2p.start();
      this.peerId = this.libp2p.peerId.toString();
      this.isInitialized = true;

      console.log('P2P Network initialized:', this.peerId);

      // Subscribe to file sharing topic
      this.libp2p.services.pubsub.subscribe('p2p-storage/files');
      this.libp2p.services.pubsub.addEventListener('message', (event: any) => {
        this.handleP2PMessage(event.detail.message);
      });
    } catch (error) {
      console.error('Failed to initialize P2P:', error);
      throw error;
    }
  }

  async addFile(fileHash: string, fileData: any, metadata: any) {
    try {
      this.fileStore.set(fileHash, {
        data: fileData,
        metadata,
        timestamp: Date.now(),
        peerId: this.peerId,
      });

      // Broadcast file availability to network
      await this.libp2p.services.pubsub.publish('p2p-storage/files', {
        type: 'file-added',
        hash: fileHash,
        peerId: this.peerId,
        metadata,
      });

      return { success: true, hash: fileHash };
    } catch (error) {
      console.error('Failed to add file:', error);
      throw error;
    }
  }

  async getFile(fileHash: string) {
    try {
      // First check local storage
      if (this.fileStore.has(fileHash)) {
        return this.fileStore.get(fileHash);
      }

      // Request from network peers
      const peers = Array.from(this.peers.values());
      for (const peer of peers) {
        try {
          const file = await this.requestFileFromPeer(peer, fileHash);
          if (file) {
            // Cache locally
            this.fileStore.set(fileHash, file);
            return file;
          }
        } catch (error) {
          console.warn(`Failed to get file from peer ${peer.peerId}:`, error);
        }
      }

      throw new Error(`File ${fileHash} not found in network`);
    } catch (error) {
      console.error('Failed to get file:', error);
      throw error;
    }
  }

  async requestFileFromPeer(peer: any, fileHash: string) {
    try {
      const stream = await this.libp2p.dialProtocol(
        peer.multiaddrs,
        '/p2p-storage/file-request/1.0.0'
      );

      // Send request
      const request = JSON.stringify({ type: 'request', hash: fileHash });
      await stream.sink([new TextEncoder().encode(request)]);

      // Receive response
      const response = await stream.source[Symbol.asyncIterator]().next();
      return JSON.parse(new TextDecoder().decode(response.value.subarray()));
    } catch (error) {
      console.error('Failed to request file from peer:', error);
      throw error;
    }
  }

  private handleP2PMessage(message: any) {
    try {
      const data = JSON.parse(new TextDecoder().decode(message.data));

      if (data.type === 'file-added') {
        this.peers.set(data.peerId, {
          peerId: data.peerId,
          files: [data.hash],
          metadata: data.metadata,
        });
      } else if (data.type === 'peer-joined') {
        console.log('Peer joined:', data.peerId);
      }
    } catch (error) {
      console.error('Failed to handle P2P message:', error);
    }
  }

  getPeerId(): string {
    return this.peerId;
  }

  getPeerCount(): number {
    return this.peers.size;
  }

  async shutdown() {
    if (this.libp2p) {
      await this.libp2p.stop();
      this.isInitialized = false;
    }
  }
}

export const p2pService = new P2PService();
