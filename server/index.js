const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
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
const ALLOW_REMOTE_CONTROL = process.env.AI_AGENT_ALLOW_REMOTE === '1';
const CONTROL_TOKEN_HEADER = 'x-ai-agent-token';
const CONTROL_TOKEN = String(process.env.AI_AGENT_TOKEN || crypto.randomBytes(24).toString('base64url'));
const WORKSPACE_BOUNDARY_CONFIG = process.env.CODEX_WORKSPACE_BOUNDARIES || [WORKSPACE_ROOT, os.homedir()].join(path.delimiter);
const WORKSPACE_BOUNDARIES = resolveWorkspaceBoundaries(WORKSPACE_BOUNDARY_CONFIG);
const ALLOWED_SANDBOXES = new Set(['read-only', 'workspace-write']);
const ALLOWED_APPROVALS = new Set(['never', 'on-request', 'on-failure', 'untrusted']);
const MAX_BUFFER_CHARS = 250_000;

if (!fs.existsSync(WORKSPACE_ROOT) || !fs.statSync(WORKSPACE_ROOT).isDirectory()) {
  throw new Error(`Workspace root does not exist or is not a directory: ${WORKSPACE_ROOT}`);
}

if (process.env.CODEX_ALLOW_DANGER_SANDBOX === '1') {
  ALLOWED_SANDBOXES.add('danger-full-access');
}

if (WORKSPACE_BOUNDARIES.length === 0) {
  throw new Error('No valid workspace boundary configured.');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const sessions = new Map();
const activeSettings = {
  panelCount: DEFAULT_PANEL_COUNT,
  workspace: normalizeWorkspacePath(WORKSPACE_ROOT),
  model: DEFAULT_MODEL,
  sandbox: normalizeSandbox(DEFAULT_SANDBOX),
  approval: normalizeApproval(DEFAULT_APPROVAL),
};

app.use(express.json());
app.use('/assets', express.static(path.join(__dirname, '..', 'public')));
app.use('/vendor/xterm', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'lib')));
app.use('/vendor/xterm-css', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'xterm', 'css')));
app.use('/vendor/xterm-fit', express.static(path.join(__dirname, '..', 'node_modules', '@xterm', 'addon-fit', 'lib')));

app.get('/api/health', (req, res) => {
  const basePayload = {
    ok: true,
    host: HOST,
    port: PORT,
    tokenRequired: true,
  };
  if (!hasValidControlToken(req)) {
    res.json(basePayload);
    return;
  }
  res.json({
    ...basePayload,
    codexBinary: resolveCodexBinary(),
    settings: activeSettings,
    sessions: listSessions(),
    constraints: buildClientConstraints(),
  });
});

app.get('/api/bootstrap', requireLocalRequest, (req, res) => {
  res.json({
    defaults: activeSettings,
    cwd: process.cwd(),
    codexBinary: resolveCodexBinary(),
    auth: {
      header: CONTROL_TOKEN_HEADER,
      token: CONTROL_TOKEN,
    },
    constraints: buildClientConstraints(),
  });
});

app.post('/api/sessions/sync', requireControlAccess, (req, res) => {
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

app.post('/api/sessions/restart-all', requireControlAccess, (_req, res) => {
  for (const session of sessions.values()) {
    restartSession(session);
  }
  res.json({ ok: true, sessions: listSessions() });
});

app.post('/api/sessions/:id/restart', requireControlAccess, (req, res) => {
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
  if (!isLocalRequest(req) || !isAllowedOriginHeader(req.headers.origin, req) || !hasValidControlToken(req)) {
    socket.close(1008, 'Unauthorized');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
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

function buildClientConstraints() {
  return {
    workspaceBoundaries: WORKSPACE_BOUNDARIES,
    sandboxes: [...ALLOWED_SANDBOXES],
    approvals: [...ALLOWED_APPROVALS],
  };
}

function normalizeSettings(input) {
  const panelCount = clamp(Number.parseInt(String(input.panelCount || activeSettings.panelCount), 10), 2, 6);
  const workspace = normalizeWorkspacePath(String(input.workspace || activeSettings.workspace || WORKSPACE_ROOT));
  const model = String(input.model || '').trim();
  const sandbox = normalizeSandbox(String(input.sandbox || activeSettings.sandbox || DEFAULT_SANDBOX));
  const approval = normalizeApproval(String(input.approval || activeSettings.approval || DEFAULT_APPROVAL));

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

function requireLocalRequest(req, res, next) {
  if (!isLocalRequest(req)) {
    res.status(403).json({ ok: false, error: 'Permintaan ditolak: hanya loopback yang diizinkan.' });
    return;
  }
  if (!isAllowedOriginHeader(req.headers.origin, req)) {
    res.status(403).json({ ok: false, error: 'Permintaan ditolak: origin tidak diizinkan.' });
    return;
  }
  next();
}

function requireControlAccess(req, res, next) {
  if (!isLocalRequest(req)) {
    res.status(403).json({ ok: false, error: 'Permintaan ditolak: hanya loopback yang diizinkan.' });
    return;
  }
  if (!isAllowedOriginHeader(req.headers.origin, req)) {
    res.status(403).json({ ok: false, error: 'Permintaan ditolak: origin tidak diizinkan.' });
    return;
  }
  if (!hasValidControlToken(req)) {
    res.status(401).json({ ok: false, error: 'Permintaan ditolak: token kontrol tidak valid.' });
    return;
  }
  next();
}

function hasValidControlToken(req) {
  const candidate = extractControlToken(req);
  return Boolean(candidate && candidate === CONTROL_TOKEN);
}

function extractControlToken(req) {
  const headerValue = req?.headers?.[CONTROL_TOKEN_HEADER];
  if (typeof headerValue === 'string' && headerValue.trim()) {
    return headerValue.trim();
  }
  if (Array.isArray(headerValue) && headerValue[0]) {
    return String(headerValue[0]).trim();
  }
  const authorization = req?.headers?.authorization;
  if (typeof authorization === 'string') {
    const match = authorization.match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  if (req?.query?.token) {
    return String(req.query.token).trim();
  }
  if (req?.url) {
    try {
      const url = new URL(req.url, `http://${req.headers?.host || `${HOST}:${PORT}`}`);
      const token = url.searchParams.get('token');
      if (token) {
        return token.trim();
      }
    } catch (_error) {
      return '';
    }
  }
  return '';
}

function isLocalRequest(req) {
  if (ALLOW_REMOTE_CONTROL) {
    return true;
  }
  return isLoopbackAddress(req?.socket?.remoteAddress || '');
}

function isLoopbackAddress(address) {
  if (!address) {
    return false;
  }
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function isAllowedOriginHeader(originHeader, req) {
  if (!originHeader) {
    return true;
  }
  let origin;
  try {
    origin = new URL(String(originHeader));
  } catch (_error) {
    return false;
  }
  if (!['http:', 'https:'].includes(origin.protocol)) {
    return false;
  }
  const hostHeader = String(req?.headers?.host || '').trim();
  const allowed = new Set([
    `http://127.0.0.1:${PORT}`,
    `https://127.0.0.1:${PORT}`,
    `http://localhost:${PORT}`,
    `https://localhost:${PORT}`,
    `http://[::1]:${PORT}`,
    `https://[::1]:${PORT}`,
  ]);
  if (hostHeader) {
    allowed.add(`http://${hostHeader}`);
    allowed.add(`https://${hostHeader}`);
  }
  if (HOST && HOST !== '0.0.0.0' && HOST !== '::') {
    const normalizedHost = HOST.includes(':') ? `[${HOST}]` : HOST;
    allowed.add(`http://${normalizedHost}:${PORT}`);
    allowed.add(`https://${normalizedHost}:${PORT}`);
  }
  return allowed.has(origin.origin);
}

function normalizeWorkspacePath(rawWorkspace) {
  const candidate = path.resolve(String(rawWorkspace || '').trim());
  if (!candidate || !fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`Workspace tidak valid: ${candidate}`);
  }
  const resolved = fs.realpathSync(candidate);
  const inBoundary = WORKSPACE_BOUNDARIES.some((boundary) => isPathInside(resolved, boundary));
  if (!inBoundary) {
    throw new Error(`Workspace di luar boundary yang diizinkan: ${resolved}`);
  }
  return resolved;
}

function resolveWorkspaceBoundaries(raw) {
  return [...new Set(String(raw || '')
    .split(path.delimiter)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item))
    .filter((item) => fs.existsSync(item) && fs.statSync(item).isDirectory())
    .map((item) => fs.realpathSync(item)))];
}

function isPathInside(targetPath, boundaryPath) {
  const relative = path.relative(boundaryPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function normalizeSandbox(rawValue) {
  const value = String(rawValue || '').trim() || 'workspace-write';
  if (!ALLOWED_SANDBOXES.has(value)) {
    throw new Error(`Sandbox tidak diizinkan: ${value}`);
  }
  return value;
}

function normalizeApproval(rawValue) {
  const value = String(rawValue || '').trim() || 'on-request';
  if (!ALLOWED_APPROVALS.has(value)) {
    throw new Error(`Approval mode tidak diizinkan: ${value}`);
  }
  return value;
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
