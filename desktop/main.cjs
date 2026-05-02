const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { app, BrowserWindow, Menu, shell } = require('electron');

const ROOT_DIR = path.resolve(__dirname, '..');
const HOST = process.env.HOST || process.env.SWARM_ELECTRON_HOST || '127.0.0.1';
const DEFAULT_PORT = Number.parseInt(process.env.PORT || process.env.SWARM_ELECTRON_DEFAULT_PORT || '4343', 10);
const DEFAULT_LOG_PATH = path.join(os.homedir(), '.local', 'state', 'ai-agent-hub', 'logs', 'swarm-app.log');
const LOG_PATH = process.env.AI_AGENT_SWARM_LOG || DEFAULT_LOG_PATH;
const WINDOW_TITLE = 'Codex Agent Swarm';
const SERVER_ENTRY = path.join(ROOT_DIR, 'server', 'swarm-server.js');
const LOADING_PAGE = path.join(ROOT_DIR, 'desktop', 'loading.html');
const SMOKE_BOOT_FILE = process.env.AI_AGENT_SWARM_SMOKE_BOOT_FILE || '';
const SMOKE_EXIT_ON_LOAD = process.env.AI_AGENT_SWARM_SMOKE_EXIT_ON_LOAD === '1';

let mainWindow = null;
let serverProcess = null;
let appUrl = '';
let activePort = 0;
let quitting = false;

configureElectronRuntime();

app.whenReady().then(bootApplication).catch((error) => {
  console.error(error);
  app.exit(1);
});

app.on('before-quit', () => {
  quitting = true;
  stopServer();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('SIGINT', () => app.quit());
process.on('SIGTERM', () => app.quit());

function configureElectronRuntime() {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('ozone-platform-hint', process.env.ELECTRON_OZONE_PLATFORM_HINT || 'auto');
  app.commandLine.appendSwitch('enable-features', 'WaylandWindowDecorations');
}

async function bootApplication() {
  Menu.setApplicationMenu(null);
  mainWindow = createMainWindow();
  await loadLoadingPage({
    state: 'boot',
    detail: 'Menyalakan server swarm lokal dan menyambungkan dashboard native.',
  });

  activePort = await findFreePort(DEFAULT_PORT);
  appUrl = `http://${HOST}:${activePort}`;
  console.log(`[swarm-app] starting desktop app on ${appUrl}`);
  console.log(`[swarm-app] log file: ${LOG_PATH}`);
  spawnServer(activePort);

  try {
    await waitForHealth(`${appUrl}/api/health`, 30000);
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }
    lockNavigation(mainWindow, appUrl);
    await mainWindow.loadURL(appUrl);
    mainWindow.setTitle(WINDOW_TITLE);
    writeSmokeState({
      ok: true,
      state: 'loaded',
      url: appUrl,
      port: activePort,
      logPath: LOG_PATH,
      title: WINDOW_TITLE,
    });
    if (SMOKE_EXIT_ON_LOAD) {
      setTimeout(() => {
        if (!quitting) {
          app.quit();
        }
      }, 150).unref();
    }
  } catch (error) {
    console.error(`[swarm-app] failed to boot: ${error.message}`);
    writeSmokeState({
      ok: false,
      state: 'error',
      error: error.message,
      url: appUrl,
      port: activePort,
      logPath: LOG_PATH,
    });
    await loadLoadingPage({
      state: 'error',
      detail: error.message,
      logPath: LOG_PATH,
    });
    if (SMOKE_EXIT_ON_LOAD) {
      app.exit(1);
    }
  }
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1600,
    height: 1020,
    minWidth: 1240,
    minHeight: 760,
    backgroundColor: '#08111a',
    autoHideMenuBar: true,
    show: false,
    title: WINDOW_TITLE,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  window.once('ready-to-show', () => {
    window.show();
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  return window;
}

function lockNavigation(window, allowedBaseUrl) {
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(allowedBaseUrl)) {
      return { action: 'allow' };
    }
    safeOpenExternal(url, allowedBaseUrl);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith(allowedBaseUrl) || url.startsWith('file:')) {
      return;
    }
    event.preventDefault();
  });
}

async function loadLoadingPage(options) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  const query = {
    state: options.state || 'boot',
    detail: options.detail || '',
    workspace: process.env.SWARM_WORKSPACE || process.cwd(),
    objective: process.env.SWARM_OBJECTIVE || '',
    profile: process.env.SWARM_PROFILE || 'adaptive',
    logPath: options.logPath || LOG_PATH,
  };

  await mainWindow.loadFile(LOADING_PAGE, { query });
  mainWindow.setTitle(WINDOW_TITLE);
}

function safeOpenExternal(rawUrl, allowedBaseUrl) {
  try {
    const parsed = new URL(rawUrl);
    const allowed = new Set(['https:', 'mailto:']);
    if (rawUrl.startsWith(allowedBaseUrl)) {
      allowed.add('http:');
    }
    if (!allowed.has(parsed.protocol)) {
      return;
    }
    void shell.openExternal(parsed.toString());
  } catch (_error) {
    // Ignore invalid URL attempts.
  }
}

function spawnServer(port) {
  const logDir = path.dirname(LOG_PATH);
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, '', { mode: 0o600 });
  }
  try {
    fs.chmodSync(logDir, 0o700);
    fs.chmodSync(LOG_PATH, 0o600);
  } catch (_error) {
    // Ignore chmod issues on unsupported filesystems.
  }
  const logStream = fs.createWriteStream(LOG_PATH, { flags: 'a', mode: 0o600 });
  const header = `\n[${new Date().toISOString()}] launch port=${port} workspace=${process.env.SWARM_WORKSPACE || process.cwd()}\n`;
  logStream.write(header);

  serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT_DIR,
    env: {
      ...process.env,
      HOST,
      PORT: String(port),
      SWARM_WORKSPACE: process.env.SWARM_WORKSPACE || process.cwd(),
      SWARM_OBJECTIVE: process.env.SWARM_OBJECTIVE || '',
      SWARM_PROFILE: process.env.SWARM_PROFILE || 'adaptive',
      SWARM_SEARCH: process.env.SWARM_SEARCH || '0',
      CODEX_MODEL: process.env.CODEX_MODEL || '',
      CODEX_SANDBOX: process.env.CODEX_SANDBOX || 'workspace-write',
      CODEX_BIN: process.env.CODEX_BIN || 'codex',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProcess.stdout.on('data', (chunk) => {
    logStream.write(`[stdout] ${chunk}`);
  });

  serverProcess.stderr.on('data', (chunk) => {
    logStream.write(`[stderr] ${chunk}`);
  });

  serverProcess.on('exit', async (code, signal) => {
    logStream.write(`[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}\n`);
    logStream.end();
    serverProcess = null;
    if (quitting) {
      return;
    }
    const detail = `Server swarm berhenti sebelum aplikasi ditutup. code=${code ?? 'null'} signal=${signal ?? 'null'}`;
    console.error(`[swarm-app] ${detail}`);
    await loadLoadingPage({
      state: 'error',
      detail,
      logPath: LOG_PATH,
    });
  });
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) {
    return;
  }

  serverProcess.kill('SIGTERM');
  setTimeout(() => {
    if (serverProcess && !serverProcess.killed) {
      serverProcess.kill('SIGKILL');
    }
  }, 4000).unref();
}

function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      http
        .get(url, (response) => {
          const ok = response.statusCode === 200;
          response.resume();
          if (ok) {
            resolve();
            return;
          }
          retry(new Error(`health endpoint returned ${response.statusCode}`));
        })
        .on('error', retry);
    };

    const retry = (error) => {
      if (Date.now() >= deadline) {
        reject(new Error(`Server swarm tidak siap dalam ${timeoutMs / 1000} detik. ${error.message}`));
        return;
      }
      setTimeout(tick, 500);
    };

    tick();
  });
}

function findFreePort(startPort) {
  const lastPort = startPort + 40;

  return new Promise((resolve, reject) => {
    const tryPort = (port) => {
      if (port > lastPort) {
        reject(new Error(`Tidak ada port kosong di rentang ${startPort}-${lastPort}.`));
        return;
      }

      const tester = net.createServer();
      tester.unref();
      tester.on('error', () => {
        tryPort(port + 1);
      });
      tester.listen(port, HOST, () => {
        const address = tester.address();
        tester.close(() => resolve(typeof address === 'object' && address ? address.port : port));
      });
    };

    tryPort(startPort);
  });
}

function writeSmokeState(payload) {
  if (!SMOKE_BOOT_FILE) {
    return;
  }
  try {
    fs.mkdirSync(path.dirname(SMOKE_BOOT_FILE), { recursive: true });
    fs.writeFileSync(SMOKE_BOOT_FILE, JSON.stringify({
      at: new Date().toISOString(),
      ...payload,
    }, null, 2));
  } catch (error) {
    console.error(`[swarm-app] failed to write smoke state: ${error.message}`);
  }
}
