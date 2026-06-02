import { app, BrowserWindow, Menu, Tray, nativeImage, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { ensureWindowsFirewallRules } from './windows-firewall.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_TITLE = 'Chunknet';
const DEFAULT_GLOBAL_BOOTSTRAP_URL = 'ws://54.166.171.208:8788';
const IS_DEV_WRAPPER = !app.isPackaged || Boolean(process.env.ELECTRON_RENDERER_URL);
let tray = null;
let isQuitting = false;
let closeNoticeShown = false;
let mainImportStarted = false;
let lazySeedInstalled = false;
let startupNetworkConfigured = false;

console.log('[main-wrapper] starting', { isPackaged: app.isPackaged, rendererUrl: process.env.ELECTRON_RENDERER_URL || null, dev: IS_DEV_WRAPPER });

try {
  ipcMain.handle('electron:diagnostics', async () => ({
    ok: true,
    appName: APP_TITLE,
    isPackaged: app.isPackaged,
    appPath: app.getAppPath(),
    userData: app.getPath('userData'),
    resourcesPath: process.resourcesPath,
    dirname: __dirname,
    rendererUrl: process.env.ELECTRON_RENDERER_URL || null,
    publicPeerUrl: process.env.P2P_PUBLIC_URL || null,
    bootstrapUrl: process.env.P2P_BOOTSTRAP_URL || null,
    globalDiscovery: globalThis.__chunknetGlobalDiscovery || null,
    chunkStoreDir: process.env.P2P_CHUNK_STORE_DIR || null,
    mainWindowExists: Boolean(globalThis.__p2pCloudMainWindow && !globalThis.__p2pCloudMainWindow.isDestroyed()),
  }));
} catch (error) {
  console.warn('[main-wrapper] diagnostics IPC already registered or unavailable:', error?.message || error);
}

const gotSingleInstanceLock = IS_DEV_WRAPPER ? true : app.requestSingleInstanceLock();
console.log('[main-wrapper] single-instance lock', gotSingleInstanceLock);
if (!gotSingleInstanceLock) {
  console.warn('[main-wrapper] another instance owns the lock; exiting this instance');
  app.exit(0);
} else {
  app.on('second-instance', () => {
    console.log('[main-wrapper] second instance requested');
    showMainWindow();
  });
}

function installLazySeedIpc() {
  if (lazySeedInstalled) return;
  lazySeedInstalled = true;

  for (const channel of ['seed:create', 'seed:login', 'seed:recover']) {
    try { ipcMain.removeHandler(channel); } catch {}
  }

  const call = async (name, payload) => {
    const mod = await import('./seed-auth-cooldown-ipc.js');
    if (name === 'seed:create') return mod.seedCreate(payload);
    if (name === 'seed:login') return mod.seedLogin(payload);
    return mod.seedRecover(payload);
  };

  ipcMain.handle('seed:create', async (_event, payload = {}) => call('seed:create', payload));
  ipcMain.handle('seed:login', async (_event, payload = {}) => call('seed:login', payload));
  ipcMain.handle('seed:recover', async (_event, payload = {}) => call('seed:recover', payload));
  console.log('[main-wrapper] lazy seed IPC handlers registered');
}

function isVirtualInterfaceName(name = '') {
  const n = String(name).toLowerCase();
  return ['hyper-v', 'vethernet', 'virtual', 'vmware', 'virtualbox', 'docker', 'wsl', 'loopback', 'bluetooth', 'npcap', 'tap', 'tun'].some((bad) => n.includes(bad));
}

function scoreIp(ip = '') {
  if (ip.startsWith('192.168.')) return 100;
  if (ip.startsWith('10.')) return 80;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return 60;
  return 10;
}

function chooseLanAddress() {
  const candidates = [];
  const nets = os.networkInterfaces();
  for (const [name, items] of Object.entries(nets)) {
    if (isVirtualInterfaceName(name)) continue;
    for (const net of items || []) {
      if (!net || net.internal || net.family !== 'IPv4') continue;
      const ip = net.address;
      if (!ip || ip.startsWith('127.') || ip.startsWith('169.254.')) continue;
      candidates.push({ ip, name, score: scoreIp(ip) });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0]?.ip || '127.0.0.1';
}

function configureNetworkRuntime() {
  const port = process.env.P2P_TRANSPORT_PORT || '8787';
  if (!process.env.P2P_TRANSPORT_PORT) process.env.P2P_TRANSPORT_PORT = port;
  if (!process.env.P2P_TRANSPORT_HOST) process.env.P2P_TRANSPORT_HOST = '0.0.0.0';
  if (!process.env.P2P_BOOTSTRAP_URL && String(process.env.P2P_GLOBAL_DISCOVERY_DISABLED || '').toLowerCase() !== 'true') {
    process.env.P2P_BOOTSTRAP_URL = DEFAULT_GLOBAL_BOOTSTRAP_URL;
    console.log('[runtime] selected global bootstrap URL:', process.env.P2P_BOOTSTRAP_URL);
  }
  if (!process.env.P2P_CHUNK_SIZE_BYTES) process.env.P2P_CHUNK_SIZE_BYTES = String(2 * 1024 * 1024);
  if (!process.env.P2P_UPLOAD_CONCURRENCY) process.env.P2P_UPLOAD_CONCURRENCY = '4';
  if (!process.env.P2P_DOWNLOAD_CONCURRENCY) process.env.P2P_DOWNLOAD_CONCURRENCY = '6';
  if (!process.env.P2P_AUTO_REPAIR_INTERVAL_MS) process.env.P2P_AUTO_REPAIR_INTERVAL_MS = String(3 * 60 * 60 * 1000);
  if (!process.env.P2P_AUTO_REPAIR_START_DELAY_MS) process.env.P2P_AUTO_REPAIR_START_DELAY_MS = String(5 * 60 * 1000);
  if (!process.env.P2P_PROTECTION_RETRY_INTERVAL_MS) process.env.P2P_PROTECTION_RETRY_INTERVAL_MS = String(5 * 60 * 1000);
  if (!process.env.P2P_PROTECTION_RETRY_START_DELAY_MS) process.env.P2P_PROTECTION_RETRY_START_DELAY_MS = String(45 * 1000);
  if (!process.env.P2P_PUBLIC_URL && !process.env.VITE_P2P_PUBLIC_URL) {
    const ip = chooseLanAddress();
    process.env.P2P_PUBLIC_URL = `ws://${ip}:${port}`;
    console.log('[runtime] selected public peer URL:', process.env.P2P_PUBLIC_URL);
  }
  if (!process.env.P2P_CHUNK_STORE_DIR) {
    process.env.P2P_CHUNK_STORE_DIR = path.join(app.getPath('userData'), 'native-p2p-storage', 'chunks');
    console.log('[runtime] selected chunk store:', process.env.P2P_CHUNK_STORE_DIR);
  }
  console.log('[runtime] transfer defaults:', {
    transportHost: process.env.P2P_TRANSPORT_HOST,
    transportPort: process.env.P2P_TRANSPORT_PORT,
    chunkSizeBytes: process.env.P2P_CHUNK_SIZE_BYTES,
    uploadConcurrency: process.env.P2P_UPLOAD_CONCURRENCY,
    downloadConcurrency: process.env.P2P_DOWNLOAD_CONCURRENCY,
    autoRepairIntervalMs: process.env.P2P_AUTO_REPAIR_INTERVAL_MS,
    autoRepairStartDelayMs: process.env.P2P_AUTO_REPAIR_START_DELAY_MS,
    protectionRetryIntervalMs: process.env.P2P_PROTECTION_RETRY_INTERVAL_MS,
    protectionRetryStartDelayMs: process.env.P2P_PROTECTION_RETRY_START_DELAY_MS,
    bootstrapUrl: process.env.P2P_BOOTSTRAP_URL || null,
    publicPeerUrl: process.env.P2P_PUBLIC_URL || process.env.VITE_P2P_PUBLIC_URL || null,
  });
}

async function configureStartupNetwork() {
  if (startupNetworkConfigured) return;
  startupNetworkConfigured = true;
  configureNetworkRuntime();
  try {
    const firewall = await ensureWindowsFirewallRules();
    globalThis.__chunknetFirewall = firewall;
  } catch (error) {
    console.warn('[runtime] firewall setup failed; app will continue. Run as Administrator once to install rules:', error?.message || error);
    globalThis.__chunknetFirewall = { ok: false, error: error?.message || String(error) };
  }
}

function resolveTrayIcon() {
  const candidates = [path.join(__dirname, '..', 'assets', 'icon.ico'), path.join(__dirname, '..', 'assets', 'icon.png')];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) return nativeImage.createEmpty();
  const image = nativeImage.createFromPath(found);
  return image.isEmpty() ? nativeImage.createEmpty() : image;
}

function resolveRendererIndexPath() {
  const candidates = [
    path.join(app.getAppPath(), 'dist', 'public', 'index.html'),
    path.join(app.getAppPath(), 'public', 'index.html'),
    path.join(__dirname, '..', 'dist', 'public', 'index.html'),
    path.join(process.resourcesPath || '', 'app', 'dist', 'public', 'index.html'),
  ];
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Renderer index.html not found. Tried: ${candidates.join(' | ')}`);
}

function loadRenderer(win, reason = 'main') {
  if (process.env.ELECTRON_RENDERER_URL) {
    console.log(`[main-wrapper] loading dev renderer (${reason}):`, process.env.ELECTRON_RENDERER_URL);
    return win.loadURL(process.env.ELECTRON_RENDERER_URL);
  }
  const indexPath = resolveRendererIndexPath();
  console.log(`[main-wrapper] loading packaged renderer (${reason}):`, indexPath);
  return win.loadFile(indexPath);
}

function showMainWindow() {
  const win = globalThis.__p2pCloudMainWindow;
  if (!win || win.isDestroyed()) {
    console.warn('[main-wrapper] show requested but no main window exists');
    return;
  }
  win.show();
  if (win.isMinimized()) win.restore();
  win.focus();
  console.log('[main-wrapper] main window shown');
}

function createFallbackWindow(reason = 'main window did not appear') {
  if (globalThis.__p2pCloudMainWindow && !globalThis.__p2pCloudMainWindow.isDestroyed()) return;
  console.warn('[main-wrapper] fallback window created:', reason);
  const win = new BrowserWindow({
    title: APP_TITLE,
    width: 1280,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    show: true,
    backgroundColor: '#09090b',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  globalThis.__p2pCloudMainWindow = win;
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error('[main-wrapper] renderer failed to load:', { errorCode, errorDescription, validatedURL });
  });
  loadRenderer(win, 'fallback').catch((error) => {
    console.error('[main-wrapper] fallback renderer load failed:', error?.stack || error?.message || error);
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`<pre style="white-space:pre-wrap;color:#f87171;background:#09090b;padding:24px;font-family:monospace">Chunknet failed to load renderer\n\n${error?.stack || error?.message || String(error)}</pre>`)}`);
  });
  win.show();
  win.focus();
}

function createTray() {
  if (tray) return tray;
  tray = new Tray(resolveTrayIcon());
  tray.setToolTip(`${APP_TITLE} — running securely in the background`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Chunknet', click: showMainWindow },
    { type: 'separator' },
    { label: 'Secure storage is running', enabled: false },
    { label: 'Close window keeps protection online', enabled: false },
    { type: 'separator' },
    { label: 'Quit Chunknet', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', showMainWindow);
  return tray;
}

function mainStableHasP2PHandlers() {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'main-stable.js'), 'utf8');
    return src.includes("ipcMain.handle('p2p:start'") && src.includes("ipcMain.handle('p2p:networkSummary'");
  } catch {
    return false;
  }
}

async function importPrimaryRuntime() {
  if (!mainStableHasP2PHandlers()) {
    console.warn('[main-wrapper] main-stable.js lacks p2p handlers; importing complete main.js runtime');
    await import('./main.js');
    console.log('[main-wrapper] main.js fallback import finished');
    return 'main';
  }
  try {
    await import('./main-stable.js');
    console.log('[main-wrapper] main-stable.js import finished');
    return 'main-stable';
  } catch (error) {
    console.error('[main-wrapper] main-stable.js import failed, trying complete main.js:', error?.stack || error?.message || error);
    await import('./main.js');
    console.log('[main-wrapper] main.js fallback import finished');
    return 'main';
  }
}

async function importMainWhenReady() {
  if (mainImportStarted) return;
  mainImportStarted = true;
  console.log('[main-wrapper] importing runtime after app ready');
  try {
    installLazySeedIpc();
    await import('./protection-retry-early-ipc.js');
    console.log('[main-wrapper] protection retry early IPC import finished');
    await import('./p2p-transport-global-registry.js');
    console.log('[main-wrapper] p2p global registry import finished');
    await import('./p2p-delete-message-override.js');
    console.log('[main-wrapper] p2p delete message override import finished');
    await import('./wallet-plan-guard.js');
    console.log('[main-wrapper] wallet plan guard import finished');
    await import('./paypal-subscription-ipc.js');
    console.log('[main-wrapper] paypal subscription IPC import finished');
    await importPrimaryRuntime();
    await import('./list-files-normalize-ipc.js');
    console.log('[main-wrapper] list files normalization import finished');
    await import('./network-summary-normalize-ipc.js');
    console.log('[main-wrapper] network summary normalization import finished');
    await import('./global-discovery.js');
    console.log('[main-wrapper] global discovery import finished');
    await import('./company-workspace-ipc.js');
    console.log('[main-wrapper] company workspace IPC import finished');
    await import('./company-join-workspace-ipc.js');
    console.log('[main-wrapper] company portable join workspace IPC import finished');
    await import('./company-offline-invite-ipc.js');
    console.log('[main-wrapper] company offline invite IPC import finished');
    await import('./company-distributed-objects-ipc.js');
    console.log('[main-wrapper] company distributed objects IPC import finished');
    console.log('[main-wrapper] seed auth cooldown IPC deferred until first seed action');
    await import('./shared-link-ipc.js');
    console.log('[main-wrapper] shared link IPC import finished');
    await import('./file-update-ipc.js');
    console.log('[main-wrapper] file update IPC import finished');
    await import('./folder-item-ipc.js');
    console.log('[main-wrapper] folder item IPC import finished');
    await import('./folder-crud-ipc.js');
    console.log('[main-wrapper] folder CRUD IPC import finished');
    await import('./folder-tree-normalize-ipc.js');
    console.log('[main-wrapper] folder tree normalization import finished');
    await import('./ui-prefs-ipc.js');
    console.log('[main-wrapper] UI preferences IPC import finished');
    await import('./protected-upload-override.js');
    console.log('[main-wrapper] protected upload status override import finished');
    await import('./transfer-cancel-ipc.js');
    console.log('[main-wrapper] transfer cancel IPC import finished');
    await import('./stream-upload-override.js');
    console.log('[main-wrapper] streaming upload override import finished');
    await import('./protection-retry-loop.js');
    console.log('[main-wrapper] protection retry loop import finished');
    await import('./download-to-path-override.js');
    console.log('[main-wrapper] download override import finished');
    await import('./hard-delete-override.js');
    console.log('[main-wrapper] hard delete override import finished');
    await import('./delete-tombstone-sync.js');
    console.log('[main-wrapper] delete tombstone sync import finished');
    await import('./tombstone-sync-pull-override.js');
    console.log('[main-wrapper] tombstone sync pull override import finished');
    setTimeout(() => createFallbackWindow('runtime imported but no BrowserWindow appeared'), 3000);
  } catch (error) {
    console.error('[main-wrapper] import failed:', error?.stack || error?.message || error);
    createFallbackWindow(error?.message || 'Electron startup import failed');
  }
}

app.on('ready', () => {
  console.log('[main-wrapper] app ready');
  createTray();
});

app.on('browser-window-created', (_event, win) => {
  console.log('[main-wrapper] browser window created');
  globalThis.__p2pCloudMainWindow = win;
  setTimeout(() => {
    try {
      win.show();
      if (win.isMinimized()) win.restore();
      win.focus();
      console.log('[main-wrapper] forced window show');
    } catch (error) {
      console.warn('[main-wrapper] force window show failed:', error?.message || error);
    }
  }, 1200);
  win.on('close', (event) => {
    if (isQuitting) return;
    if (IS_DEV_WRAPPER) return;
    event.preventDefault();
    win.hide();
    createTray();
    if (!closeNoticeShown && tray) {
      closeNoticeShown = true;
      tray.displayBalloon?.({ title: APP_TITLE, content: 'Chunknet is still running in the background to keep your storage available.' });
    }
  });
});

async function startChunknet() {
  await configureStartupNetwork();
  await importMainWhenReady();
}

startChunknet().catch((error) => {
  console.error('[main-wrapper] startup failed:', error?.stack || error?.message || error);
  app.whenReady().then(() => createFallbackWindow(error?.message || 'Startup failed'));
});

app.on('before-quit', () => { isQuitting = true; });

app.whenReady().then(() => {
  createTray();
  setTimeout(() => createFallbackWindow('safety fallback after ready'), 5000);
});

app.on('window-all-closed', (event) => {
  if (IS_DEV_WRAPPER || isQuitting || process.platform !== 'darwin') app.quit();
  else event?.preventDefault?.();
});

app.on('activate', () => showMainWindow());
