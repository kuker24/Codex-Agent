const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const ROOT_DIR = path.resolve(__dirname, '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '4343', 10);
const DEFAULT_WORKSPACE = path.resolve(process.env.SWARM_WORKSPACE || process.env.CODEX_WORKSPACE || process.cwd());
const DEFAULT_OBJECTIVE = String(process.env.SWARM_OBJECTIVE || '').trim();
const DEFAULT_MODEL = String(process.env.CODEX_MODEL || '').trim();
const DEFAULT_FAST_MODEL = String(process.env.SWARM_FAST_DEFAULT_MODEL || 'gpt-5.4-mini').trim();
const DEFAULT_SANDBOX = String(process.env.CODEX_SANDBOX || 'workspace-write').trim() || 'workspace-write';
const DEFAULT_PROFILE = String(process.env.SWARM_PROFILE || 'adaptive').trim() || 'adaptive';
const DEFAULT_SEARCH = toBoolean(process.env.SWARM_SEARCH || '0');
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const ALLOW_REMOTE_CONTROL = process.env.AI_AGENT_ALLOW_REMOTE === '1';
const CONTROL_TOKEN_HEADER = 'x-ai-agent-token';
const CONTROL_TOKEN = String(process.env.AI_AGENT_TOKEN || crypto.randomBytes(24).toString('base64url'));
const WORKSPACE_BOUNDARY_CONFIG = process.env.SWARM_WORKSPACE_BOUNDARIES || [DEFAULT_WORKSPACE, os.homedir()].join(path.delimiter);
const WORKSPACE_BOUNDARIES = resolveWorkspaceBoundaries(WORKSPACE_BOUNDARY_CONFIG);
const ALLOWED_SANDBOXES = new Set(['read-only', 'workspace-write']);
const PROFILES_PATH = path.join(ROOT_DIR, 'config', 'swarm-profiles.json');
const WORKSPACE_STATE_PATH = path.join(os.homedir(), '.local', 'state', 'ai-agent-hub', 'workspace-state.json');
const SKILLS_ROOT = path.join(os.homedir(), '.agents', 'skills');
const MAX_EVENTS = 180;
const MAX_LOG_LINES = 180;
const MAX_LOG_CHARS = 2400;

class SwarmAbortError extends Error {}

if (!fs.existsSync(DEFAULT_WORKSPACE) || !fs.statSync(DEFAULT_WORKSPACE).isDirectory()) {
  throw new Error(`Workspace tidak valid: ${DEFAULT_WORKSPACE}`);
}

if (process.env.CODEX_ALLOW_DANGER_SANDBOX === '1') {
  ALLOWED_SANDBOXES.add('danger-full-access');
}

if (WORKSPACE_BOUNDARIES.length === 0) {
  throw new Error('No valid swarm workspace boundary configured.');
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();
const profiles = loadProfiles();
const skillCatalog = loadSkillCatalog();
let currentRun = null;

app.use(express.json({ limit: '2mb' }));
app.use('/assets', express.static(path.join(ROOT_DIR, 'public')));

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
    codexBinary: CODEX_BIN,
    defaults: buildDefaults(),
    activeRun: serializeRun(currentRun, { includeLogs: false }),
    skillCount: skillCatalog.length,
    constraints: buildClientConstraints(),
  });
});

app.get('/api/bootstrap', requireLocalRequest, (req, res) => {
  res.json({
    ok: true,
    defaults: buildDefaults(),
    profiles,
    skillCatalog,
    workspaces: loadWorkspaceOptions(),
    activeRun: serializeRun(currentRun, { includeLogs: true }),
    auth: {
      header: CONTROL_TOKEN_HEADER,
      token: CONTROL_TOKEN,
    },
    constraints: buildClientConstraints(),
  });
});

app.post('/api/swarm/start', requireControlAccess, async (req, res) => {
  try {
    const payload = normalizeStartPayload(req.body || {});
    if (currentRun && ['queued', 'running', 'stopping'].includes(currentRun.status)) {
      await stopRun(currentRun, 'replaced-by-new-run');
    }
    const run = createRun(payload);
    currentRun = run;
    broadcast({ type: 'run', run: serializeRun(run) });
    queueMicrotask(() => {
      executeSwarm(run).catch((error) => failRun(run, error));
    });
    res.json({ ok: true, run: serializeRun(run) });
  } catch (error) {
    res.status(400).json({ ok: false, error: error.message });
  }
});

app.post('/api/swarm/:id/stop', requireControlAccess, async (req, res) => {
  if (!currentRun || currentRun.id !== req.params.id) {
    res.status(404).json({ ok: false, error: 'Run tidak ditemukan.' });
    return;
  }

  await stopRun(currentRun, 'stopped-by-user');
  res.json({ ok: true, run: serializeRun(currentRun) });
});

app.get('/', (_req, res) => {
  res.sendFile(path.join(ROOT_DIR, 'public', 'swarm.html'));
});

wss.on('connection', (socket, req) => {
  if (!isLocalRequest(req) || !isAllowedOriginHeader(req.headers.origin, req) || !hasValidControlToken(req)) {
    socket.close(1008, 'Unauthorized');
    return;
  }
  clients.add(socket);
  socket.send(JSON.stringify({
    type: 'bootstrap',
    payload: {
      defaults: buildDefaults(),
      profiles,
      skillCatalog,
      workspaces: loadWorkspaceOptions(),
      run: serializeRun(currentRun, { includeLogs: true }),
    },
  }));

  socket.on('close', () => {
    clients.delete(socket);
  });
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, HOST, () => {
  console.log(`Agent Swarm listening on http://${HOST}:${PORT}`);
  if (DEFAULT_OBJECTIVE) {
    startDefaultRun().catch((error) => {
      console.error(error);
    });
  }
});

function buildDefaults() {
  return {
    objective: DEFAULT_OBJECTIVE,
    workspace: normalizeWorkspacePath(DEFAULT_WORKSPACE),
    model: DEFAULT_MODEL || DEFAULT_FAST_MODEL,
    sandbox: normalizeSandbox(DEFAULT_SANDBOX),
    profile: DEFAULT_PROFILE,
    searchEnabled: DEFAULT_SEARCH,
  };
}

async function startDefaultRun() {
  if (currentRun) {
    return;
  }
  const run = createRun(buildDefaults());
  currentRun = run;
  broadcast({ type: 'run', run: serializeRun(run) });
  await executeSwarm(run);
}

function toBoolean(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function buildClientConstraints() {
  return {
    workspaceBoundaries: WORKSPACE_BOUNDARIES,
    sandboxes: [...ALLOWED_SANDBOXES],
  };
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

function isWorkspaceCandidateAllowed(rawWorkspace) {
  try {
    normalizeWorkspacePath(rawWorkspace);
    return true;
  } catch (_error) {
    return false;
  }
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

function loadProfiles() {
  return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8'));
}

function loadWorkspaceOptions() {
  if (!fs.existsSync(WORKSPACE_STATE_PATH)) {
    return [];
  }

  try {
    const payload = JSON.parse(fs.readFileSync(WORKSPACE_STATE_PATH, 'utf8'));
    const items = Array.isArray(payload.workspaces) ? payload.workspaces : [];
    return items
      .filter((item) => item && typeof item.path === 'string' && isWorkspaceCandidateAllowed(item.path))
      .map((item) => ({
        path: normalizeWorkspacePath(item.path),
        favorite: Boolean(item.favorite),
        useCount: Number.parseInt(String(item.use_count || 0), 10) || 0,
        lastUsedAt: String(item.last_used_at || ''),
      }))
      .sort((left, right) => {
        if (left.favorite !== right.favorite) {
          return left.favorite ? -1 : 1;
        }
        return String(right.lastUsedAt).localeCompare(String(left.lastUsedAt));
      })
      .slice(0, 40);
  } catch (_error) {
    return [];
  }
}

function loadSkillCatalog() {
  if (!fs.existsSync(SKILLS_ROOT)) {
    return [];
  }

  const stack = [SKILLS_ROOT];
  const found = [];
  const seen = new Set();

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() || entry.name !== 'SKILL.md') {
        continue;
      }
      const parsed = parseSkillFile(fullPath);
      if (!parsed || seen.has(parsed.name)) {
        continue;
      }
      seen.add(parsed.name);
      found.push(parsed);
    }
  }

  return found.sort((left, right) => left.name.localeCompare(right.name));
}

function parseSkillFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const frontMatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const frontMatter = frontMatterMatch ? frontMatterMatch[1] : '';
  const name = frontMatter.match(/^name:\s*"?(.+?)"?$/m)?.[1]?.trim();
  const description = frontMatter.match(/^description:\s*"?(.+?)"?$/m)?.[1]?.trim();
  if (!name || !description) {
    return null;
  }
  return {
    name,
    description,
    path: filePath,
  };
}

function normalizeStartPayload(input) {
  const objective = String(input.objective || '').trim();
  const workspace = normalizeWorkspacePath(String(input.workspace || DEFAULT_WORKSPACE));
  const model = String(input.model || DEFAULT_MODEL || DEFAULT_FAST_MODEL).trim();
  const sandbox = normalizeSandbox(String(input.sandbox || DEFAULT_SANDBOX));
  const profile = String(input.profile || DEFAULT_PROFILE).trim() || DEFAULT_PROFILE;
  const searchEnabled = toBoolean(input.searchEnabled);

  if (!objective) {
    throw new Error('Objective swarm wajib diisi.');
  }
  if (!profiles[profile]) {
    throw new Error(`Profile swarm tidak dikenal: ${profile}`);
  }
  return { objective, workspace, model, sandbox, profile, searchEnabled };
}

function createRun(config) {
  const profile = profiles[config.profile];
  const run = {
    id: crypto.randomUUID(),
    objective: config.objective,
    workspace: config.workspace,
    model: config.model,
    sandbox: config.sandbox,
    profileId: config.profile,
    profileLabel: profile.label,
    searchEnabled: config.searchEnabled,
    status: 'queued',
    phase: 'queued',
    startedAt: '',
    endedAt: '',
    events: [],
    selectedSkills: [],
    plan: null,
    finalReport: null,
    activeProcesses: new Map(),
    agents: new Map(),
    abortRequested: false,
  };

  for (const role of profile.roles) {
    run.agents.set(role.id, {
      id: role.id,
      title: role.title,
      purpose: role.purpose,
      preferredSkills: Array.isArray(role.preferredSkills) ? role.preferredSkills : [],
      selectedSkills: [],
      sandbox: role.defaultSandbox === 'workspace-write' ? config.sandbox : 'read-only',
      status: 'idle',
      phase: 'pending',
      threadId: '',
      exitCode: null,
      startedAt: '',
      endedAt: '',
      workspace: config.workspace,
      result: null,
      logs: [],
      summary: '',
    });
  }

  return run;
}

function serializeRun(run, options = {}) {
  if (!run) {
    return null;
  }
  const includeLogs = Boolean(options.includeLogs);
  return {
    id: run.id,
    objective: run.objective,
    workspace: run.workspace,
    model: run.model,
    sandbox: run.sandbox,
    profileId: run.profileId,
    profileLabel: run.profileLabel,
    searchEnabled: run.searchEnabled,
    status: run.status,
    phase: run.phase,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    selectedSkills: run.selectedSkills,
    plan: run.plan,
    finalReport: run.finalReport,
    events: run.events,
    agents: Array.from(run.agents.values()).map((agent) => serializeAgent(agent, { includeLogs })),
  };
}

function serializeAgent(agent, options = {}) {
  const includeLogs = Boolean(options.includeLogs);
  return {
    id: agent.id,
    title: agent.title,
    purpose: agent.purpose,
    preferredSkills: agent.preferredSkills,
    selectedSkills: agent.selectedSkills,
    sandbox: agent.sandbox,
    status: agent.status,
    phase: agent.phase,
    threadId: agent.threadId,
    exitCode: agent.exitCode,
    startedAt: agent.startedAt,
    endedAt: agent.endedAt,
    workspace: agent.workspace,
    summary: agent.summary,
    result: agent.result,
    logs: includeLogs ? agent.logs : [],
  };
}

function broadcast(payload) {
  const raw = JSON.stringify(payload);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(raw);
    }
  }
}

function pushEvent(run, event) {
  const normalized = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    ...event,
  };
  run.events = [...run.events, normalized].slice(-MAX_EVENTS);
  broadcast({ type: 'event', runId: run.id, event: normalized });
}

function updateAgent(run, agentId, patch) {
  const agent = run.agents.get(agentId);
  if (!agent) {
    throw new Error(`Unknown agent: ${agentId}`);
  }
  Object.assign(agent, patch);
  broadcast({ type: 'agent', runId: run.id, agent: serializeAgent(agent, { includeLogs: false }) });
  return agent;
}

function appendAgentLog(run, agentId, kind, text) {
  const agent = run.agents.get(agentId);
  if (!agent) {
    return;
  }
  const entry = {
    id: crypto.randomUUID(),
    at: new Date().toISOString(),
    kind,
    text: trimText(String(text || ''), MAX_LOG_CHARS),
  };
  agent.logs = [...agent.logs, entry].slice(-MAX_LOG_LINES);
  broadcast({ type: 'agent-log', runId: run.id, agentId, entry });
}

function trimText(value, maxChars) {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}\n...[truncated]`;
}

function enterPhase(run, phase, title) {
  run.phase = phase;
  if (!run.startedAt) {
    run.startedAt = new Date().toISOString();
  }
  pushEvent(run, {
    kind: 'phase',
    phase,
    title,
    body: '',
  });
  broadcast({ type: 'run', run: serializeRun(run) });
}

async function executeSwarm(run) {
  assertNotAborted(run);
  run.status = 'running';
  run.startedAt = new Date().toISOString();
  pushEvent(run, {
    kind: 'run-status',
    phase: 'queued',
    title: 'Swarm aktif',
    body: `${run.profileLabel} dimulai di ${run.workspace}`,
  });
  broadcast({ type: 'run', run: serializeRun(run) });

  enterPhase(run, 'plan', 'Swarm Lead menyusun plan otonom.');
  const skillSummary = summarizeSkills(skillCatalog);
  const plan = await executeAgentTask(run, {
    agentId: 'lead',
    phase: 'plan',
    mailboxTitle: 'Mission planning',
    mailboxBody: `Objective: ${run.objective}`,
    sandbox: 'read-only',
    schema: buildPlanSchema(),
    prompt: buildLeadPlanPrompt(run, skillSummary),
  });
  run.plan = safeJsonParse(plan.outputText);
  updateAgent(run, 'lead', { summary: run.plan?.mission_summary || 'Plan selesai.' });
  run.selectedSkills = normalizeSelectedSkills(run.plan?.candidate_skills || [], skillCatalog);
  broadcast({ type: 'run', run: serializeRun(run) });

  assertNotAborted(run);
  enterPhase(run, 'discovery', 'Repo Mapper dan Skill Router berjalan paralel.');
  pushEvent(run, {
    kind: 'mail',
    phase: 'discovery',
    agentId: 'lead',
    to: 'scout',
    title: 'Discovery brief',
    body: run.plan?.scout_brief || 'Petakan repository, constraint, dan risk surface.',
  });
  pushEvent(run, {
    kind: 'mail',
    phase: 'discovery',
    agentId: 'lead',
    to: 'router',
    title: 'Skill routing brief',
    body: run.plan?.router_brief || 'Pilih skill terbaik untuk mission aktif.',
  });

  const [scout, router] = await Promise.all([
    executeAgentTask(run, {
      agentId: 'scout',
      phase: 'discovery',
      mailboxTitle: 'Repo discovery',
      mailboxBody: run.plan?.scout_brief || 'Petakan workspace dan resiko utama.',
      sandbox: 'read-only',
      schema: buildScoutSchema(),
      prompt: buildScoutPrompt(run),
    }),
    executeAgentTask(run, {
      agentId: 'router',
      phase: 'discovery',
      mailboxTitle: 'Skill routing',
      mailboxBody: run.plan?.router_brief || 'Pilih skill terbaik untuk objective ini.',
      sandbox: 'read-only',
      schema: buildSkillRouterSchema(),
      prompt: buildSkillRouterPrompt(run, skillSummary),
    }),
  ]);

  const scoutData = safeJsonParse(scout.outputText);
  const routerData = safeJsonParse(router.outputText);
  applyRoutedSkills(run, routerData);
  updateAgent(run, 'scout', { summary: scoutData?.overview || 'Discovery selesai.' });
  updateAgent(run, 'router', { summary: routerData?.confidence || 'Skill routing selesai.' });
  broadcast({ type: 'run', run: serializeRun(run) });

  const shouldBuild = run.profileId === 'adaptive' && Boolean(run.plan?.implementation_required);

  if (shouldBuild) {
    assertNotAborted(run);
    enterPhase(run, 'build', 'Builder mengeksekusi objective utama.');
    pushEvent(run, {
      kind: 'mail',
      phase: 'build',
      agentId: 'lead',
      to: 'builder',
      title: 'Implementation brief',
      body: run.plan?.builder_brief || 'Implementasikan objective utama dengan perubahan minimal yang aman.',
    });

    const builder = await executeAgentTask(run, {
      agentId: 'builder',
      phase: 'build',
      mailboxTitle: 'Implementation',
      mailboxBody: run.plan?.builder_brief || 'Implementasikan objective utama.',
      sandbox: run.sandbox,
      schema: buildBuilderSchema(),
      prompt: buildBuilderPrompt(run, scoutData, routerData),
    });

    const builderData = safeJsonParse(builder.outputText);
    updateAgent(run, 'builder', { summary: builderData?.summary || 'Builder selesai.' });
    run.builder = builderData;
  }

  assertNotAborted(run);
  enterPhase(run, 'review', 'Verifier memeriksa hasil swarm.');
  pushEvent(run, {
    kind: 'mail',
    phase: 'review',
    agentId: 'lead',
    to: 'reviewer',
    title: 'Verification brief',
    body: run.plan?.reviewer_brief || 'Review hasil builder, regression risk, dan evidence.',
  });

  const reviewer = await executeAgentTask(run, {
    agentId: 'reviewer',
    phase: 'review',
    mailboxTitle: 'Verification',
    mailboxBody: run.plan?.reviewer_brief || 'Review hasil swarm dan cek residual risk.',
    sandbox: 'read-only',
    schema: buildReviewerSchema(),
    prompt: buildReviewerPrompt(run, scoutData, routerData),
  });

  const reviewerData = safeJsonParse(reviewer.outputText);
  updateAgent(run, 'reviewer', { summary: reviewerData?.verdict || 'Review selesai.' });

  assertNotAborted(run);
  enterPhase(run, 'synthesis', 'Swarm Lead menyusun synthesis akhir.');
  const finalLead = await executeAgentTask(run, {
    agentId: 'lead',
    phase: 'synthesis',
    mailboxTitle: 'Final synthesis',
    mailboxBody: 'Gabungkan seluruh temuan dan hasil eksekusi menjadi satu jalur rekomendasi.',
    sandbox: 'read-only',
    schema: buildFinalSchema(),
    prompt: buildFinalPrompt(run, scoutData, routerData, reviewerData),
  });

  run.finalReport = safeJsonParse(finalLead.outputText);
  updateAgent(run, 'lead', { summary: run.finalReport?.executive_summary || 'Synthesis selesai.' });
  run.status = 'completed';
  run.endedAt = new Date().toISOString();
  pushEvent(run, {
    kind: 'run-status',
    phase: 'synthesis',
    title: 'Swarm selesai',
    body: run.finalReport?.executive_summary || 'Semua phase selesai dieksekusi.',
  });
  broadcast({ type: 'run', run: serializeRun(run) });
}

async function stopRun(run, reason) {
  run.abortRequested = true;
  run.status = 'stopping';
  pushEvent(run, {
    kind: 'run-status',
    phase: run.phase,
    title: 'Stop requested',
    body: reason,
  });
  broadcast({ type: 'run', run: serializeRun(run) });

  const children = Array.from(run.activeProcesses.values());
  for (const child of children) {
    try {
      child.kill('SIGTERM');
    } catch (_error) {
      // ignore
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 350));

  for (const child of children) {
    try {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    } catch (_error) {
      // ignore
    }
  }

  run.status = 'stopped';
  run.endedAt = new Date().toISOString();
  broadcast({ type: 'run', run: serializeRun(run) });
}

function failRun(run, error) {
  if (error instanceof SwarmAbortError || run.abortRequested) {
    run.status = 'stopped';
    run.endedAt ||= new Date().toISOString();
    broadcast({ type: 'run', run: serializeRun(run) });
    return;
  }
  console.error(error);
  run.status = 'failed';
  run.endedAt = new Date().toISOString();
  pushEvent(run, {
    kind: 'run-status',
    phase: run.phase,
    title: 'Swarm gagal',
    body: error.message || String(error),
  });
  broadcast({ type: 'run', run: serializeRun(run) });
}

function assertNotAborted(run) {
  if (run.abortRequested) {
    throw new SwarmAbortError('Swarm dihentikan.');
  }
}

async function executeAgentTask(run, options) {
  assertNotAborted(run);
  const agent = updateAgent(run, options.agentId, {
    status: 'running',
    phase: options.phase,
    startedAt: new Date().toISOString(),
    endedAt: '',
    exitCode: null,
    result: null,
  });

  pushEvent(run, {
    kind: 'agent-status',
    phase: options.phase,
    agentId: options.agentId,
    title: `${agent.title} aktif`,
    body: options.mailboxTitle,
  });

  appendAgentLog(run, options.agentId, 'prompt', options.prompt);

  const outputPath = path.join(os.tmpdir(), `swarm-${run.id}-${options.agentId}-output.txt`);
  const schemaPath = options.schema ? writeTempJson(`swarm-schema-${run.id}-${options.agentId}`, options.schema) : null;
  const args = [];

  if (run.searchEnabled) {
    args.push('--search');
  }

  args.push(
    'exec',
    '--json',
    '--ephemeral',
    '--skip-git-repo-check',
    '-C',
    run.workspace,
    '-s',
    options.sandbox,
    '--color',
    'never',
    '-o',
    outputPath,
  );

  if (run.model) {
    args.push('--model', run.model);
  }
  if (schemaPath) {
    args.push('--output-schema', schemaPath);
  }

  args.push('-');

  const child = spawn(CODEX_BIN, args, {
    cwd: run.workspace,
    env: {
      ...process.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  run.activeProcesses.set(options.agentId, child);

  const stdoutLines = consumeStream(run, options.agentId, child.stdout, 'json');
  const stderrLines = consumeStream(run, options.agentId, child.stderr, 'stderr');
  child.stdin.write(options.prompt);
  child.stdin.end();

  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 0));
  });

  run.activeProcesses.delete(options.agentId);
  await Promise.all([stdoutLines, stderrLines]);

  const outputText = fs.existsSync(outputPath) ? fs.readFileSync(outputPath, 'utf8').trim() : '';
  fs.rmSync(outputPath, { force: true });
  if (schemaPath) {
    fs.rmSync(schemaPath, { force: true });
  }

  const aborted = run.abortRequested;
  updateAgent(run, options.agentId, {
    status: aborted ? 'stopped' : exitCode === 0 ? 'completed' : 'failed',
    endedAt: new Date().toISOString(),
    exitCode,
    result: outputText,
  });

  if (aborted) {
    throw new SwarmAbortError('Swarm dihentikan.');
  }

  pushEvent(run, {
    kind: 'agent-result',
    phase: options.phase,
    agentId: options.agentId,
    title: `${agent.title} selesai`,
    body: outputText ? trimText(outputText, 1600) : `Exit code ${exitCode}`,
  });

  if (exitCode !== 0) {
    throw new Error(`${agent.title} gagal dengan exit code ${exitCode}`);
  }

  return { outputText };
}

function consumeStream(run, agentId, stream, kind) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: stream });
    rl.on('line', (line) => {
      appendAgentLog(run, agentId, kind, line);
      if (kind !== 'json') {
        return;
      }
      handleCodexJsonEvent(run, agentId, line);
    });
    rl.once('close', resolve);
  });
}

function handleCodexJsonEvent(run, agentId, rawLine) {
  let payload;
  try {
    payload = JSON.parse(rawLine);
  } catch (_error) {
    return;
  }

  if (payload.type === 'thread.started' && payload.thread_id) {
    updateAgent(run, agentId, { threadId: payload.thread_id });
    return;
  }

  if (payload.type === 'turn.started') {
    pushEvent(run, {
      kind: 'codex-turn',
      phase: run.phase,
      agentId,
      title: `${run.agents.get(agentId)?.title || agentId} memulai turn`,
      body: '',
    });
    return;
  }

  if (payload.type === 'item.completed' && payload.item?.type === 'agent_message') {
    pushEvent(run, {
      kind: 'codex-message',
      phase: run.phase,
      agentId,
      title: `${run.agents.get(agentId)?.title || agentId} mengirim message`,
      body: trimText(payload.item.text || '', 1200),
    });
    return;
  }

  if (payload.type === 'turn.completed' && payload.usage) {
    pushEvent(run, {
      kind: 'codex-usage',
      phase: run.phase,
      agentId,
      title: `${run.agents.get(agentId)?.title || agentId} menyelesaikan turn`,
      body: `input ${payload.usage.input_tokens || 0} | output ${payload.usage.output_tokens || 0}`,
    });
  }
}

function summarizeSkills(catalog) {
  return catalog.map((item) => `- ${item.name}: ${item.description}`).join('\n');
}

function normalizeSelectedSkills(skills, catalog) {
  if (!Array.isArray(skills)) {
    return [];
  }
  const valid = new Set(catalog.map((item) => item.name));
  return skills
    .filter((item) => item && valid.has(item.name))
    .map((item) => ({
      name: item.name,
      reason: String(item.reason || '').trim(),
    }));
}

function applyRoutedSkills(run, routerData) {
  const routed = Array.isArray(routerData?.skills) ? routerData.skills : [];
  for (const item of routed) {
    const agentId = String(item.assigned_agent || '').trim();
    const agent = run.agents.get(agentId);
    if (!agent) {
      continue;
    }
    agent.selectedSkills = [...agent.selectedSkills, { name: item.name, why: item.why }];
  }
  run.selectedSkills = routed.map((item) => ({
    name: item.name,
    reason: item.why,
    assignedAgent: item.assigned_agent,
  }));
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_error) {
    return null;
  }
}

function writeTempJson(prefix, value) {
  const filePath = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  return filePath;
}

function buildLeadPlanPrompt(run, skillSummary) {
  return [
    'Anda adalah Swarm Lead untuk sistem agent swarm Codex yang full otonom.',
    'Tugas Anda adalah membuat rencana minimal yang aman, akurat, dan efektif.',
    '',
    `Objective utama: ${run.objective}`,
    `Workspace: ${run.workspace}`,
    `Profile swarm: ${run.profileLabel}`,
    '',
    'Katalog skill Codex yang tersedia:',
    skillSummary,
    '',
    'Aturan:',
    '- Gunakan hanya skill yang benar-benar relevan.',
    '- Jika objective butuh perubahan file, set implementation_required=true.',
    '- Jika objective bersifat audit/analisis/riset, set implementation_required=false.',
    '- Handoff harus spesifik, operasional, dan bisa dieksekusi agent lain tanpa ambigu.',
    '- Fokus pada satu jalur rekomendasi terbaik, bukan daftar opsi kabur.',
  ].join('\n');
}

function buildScoutPrompt(run) {
  return [
    'Anda adalah Repo Mapper di dalam Codex Agent Swarm.',
    'Petakan workspace secara pragmatis dan cari evidence yang paling relevan untuk objective.',
    '',
    `Objective: ${run.objective}`,
    `Workspace: ${run.workspace}`,
    `Lead brief: ${run.plan?.scout_brief || ''}`,
    '',
    'Aturan:',
    '- Kerja read-only.',
    '- Jangan membuat perubahan file.',
    '- Berikan path penting, constraint, resiko, dan saran next step yang bisa dipakai Builder atau Reviewer.',
  ].join('\n');
}

function buildSkillRouterPrompt(run, skillSummary) {
  return [
    'Anda adalah Skill Router untuk Codex Agent Swarm.',
    'Pilih skill Codex yang paling kuat untuk mission aktif dan jelaskan penugasannya per agent.',
    '',
    `Objective: ${run.objective}`,
    `Execution strategy dari lead: ${run.plan?.execution_strategy || ''}`,
    '',
    'Katalog skill Codex:',
    skillSummary,
    '',
    'Aturan:',
    '- Pilih skill sesedikit mungkin tapi cukup kuat.',
    '- Nama skill wajib persis sama dengan katalog.',
    '- assigned_agent harus salah satu dari: lead, scout, router, builder, reviewer.',
    '- Utamakan skill yang benar-benar memperbaiki akurasi dan otonomi swarm.',
  ].join('\n');
}

function buildBuilderPrompt(run, scoutData, routerData) {
  const routedSkills = Array.isArray(routerData?.skills)
    ? routerData.skills.map((item) => `- ${item.name} -> ${item.assigned_agent}: ${item.why}`).join('\n')
    : '- Tidak ada skill routing tambahan.';

  return [
    'Anda adalah Builder di dalam Codex Agent Swarm.',
    'Anda tidak sendirian di workspace. Jangan revert perubahan yang tidak Anda buat.',
    'Jika implementation_required=true, lakukan perubahan yang memang diperlukan langsung di workspace.',
    'Jika objective ternyata cukup dengan analisis, jangan ubah file dan buat rancangan yang tajam.',
    '',
    `Objective: ${run.objective}`,
    `Implementation required: ${Boolean(run.plan?.implementation_required)}`,
    `Execution strategy: ${run.plan?.execution_strategy || ''}`,
    `Builder brief: ${run.plan?.builder_brief || ''}`,
    '',
    'Repo mapping:',
    JSON.stringify(scoutData, null, 2),
    '',
    'Skill routing:',
    routedSkills,
    '',
    'Aturan:',
    '- Gunakan skill yang dirouting jika memang cocok.',
    '- Jalankan verifikasi minimal yang relevan jika Anda mengubah file.',
    '- Ringkas perubahan, file disentuh, command dijalankan, dan residual risk.',
  ].join('\n');
}

function buildReviewerPrompt(run, scoutData, routerData) {
  return [
    'Anda adalah Verifier di dalam Codex Agent Swarm.',
    'Lakukan review yang fokus pada correctness, regression risk, dan kekuatan evidence.',
    '',
    `Objective: ${run.objective}`,
    `Review brief: ${run.plan?.reviewer_brief || ''}`,
    '',
    'Repo mapping:',
    JSON.stringify(scoutData, null, 2),
    '',
    'Skill routing:',
    JSON.stringify(routerData, null, 2),
    '',
    'Builder result:',
    JSON.stringify(run.builder || null, null, 2),
    '',
    'Aturan:',
    '- Jika ada bug/regression risk, sebutkan secara langsung.',
    '- Jika evidence kurang, nyatakan apa yang belum terverifikasi.',
    '- Jangan menulis opini kosong tanpa basis.',
  ].join('\n');
}

function buildFinalPrompt(run, scoutData, routerData, reviewerData) {
  return [
    'Anda kembali menjadi Swarm Lead untuk synthesis akhir.',
    'Gabungkan semua evidence menjadi satu jalur rekomendasi yang koheren.',
    '',
    `Objective: ${run.objective}`,
    `Execution strategy: ${run.plan?.execution_strategy || ''}`,
    '',
    'Plan:',
    JSON.stringify(run.plan, null, 2),
    '',
    'Scout result:',
    JSON.stringify(scoutData, null, 2),
    '',
    'Skill router result:',
    JSON.stringify(routerData, null, 2),
    '',
    'Builder result:',
    JSON.stringify(run.builder || null, null, 2),
    '',
    'Reviewer result:',
    JSON.stringify(reviewerData, null, 2),
    '',
    'Aturan:',
    '- Akhiri dengan satu summary eksekusi yang jelas dan operasional.',
    '- Jika ada open risk, tulis terus terang.',
    '- Jika ada skill yang benar-benar dipakai, masukkan ke selected_skills.',
  ].join('\n');
}

function buildPlanSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'mission_summary',
      'execution_strategy',
      'implementation_required',
      'success_criteria',
      'risk_watchlist',
      'scout_brief',
      'router_brief',
      'builder_brief',
      'reviewer_brief',
      'candidate_skills',
    ],
    properties: {
      mission_summary: { type: 'string' },
      execution_strategy: { type: 'string' },
      implementation_required: { type: 'boolean' },
      success_criteria: { type: 'array', items: { type: 'string' } },
      risk_watchlist: { type: 'array', items: { type: 'string' } },
      scout_brief: { type: 'string' },
      router_brief: { type: 'string' },
      builder_brief: { type: 'string' },
      reviewer_brief: { type: 'string' },
      candidate_skills: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'reason'],
          properties: {
            name: { type: 'string' },
            reason: { type: 'string' },
          },
        },
      },
    },
  };
}

function buildScoutSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['overview', 'important_paths', 'risks', 'tests', 'suggested_steps'],
    properties: {
      overview: { type: 'string' },
      important_paths: { type: 'array', items: { type: 'string' } },
      risks: { type: 'array', items: { type: 'string' } },
      tests: { type: 'array', items: { type: 'string' } },
      suggested_steps: { type: 'array', items: { type: 'string' } },
    },
  };
}

function buildSkillRouterSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['skills', 'notes', 'confidence'],
    properties: {
      skills: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'why', 'assigned_agent'],
          properties: {
            name: { type: 'string' },
            why: { type: 'string' },
            assigned_agent: { type: 'string' },
          },
        },
      },
      notes: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string' },
    },
  };
}

function buildBuilderSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'did_write', 'files_touched', 'commands_run', 'evidence', 'open_risks'],
    properties: {
      summary: { type: 'string' },
      did_write: { type: 'boolean' },
      files_touched: { type: 'array', items: { type: 'string' } },
      commands_run: { type: 'array', items: { type: 'string' } },
      evidence: { type: 'array', items: { type: 'string' } },
      open_risks: { type: 'array', items: { type: 'string' } },
    },
  };
}

function buildReviewerSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict', 'findings', 'tests_checked', 'confidence'],
    properties: {
      verdict: { type: 'string' },
      findings: { type: 'array', items: { type: 'string' } },
      tests_checked: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string' },
    },
  };
}

function buildFinalSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['executive_summary', 'selected_skills', 'completed_work', 'open_risks', 'next_actions'],
    properties: {
      executive_summary: { type: 'string' },
      selected_skills: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'reason', 'assigned_agent'],
          properties: {
            name: { type: 'string' },
            reason: { type: 'string' },
            assigned_agent: { type: 'string' },
          },
        },
      },
      completed_work: { type: 'array', items: { type: 'string' } },
      open_risks: { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
    },
  };
}

async function shutdown() {
  if (currentRun && ['queued', 'running', 'stopping'].includes(currentRun.status)) {
    await stopRun(currentRun, 'server-shutdown');
  }
  process.exit(0);
}
