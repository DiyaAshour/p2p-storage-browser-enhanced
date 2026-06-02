// P2P transport safety limits.
//
// Chunk policy:
// - small/normal files: 2MB chunks
// - 100MB+ files: 8MB chunks
// - 5GB+ files: 16MB chunks
//
// Chunks are sent as JSON/base64 messages. A 16MB binary chunk becomes ~21.4MB
// in base64 before JSON overhead, so the default max message must be higher than
// the binary chunk size. Keep this limit aligned with electron/core/config.js.
export const P2P_NETWORK_LIMITS = {
  maxTotalPeers: Number(process.env.P2P_MAX_TOTAL_PEERS || 48),
  maxOutboundPeers: Number(process.env.P2P_MAX_OUTBOUND_PEERS || 16),
  maxInboundPeers: Number(process.env.P2P_MAX_INBOUND_PEERS || 32),
  maxUiClients: Number(process.env.P2P_MAX_UI_CLIENTS || 4),
  maxChunkGetFanout: Number(process.env.P2P_MAX_CHUNK_GET_FANOUT || 4),
  maxPendingChunkRequests: Number(process.env.P2P_MAX_PENDING_CHUNK_REQUESTS || 64),
  maxPendingChunkAcks: Number(process.env.P2P_MAX_PENDING_CHUNK_ACKS || 64),
  maxBufferedBytesPerPeer: Number(process.env.P2P_MAX_BUFFERED_BYTES_PER_PEER || 64 * 1024 * 1024),
  maxMessageBytes: Number(process.env.P2P_MAX_MESSAGE_BYTES || 32 * 1024 * 1024),
  reconnectBaseMs: Number(process.env.P2P_RECONNECT_BASE_MS || 1000),
  reconnectMaxMs: Number(process.env.P2P_RECONNECT_MAX_MS || 60 * 1000),
  peerUploadBytesPerSecond: Number(process.env.P2P_PEER_UPLOAD_BYTES_PER_SEC || 4 * 1024 * 1024),
  peerUploadBurstBytes: Number(process.env.P2P_PEER_UPLOAD_BURST_BYTES || 32 * 1024 * 1024),
  globalUploadBytesPerSecond: Number(process.env.P2P_GLOBAL_UPLOAD_BYTES_PER_SEC || 16 * 1024 * 1024),
  globalUploadBurstBytes: Number(process.env.P2P_GLOBAL_UPLOAD_BURST_BYTES || 64 * 1024 * 1024),
};

export function peerBucket(health, socket = null) {
  if (!health || health.state === 'dead') return 'dead';
  if (health.state === 'suspect' || health.failures >= 5 || health.score < 25) return 'quarantine';
  if (health.state === 'offline') return 'offline';
  if ((socket?.bufferedAmount || 0) > P2P_NETWORK_LIMITS.maxBufferedBytesPerPeer / 2) return 'congested';
  if (health.score >= 75 && (!health.lastLatencyMs || health.lastLatencyMs < 750)) return 'fast';
  if (health.score >= 35) return 'stable';
  return 'probation';
}

export function isPeerRoutable(health, socket = null) {
  const bucket = peerBucket(health, socket);
  return !['dead', 'quarantine', 'offline', 'congested'].includes(bucket);
}

export function nextRetryDelayMs(failures = 0) {
  const raw = P2P_NETWORK_LIMITS.reconnectBaseMs * 2 ** Math.min(Number(failures || 0), 6);
  const capped = Math.max(P2P_NETWORK_LIMITS.reconnectBaseMs, Math.min(P2P_NETWORK_LIMITS.reconnectMaxMs, raw));
  return Math.floor(capped * (0.75 + Math.random() * 0.5));
}

export function queuePressure(socket) {
  return {
    bufferedAmount: socket?.bufferedAmount || 0,
    queuedMessages: socket?.sendQueue?.length || 0,
    queuedBytes: socket?.queuedBytes || 0,
    overloaded: (socket?.bufferedAmount || 0) + (socket?.queuedBytes || 0) > P2P_NETWORK_LIMITS.maxBufferedBytesPerPeer,
  };
}
