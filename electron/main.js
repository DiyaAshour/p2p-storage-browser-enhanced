import { app, BrowserWindow, Menu, ipcMain, shell } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import isDev from 'electron-is-dev';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;
let serverProcess;
let viteProcess;

function startBackend() {
  const serverPath = isDev 
    ? path.join(__dirname, '../server/index.ts')
    : path.join(__dirname, '../dist/index.js');
  
  const cmd = isDev ? 'pnpm' : 'node';
  const args = isDev ? ['tsx', serverPath] : [serverPath];

  serverProcess = spawn(cmd, args, {
    shell: true,
    env: { ...process.env, NODE_ENV: isDev ? 'development' : 'production' }
  });

  serverProcess.stdout.on('data', (data) => console.log(`Server: ${data}`));
  serverProcess.stderr.on('data', (data) => console.error(`Server Error: ${data}`));
}

function startFrontend() {
  if (!isDev) {
    // في نسخة الإنتاج، نستخدم vite لخدمة الملفات أو نعتمد على السيرفر المدمج
    // هنا سنقوم بتشغيل vite preview أو ما يعادلها لضمان عمل الرابط 3000
    viteProcess = spawn('pnpm', ['vite', 'preview', '--port', '3000', '--host', '127.0.0.1'], {
      shell: true
    });
  } else {
    viteProcess = spawn('pnpm', ['dev'], {
      shell: true
    });
  }
}

import http from 'http';

async function checkServerReady(url, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      await new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
          if (res.statusCode === 200) resolve();
          else reject();
        });
        req.on('error', reject);
        req.end();
      });
      return true;
    } catch (e) {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return false;
}

async function createWindow() {
  const url = 'http://127.0.0.1:3000';

  // إظهار نافذة انتظار احترافية
  mainWindow = new BrowserWindow({
    width: 500,
    height: 300,
    resizable: false,
    alwaysOnTop: true,
    frame: true, // أعدنا الإطار لضمان الظهور
    center: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.show();

  mainWindow.loadURL(`data:text/html;charset=utf-8,
    <body style="background: #0f172a; color: white; font-family: 'Segoe UI', sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; border: 2px solid #38bdf8; border-radius: 12px; overflow: hidden;">
      <div style="text-align: center;">
        <div style="font-size: 50px; margin-bottom: 15px; animation: pulse 2s infinite;">🔐</div>
        <h2 style="margin: 0 0 10px 0; color: #38bdf8;">P2P Storage System</h2>
        <div id="status" style="font-size: 14px; color: #94a3b8;">Initializing background servers...</div>
        <div style="margin-top: 20px; width: 200px; height: 4px; background: #1e293b; border-radius: 2px; overflow: hidden;">
          <div id="progress" style="width: 30%; height: 100%; background: #38bdf8; transition: width 0.5s;"></div>
        </div>
      </div>
      <style>
        @keyframes pulse { 0% { transform: scale(1); } 50% { transform: scale(1.1); } 100% { transform: scale(1); } }
      </style>
    </body>
  `);

  // التحقق من جاهزية السيرفر
  const isReady = await checkServerReady(url);

  if (isReady) {
    await shell.openExternal(url);
    mainWindow.webContents.executeJavaScript(`
      document.getElementById('status').innerHTML = '✅ System Ready! Opening browser...';
      document.getElementById('progress').style.width = '100%';
      document.getElementById('progress').style.background = '#22c55e';
    `);
    setTimeout(() => { if (mainWindow) mainWindow.close(); }, 3000);
  } else {
    mainWindow.webContents.executeJavaScript(`
      document.getElementById('status').innerHTML = '❌ Error: Server timed out. Please run "pnpm dev" manually.';
      document.getElementById('status').style.color = '#ef4444';
      document.getElementById('progress').style.background = '#ef4444';
    `);
    mainWindow.setClosable(true);
  }
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  // إغلاق العمليات الخلفية عند إغلاق التطبيق
  if (serverProcess) serverProcess.kill();
  if (viteProcess) viteProcess.kill();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (serverProcess) serverProcess.kill();
  if (viteProcess) viteProcess.kill();
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
