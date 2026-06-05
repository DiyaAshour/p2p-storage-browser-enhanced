import { ipcMain } from 'electron';

function installAssistantHandlers() {
  try { ipcMain.removeHandler('assistant:summary'); } catch {}
  ipcMain.handle('assistant:summary', async (_event, payload = {}) => {
    const summary = payload.summary || {};
    return {
      ok: true,
      answer: `Files: ${Number(summary.totalFiles || 0)}, peers: ${Number(summary.connectedPeers || 0)}, under-replicated chunks: ${Number(summary.underReplicatedChunks || 0)}.`
    };
  });
}

installAssistantHandlers();
