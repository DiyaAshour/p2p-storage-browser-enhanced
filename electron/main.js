import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import isDev from 'electron-is-dev';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

async function createWindow() {
  const url = isDev ? 'http://127.0.0.1:3000' : 'http://127.0.0.1:3000'; // سنفترض أن السيرفر يعمل محلياً

  // فتح المتصفح الافتراضي
  await shell.openExternal(url);

  // إظهار نافذة صغيرة تخبر المستخدم أن التطبيق يعمل في المتصفح
  mainWindow = new BrowserWindow({
    width: 400,
    height: 200,
    resizable: false,
    alwaysOnTop: true,
    frame: false, // بدون إطار لتبدو كرسالة تنبيه
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadURL(`data:text/html;charset=utf-8,
    <body style="background: #1e293b; color: white; font-family: sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; border: 1px solid #334155;">
      <h3 style="margin-bottom: 10px;">P2P Storage Browser</h3>
      <p style="font-size: 14px; color: #94a3b8; text-align: center; padding: 0 20px;">Opening in your default browser for MetaMask support...</p>
      <button onclick="window.close()" style="margin-top: 15px; padding: 5px 15px; background: #2563eb; border: none; color: white; border-radius: 4px; cursor: pointer;">Close this window</button>
    </body>
  `);

  // إغلاق النافذة تلقائياً بعد 5 ثوانٍ
  setTimeout(() => {
    if (mainWindow) mainWindow.close();
  }, 5000);
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

// IPC handlers for P2P operations
ipcMain.handle('get-storage-path', () => {
  return path.join(app.getPath('userData'), 'storage');
});

ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// Create menu
const template = [
  {
    label: 'File',
    submenu: [
      {
        label: 'Exit',
        accelerator: 'CmdOrCtrl+Q',
        click: () => {
          app.quit();
        },
      },
    ],
  },
  {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
    ],
  },
  {
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
    ],
  },
];

const menu = Menu.buildFromTemplate(template);
Menu.setApplicationMenu(menu);
