const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const { WebSocket, WebSocketServer } = require('ws');
const pty = require('node-pty');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '4242', 10);
const WORKSPACE_ROOT = path.resolve(process.env.CODEX_WORKSPACE || process.cwd());
const DEFAULT_PANEL_COUNT = clamp(Number.parseInt(process.env.PANEL_COUNT || '6', 10), 2, 6);
const DEFAULT_MODEL = process.env.CODEX_MODEL || '';
const DEFAULT_SANDBOX = process.env.CODEX_SANDBOX || 'workspace-write';
const DEFAULT_APPROVAL = process.env.CODEX_APPROVAL || 'on-request';
const MAX_BUFFER_CHARS = 250_000;

if (!fs.existsSync(WORKSPACE_ROOT) || !fs.statSync(WORKSPACE_ROOT).isDirectory()) {
  throw new Error(`Workspace root does not exist or is not a directory: ${WORKSPACE_ROOT}`);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sessions = new Map();
const activeSettings = {
  panelCount: DEFAULT_PANEL_COUNT,
  workspace: WORKSPACE_ROOT,
  model: DEFAULT_MODEL,
  sandbox: DEFAULT_SANDBOX,
  approval: DEFAULT_APPROVAL,
};

app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib')));
app.use('/vendor/xterm-css', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')));
app.use('/vendor/xterm-fit', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib')));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    host: HOST,
    port: PORT,
    codexBinary: resolveCodexBinary(),
    settings: activeSettings,
    sessions: listSessions(),
  });
});

app.get('/api/bootstrap', (_req, res) => {
  res.json({
    defaults: activeSettings,
    cwd: process.cwd(),
    codexBinary: resolveCodexBinary(),
  });
});

app.post('/api/sessions/sync', (req, res) => {
  try {
    const nextSettings = normalizeSettings(req.body || {});
    Object.assign(activeSettings, nextSettings);
    ensureSessionPool(nextSettings);
    res.json({
      ok: true,
      settings: activeSettings,
      sessions: listSessions(),
    });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/sessions/restart-all', (_req, res) => {
  for (const session of sessions.values()) {
    restartSession(session);
  }
  res.json({ ok: true, sessions: listSessions() });
});

app.post('/api/sessions/:id/restart', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) {
    res.status(404).json({ ok: false, error: 'Unknown session.' });
    return;
  }

  restartSession(session);
  res.json({ ok: true, session: serializeSession(session) });
});

app.get(/.*/, (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const sessionId = url.searchParams.get('sessionId');
  const session = sessionId ? sessions.get(sessionId) : null;

  if (!session) {
    socket.close(1008, 'Unknown session');
    return;
  }

  session.clients.add(socket);
  socket.send(JSON.stringify({
    type: 'bootstrap',
    session: serializeSession(session),
    backlog: session.buffer,
  }));

  socket.on('message', (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch (_error) {
      return;
    }

    if (message.type === 'input' && typeof message.data === 'string') {
      session.ptyProcess?.write(message.data);
      return;
    }

    if (message.type === 'resize') {
      const cols = clamp(Number.parseInt(String(message.cols || ''), 10), 30, 300);
      const rows = clamp(Number.parseInt(String(message.rows || ''), 10), 8, 120);
      session.cols = cols;
      session.rows = rows;
      session.ptyProcess?.resize(cols, rows);
      return;
    }

    if (message.type === 'restart') {
      restartSession(session);
    }
  });

  socket.on('close', () => {
    session.clients.delete(socket);
  });
});

ensureSessionPool(activeSettings);

server.listen(PORT, HOST, () => {
  console.log(`AI Agent Hub listening on http://${HOST}:${PORT}`);
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function resolveCodexBinary() {
  return process.env.CODEX_BIN || 'codex';
}

function normalizeSettings(input) {
  const panelCount = clamp(Number.parseInt(String(input.panelCount || activeSettings.panelCount), 10), 2, 6);
  const workspace = path.resolve(String(input.workspace || activeSettings.workspace || WORKSPACE_ROOT));
  const model = String(input.model || '').trim();
  const sandbox = String(input.sandbox || activeSettings.sandbox || DEFAULT_SANDBOX).trim() || DEFAULT_SANDBOX;
  const approval = String(input.approval || activeSettings.approval || DEFAULT_APPROVAL).trim() || DEFAULT_APPROVAL;

  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    throw new Error(`Workspace tidak valid: ${workspace}`);
  }

  return { panelCount, workspace, model, sandbox, approval };
}

function ensureSessionPool(settings) {
  const desiredIds = new Set();

  for (let index = 0; index < settings.panelCount; index += 1) {
    const id = `agent-${index + 1}`;
    desiredIds.add(id);
    const name = `Agent ${String(index + 1).padStart(2, '0')}`;
    const existing = sessions.get(id);

    if (!existing) {
      const created = createSession({ id, index, name, ...settings });
      sessions.set(id, created);
      startSession(created);
      continue;
    }

    const needsRestart = [
      ['workspace', settings.workspace],
      ['model', settings.model],
      ['sandbox', settings.sandbox],
      ['approval', settings.approval],
    ].some(([key, value]) => existing[key] !== value);

    existing.index = index;
    existing.name = name;
    existing.workspace = settings.workspace;
    existing.model = settings.model;
    existing.sandbox = settings.sandbox;
    existing.approval = settings.approval;

    if (needsRestart) {
      restartSession(existing);
    }
  }

  for (const [id, session] of sessions.entries()) {
    if (!desiredIds.has(id)) {
      destroySession(session);
      sessions.delete(id);
    }
  }
}

function createSession({ id, index, name, workspace, model, sandbox, approval }) {
  return {
    id,
    index,
    name,
    workspace,
    model,
    sandbox,
    approval,
    cols: 100,
    rows: 28,
    status: 'starting',
    pid: null,
    generation: crypto.randomUUID(),
    buffer: '',
    exitCode: null,
    clients: new Set(),
    ptyProcess: null,
  };
}

function startSession(session) {
  const args = ['--no-alt-screen', '--cd', session.workspace, '--sandbox', session.sandbox, '--ask-for-approval', session.approval];

  if (session.model) {
    args.push('--model', session.model);
  }

  session.status = 'starting';
  session.exitCode = null;
  session.generation = crypto.randomUUID();
  session.buffer = '';
  broadcast(session, { type: 'session', session: serializeSession(session) });
  const currentGeneration = session.generation;

  let child;
  try {
    child = pty.spawn(resolveCodexBinary(), args, {
      name: 'xterm-256color',
      cols: session.cols,
      rows: session.rows,
      cwd: session.workspace,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        FORCE_COLOR: '1',
      },
    });
  } catch (error) {
    session.status = 'exited';
    session.exitCode = 1;
    session.buffer = `Failed to start Codex: ${error.message}\r\n`;
    broadcast(session, { type: 'session', session: serializeSession(session) });
    broadcast(session, { type: 'output', data: session.buffer });
    return;
  }

  session.ptyProcess = child;
  session.pid = child.pid;
  session.status = 'online';
  broadcast(session, { type: 'session', session: serializeSession(session) });

  child.onData((data) => {
    if (session.generation !== currentGeneration || session.ptyProcess !== child) {
      return;
    }

    session.buffer += data;
    if (session.buffer.length > MAX_BUFFER_CHARS) {
      session.buffer = session.buffer.slice(-MAX_BUFFER_CHARS);
    }
    broadcast(session, { type: 'output', data });
  });

  child.onExit(({ exitCode }) => {
    if (session.generation !== currentGeneration) {
      return;
    }

    session.pid = null;
    session.exitCode = exitCode;
    session.status = 'exited';
    session.ptyProcess = null;
    broadcast(session, { type: 'session', session: serializeSession(session) });
  });
}

function restartSession(session) {
  stopSession(session);
  startSession(session);
}

function stopSession(session) {
  if (!session.ptyProcess) {
    return;
  }

  try {
    session.ptyProcess.kill('SIGTERM');
  } catch (_error) {
    // Ignore teardown races.
  }

  session.ptyProcess = null;
  session.pid = null;
  session.status = 'restarting';
  broadcast(session, { type: 'session', session: serializeSession(session) });
}

function destroySession(session) {
  stopSession(session);
  for (const socket of session.clients) {
    socket.close(1000, 'Session removed');
  }
  session.clients.clear();
}

function listSessions() {
  return [...sessions.values()]
    .sort((left, right) => left.index - right.index)
    .map(serializeSession);
}

function serializeSession(session) {
  return {
    id: session.id,
    index: session.index,
    name: session.name,
    workspace: session.workspace,
    model: session.model,
    sandbox: session.sandbox,
    approval: session.approval,
    status: session.status,
    pid: session.pid,
    cols: session.cols,
    rows: session.rows,
    exitCode: session.exitCode,
    generation: session.generation,
  };
}

function broadcast(session, payload) {
  const encoded = JSON.stringify(payload);
  for (const socket of session.clients) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(encoded);
    }
  }
}

function clamp(value, min, max) {
  if (Number.isNaN(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}

function shutdown() {
  for (const session of sessions.values()) {
    destroySession(session);
  }
  wss.close(() => {
    server.close(() => process.exit(0));
  });
}
