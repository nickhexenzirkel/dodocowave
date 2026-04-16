const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path  = require('path');
const https = require('https');
const http  = require('http');
const fs    = require('fs');
const os    = require('os');

let mainWindow;

// ─── AUTO UPDATER ───
function setupAutoUpdater() {
  if (!app.isPackaged) return; // Não verifica update em desenvolvimento

  autoUpdater.autoDownload = true;         // Baixa automaticamente
  autoUpdater.autoInstallOnAppQuit = true; // Instala ao fechar o app

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('update-status', { type: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('update-status', { type: 'available', version: info.version });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('update-status', { type: 'not-available' });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('update-status', {
      type: 'downloading',
      percent: Math.floor(progress.percent),
      speed: Math.floor(progress.bytesPerSecond / 1024) // KB/s
    });
  });

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.webContents.send('update-status', { type: 'downloaded' });
  });

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('update-status', { type: 'error', message: err.message });
  });

  // Verifica agora e a cada 30 minutos
  autoUpdater.checkForUpdates();
  setInterval(() => autoUpdater.checkForUpdates(), 30 * 60 * 1000);
}

function createWindow() {
  const iconPath = path.join(__dirname, 'renderer', 'images', 'DodocoWave.ico');

  mainWindow = new BrowserWindow({
    width: 1100, height: 750,
    show: false,
    frame: false,          // Janela sem bordas nativas
    fullscreen: true,
    backgroundColor: '#04040f',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,        // Renderer roda em sandbox do Chromium
      webSecurity: true,    // Mantém same-origin policy ativa
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
    }
  });

  // ─── FIX: User-Agent mais genérico para o YouTube não bloquear requests do yt-dlp ───
  mainWindow.webContents.session.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  // ─── HARDENING: bloqueia popups e navegação para fora do app ───
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    // Só permite navegação dentro do bundle local (file://) carregado pelo app
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.webContents.on('will-redirect', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });

  // ─── HARDENING: nega permissões sensíveis (camera, mic, geoloc, notificações, etc.) ───
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false);
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
    setupAutoUpdater(); // ← Inicia verificação de updates
  });

  mainWindow.on('closed', () => { mainWindow = null; });
  mainWindow.setMenuBarVisibility(false);
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());

// ─── HELPERS ───
function send(event, pct, msg) {
  try {
    if (!event.sender.isDestroyed())
      event.sender.send('download-progress', { pct, msg });
  } catch(e) {}
}

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const chunks = [];
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Range': 'bytes=0-'
      }
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return fetchBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode >= 400) {
        return reject(new Error(`HTTP ${res.statusCode} ao baixar audio`));
      }
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout ao baixar audio')); });
  });
}

// ─── INPUT VALIDATION: aceita apenas URLs do YouTube ───
// Protege contra SSRF / uso indevido do yt-dlp para endpoints arbitrários.
function isValidYouTubeUrl(raw) {
  if (typeof raw !== 'string') return false;
  const s = raw.trim();
  if (s.length === 0 || s.length > 2048) return false;
  let u;
  try { u = new URL(s); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase();
  const allowed = [
    'youtube.com', 'www.youtube.com', 'm.youtube.com',
    'music.youtube.com', 'youtube-nocookie.com', 'www.youtube-nocookie.com',
    'youtu.be'
  ];
  return allowed.includes(host);
}

// ─── IPC: YOUTUBE AUDIO via yt-dlp-wrap ───
ipcMain.handle('get-yt-audio', async (event, ytUrl) => {
  if (!isValidYouTubeUrl(ytUrl)) {
    throw new Error('URL invalida: forneca um link do YouTube (youtube.com ou youtu.be).');
  }

  let YTDlpWrap;
  try {
    YTDlpWrap = require('yt-dlp-wrap').default || require('yt-dlp-wrap');
  } catch(e) {
    throw new Error('yt-dlp-wrap nao instalado. Rode: npm install');
  }

  send(event, 8, 'Verificando yt-dlp...');

  const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';

  const binPath = app.isPackaged
    ? path.join(process.resourcesPath, binName)
    : path.join(__dirname, binName);

  if (!fs.existsSync(binPath)) {
    send(event, 12, 'Baixando yt-dlp (apenas primeira vez)...');
    try {
      await YTDlpWrap.downloadFromGithub(binPath);
      send(event, 22, 'yt-dlp instalado!');
    } catch(e) {
      throw new Error('Falha ao baixar yt-dlp: ' + e.message + '. Verifique sua conexao.');
    }
  }

  const ytdlp = new YTDlpWrap(binPath);

  send(event, 28, 'Buscando informacoes do video...');

  let info;
  try {
    const infoJson = await ytdlp.execPromise([
      ytUrl,
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
    ]);
    info = JSON.parse(infoJson);
  } catch(e) {
    throw new Error('Erro ao obter info do video: ' + e.message.slice(0, 120));
  }

  const title    = info.title || 'Musica';
  const duration = info.duration || 0;
  const audioUrl = info.url || (info.formats && info.formats[info.formats.length - 1]?.url);

  if (!audioUrl) throw new Error('Nao foi possivel obter URL do audio.');

  send(event, 42, `Encontrado: ${title.slice(0, 50)}`);
  send(event, 50, 'Baixando audio...');

  let buf;
  try {
    buf = await fetchBuffer(audioUrl);
  } catch(e) {
    send(event, 52, 'Usando download direto...');
    const tmpFile = path.join(os.tmpdir(), `dw_${Date.now()}.%(ext)s`);
    const outFile = path.join(os.tmpdir(), `dw_${Date.now()}.webm`);
    try {
      await ytdlp.execPromise([
        ytUrl,
        '-f', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
        '-o', tmpFile,
        '--no-playlist',
        '--no-warnings',
      ]);
      const tmpDir = os.tmpdir();
      const files  = fs.readdirSync(tmpDir).filter(f => f.startsWith('dw_'));
      const newest = files.sort().reverse()[0];
      if (!newest) throw new Error('Arquivo temporario nao encontrado');
      buf = fs.readFileSync(path.join(tmpDir, newest));
      try { fs.unlinkSync(path.join(tmpDir, newest)); } catch(e) {}
    } catch(e2) {
      throw new Error('Falha ao baixar audio: ' + e2.message.slice(0, 120));
    }
  }

  send(event, 82, `Download completo: ${Math.floor(buf.length / 1024)} KB`);

  // ─── Pega URL direta do stream de vídeo (para fundo do jogo) ───
  let videoUrl = null;
  try {
    send(event, 86, 'Obtendo URL do vídeo...');
    const videoInfoJson = await ytdlp.execPromise([
      ytUrl,
      '--dump-single-json',
      '--no-warnings',
      '--no-playlist',
      '-f', 'bestvideo[height<=360][ext=mp4]/bestvideo[height<=480][ext=mp4]/bestvideo[height<=360]/bestvideo[height<=480]/worst[ext=mp4]/worst',
    ]);
    const videoInfo = JSON.parse(videoInfoJson);
    videoUrl = videoInfo.url || null;
  } catch(e) {
    // URL de vídeo é opcional — não interrompe o jogo se falhar
  }

  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  return { arrayBuffer: ab, title, duration, videoUrl };
});

// ─── IPC: INSTALAR UPDATE ───
ipcMain.on('install-update', () => {
  autoUpdater.quitAndInstall();
});

// ─── WINDOW CONTROLS ───
ipcMain.on('minimize-window', () => mainWindow && mainWindow.minimize());
ipcMain.on('maximize-window', () => {
  if (!mainWindow) return;
  mainWindow.isMaximized() ? mainWindow.unmaximize() : mainWindow.maximize();
});
ipcMain.on('close-window', () => mainWindow && mainWindow.close());
