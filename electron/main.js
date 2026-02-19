import { app, shell } from 'electron';

app.on('ready', async () => {
  const url = 'http://127.0.0.1:3000';
  
  // فتح المتصفح الافتراضي فوراً لضمان عمل MetaMask
  console.log('Opening browser...');
  await shell.openExternal(url);
  
  // إغلاق تطبيق Electron فوراً بعد فتح المتصفح
  app.quit();
});

app.on('window-all-closed', () => {
  app.quit();
});
