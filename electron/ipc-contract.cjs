const IPC_CHANNELS = Object.freeze([
  'p2p:start',
  'p2p:listFiles',
  'p2p:listFolders',

  'drive:getFolders',
  'drive:saveFolders',

  'p2p:createFolder',
  'p2p:deleteFolder',
  'p2p:deleteItem',
  'p2p:renameItem',
  'p2p:moveItem',
  'p2p:moveFile',
  'p2p:renameFolder',
  'p2p:moveFolder',

  // Legacy upload/download channels kept for older renderer screens.
  // New large-file paths should use p2p:uploadFiles / p2p:uploadPath / p2p:downloadToPath.
  'p2p:upload',
  'p2p:download',

  'p2p:uploadFiles',
  'p2p:uploadFolder',
  'p2p:uploadPath',

  'p2p:downloadToPath',
  'p2p:importSharedLink',

  'p2p:updateFile',
  'p2p:delete',

  'p2p:getUiPrefs',
  'p2p:setUiPrefs',

  'p2p:networkSummary',
  'p2p:bootstrapNow',
  'p2p:connectPeer',
  'p2p:repair',
  'p2p:protectionRetryNow',
  'p2p:pauseProtectionRetry',
  'p2p:resumeProtectionRetry',
  'p2p:protectionRetryStatus',
  'p2p:repairQueueStatus',
  'p2p:repairQueueRebuild',
  'p2p:repairQueueNow',
  'p2p:applyDeleteTombstones',
  'p2p:listTombstones',
  'p2p:prepareProof',
  'p2p:cancelTransfer',

  'wallet:status',
  'wallet:connect',
  'wallet:disconnect',
  'wallet:setPlan',
  'paypal:openCheckout',

  'seed:create',
  'seed:login',
  'seed:recover',

  'company:state',
  'company:deviceIdentity',
  'company:createWorkspace',
  'company:deleteWorkspace',
  'company:inviteMember',
  'company:joinWorkspace',
  'company:createJoinRequest',
  'company:approveJoinRequest',
  'company:exportWorkspaceAccess',
  'company:importWorkspaceAccess',
  'company:publishObject',
  'company:readObject',
  'company:tokenFromObject',
  'company:changeMemberRole',
  'company:removeMember',
  'company:addFile',
  'company:updateFile',
  'company:createFolder',
  'company:updateFolder',
  'company:deleteFolder',

  'audit:list',
  'audit:record',
  'audit:clear',
  'audit:listManifests',

  'electron:openDevTools',
  'electron:diagnostics',
  'system:open-external',
]);

const RETRYABLE_IPC_PREFIXES = Object.freeze([
  'p2p:',
  'wallet:',
  'seed:',
  'company:',
  'drive:',
  'paypal:',
]);

function isAllowedIpcChannel(channel) {
  return IPC_CHANNELS.includes(channel);
}

function isRetryableIpcChannel(channel) {
  return RETRYABLE_IPC_PREFIXES.some((prefix) => String(channel || '').startsWith(prefix));
}

module.exports = {
  IPC_CHANNELS,
  RETRYABLE_IPC_PREFIXES,
  isAllowedIpcChannel,
  isRetryableIpcChannel,
};