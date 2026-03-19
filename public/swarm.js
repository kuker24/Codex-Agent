const state = {
  defaults: null,
  profiles: {},
  skillCatalog: [],
  workspaces: [],
  run: null,
  socket: null,
  signals: [],
};

const form = document.getElementById('swarm-form');
const objectiveInput = document.getElementById('objective');
const workspaceInput = document.getElementById('workspace');
const workspaceOptions = document.getElementById('workspace-options');
const profileInput = document.getElementById('profile');
const modelInput = document.getElementById('model');
const sandboxInput = document.getElementById('sandbox');
const searchEnabledInput = document.getElementById('search-enabled');
const stopButton = document.getElementById('stop-run');
const runStatus = document.getElementById('run-status');
const runPhase = document.getElementById('run-phase');
const metricProfile = document.getElementById('metric-profile');
const metricWorkspace = document.getElementById('metric-workspace');
const metricSkills = document.getElementById('metric-skills');
const metricAgents = document.getElementById('metric-agents');
const phaseRail = document.getElementById('phase-rail');
const topologySvg = document.getElementById('topology-svg');
const topologyCaption = document.getElementById('topology-caption');
const skillBand = document.getElementById('skill-band');
const skillBandStatus = document.getElementById('skill-band-status');
const eventCounter = document.getElementById('event-counter');
const eventFeed = document.getElementById('event-feed');
const finalReport = document.getElementById('final-report');
const agentsGrid = document.getElementById('agents-grid');
const agentCardTemplate = document.getElementById('agent-card-template');

await bootstrap();
connectSocket();
requestAnimationFrame(animateTopology);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  await startSwarm();
});

stopButton.addEventListener('click', async () => {
  if (!state.run) {
    return;
  }
  await fetch(`/api/swarm/${encodeURIComponent(state.run.id)}/stop`, { method: 'POST' });
});

async function bootstrap() {
  const response = await fetch('/api/bootstrap');
  const payload = await response.json();
  state.defaults = payload.defaults;
  state.profiles = payload.profiles || {};
  state.skillCatalog = payload.skillCatalog || [];
  state.workspaces = payload.workspaces || [];
  state.run = payload.activeRun || null;
  hydrateForm();
  renderWorkspaceOptions();
  renderSkillBand();
  renderAll();
}

function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  state.socket = new WebSocket(`${protocol}://${window.location.host}/ws`);

  state.socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'bootstrap') {
      state.defaults = message.payload.defaults;
      state.profiles = message.payload.profiles || {};
      state.skillCatalog = message.payload.skillCatalog || [];
      state.workspaces = message.payload.workspaces || [];
      state.run = message.payload.run || null;
      hydrateForm();
      renderWorkspaceOptions();
      renderSkillBand();
      renderAll();
      return;
    }

    if (message.type === 'run') {
      state.run = message.run;
      renderAll();
      return;
    }

    if (message.type === 'event') {
      if (!state.run || state.run.id !== message.runId) {
        return;
      }
      upsertEvent(message.event);
      maybeCreateSignal(message.event);
      renderEventFeedPanel();
      renderTopologyStatic();
      return;
    }

    if (message.type === 'agent') {
      if (!state.run || state.run.id !== message.runId) {
        return;
      }
      upsertAgent(message.agent);
      renderAgents();
      renderMetrics();
      renderTopologyStatic();
      return;
    }

    if (message.type === 'agent-log') {
      if (!state.run || state.run.id !== message.runId) {
        return;
      }
      appendAgentLog(message.agentId, message.entry);
      renderAgents();
    }
  });

  state.socket.addEventListener('close', () => {
    window.setTimeout(connectSocket, 1000);
  });
}

function hydrateForm() {
  if (!state.defaults) {
    return;
  }
  objectiveInput.value = state.defaults.objective || '';
  workspaceInput.value = state.defaults.workspace || '';
  modelInput.value = state.defaults.model || '';
  sandboxInput.value = state.defaults.sandbox || 'workspace-write';
  searchEnabledInput.checked = Boolean(state.defaults.searchEnabled);

  profileInput.innerHTML = '';
  for (const [id, profile] of Object.entries(state.profiles)) {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = `${profile.label} · ${profile.description}`;
    if (id === state.defaults.profile) {
      option.selected = true;
    }
    profileInput.append(option);
  }
}

function renderWorkspaceOptions() {
  workspaceOptions.innerHTML = '';
  for (const item of state.workspaces) {
    const option = document.createElement('option');
    option.value = item.path;
    workspaceOptions.append(option);
  }
}

async function startSwarm() {
  const payload = {
    objective: objectiveInput.value.trim(),
    workspace: workspaceInput.value.trim(),
    model: modelInput.value.trim(),
    sandbox: sandboxInput.value,
    profile: profileInput.value,
    searchEnabled: searchEnabledInput.checked,
  };

  const response = await fetch('/api/swarm/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) {
    runStatus.textContent = result.error || 'Gagal menjalankan swarm.';
    return;
  }
  state.run = result.run;
  state.signals = [];
  renderAll();
}

function renderAll() {
  renderMetrics();
  renderPhaseRail();
  renderSkillBand();
  renderEventFeedPanel();
  renderFinalPanel();
  renderAgents();
  renderTopologyStatic();
  stopButton.disabled = !state.run || ['completed', 'failed', 'stopped'].includes(state.run.status);
}

function renderMetrics() {
  if (!state.run) {
    runStatus.textContent = 'Idle';
    runPhase.textContent = 'Menunggu objective.';
    metricProfile.textContent = '-';
    metricWorkspace.textContent = '-';
    metricSkills.textContent = String(state.skillCatalog.length);
    metricAgents.textContent = '0';
    topologyCaption.textContent = 'Belum ada run aktif.';
    return;
  }

  runStatus.textContent = formatStatus(state.run.status);
  runPhase.textContent = formatPhase(state.run.phase);
  metricProfile.textContent = state.run.profileLabel;
  metricWorkspace.textContent = basename(state.run.workspace);
  metricSkills.textContent = `${state.run.selectedSkills?.length || 0} selected / ${state.skillCatalog.length} installed`;
  metricAgents.textContent = String(state.run.agents?.length || 0);
  topologyCaption.textContent = `${state.run.objective.slice(0, 120)}${state.run.objective.length > 120 ? '…' : ''}`;
}

function renderPhaseRail() {
  phaseRail.innerHTML = '';
  const phases = state.run ? resolvePhaseList(state.run) : ['plan', 'discovery', 'build', 'review', 'synthesis'];
  const currentIndex = phases.indexOf(state.run?.phase || '');
  for (const [index, phase] of phases.entries()) {
    const pill = document.createElement('div');
    pill.className = 'phase-pill';
    if (index < currentIndex) {
      pill.classList.add('done');
    }
    if (phase === state.run?.phase) {
      pill.classList.add('active');
    }
    pill.textContent = formatPhase(phase);
    phaseRail.append(pill);
  }
}

function renderSkillBand() {
  const selected = new Set((state.run?.selectedSkills || []).map((item) => item.name));
  skillBand.innerHTML = '';
  const visibleSkills = state.skillCatalog.slice(0, 42);
  for (const item of visibleSkills) {
    const chip = document.createElement('div');
    chip.className = 'skill-chip';
    if (selected.has(item.name)) {
      chip.classList.add('selected');
    }
    chip.title = item.description;
    chip.textContent = item.name;
    skillBand.append(chip);
  }
  skillBandStatus.textContent = state.run
    ? `${state.run.selectedSkills?.length || 0} skill dipilih aktif untuk mission ini.`
    : 'Skill catalog dimuat dari instalasi lokal Codex Anda.';
}

function renderEventFeedPanel() {
  eventFeed.innerHTML = '';
  const events = state.run?.events || [];
  eventCounter.textContent = `${events.length} event`;
  if (events.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Communication stream akan muncul setelah swarm berjalan.';
    eventFeed.append(empty);
    return;
  }

  const latest = [...events].slice(-60).reverse();
  for (const event of latest) {
    const item = document.createElement('article');
    item.className = 'event-item';
    item.innerHTML = `
      <div class="event-item__meta">
        <span>${formatEventKind(event.kind)}</span>
        <span>${formatTime(event.at)}</span>
      </div>
      <h3 class="event-item__title">${escapeHtml(event.title || '')}</h3>
      <p class="event-item__body">${escapeHtml(event.body || '')}</p>
    `;
    eventFeed.append(item);
  }
}

function renderFinalPanel() {
  if (!state.run?.finalReport) {
    finalReport.textContent = 'Belum ada synthesis.';
    return;
  }
  finalReport.textContent = JSON.stringify(state.run.finalReport, null, 2);
}

function renderAgents() {
  agentsGrid.innerHTML = '';
  const agents = state.run?.agents || [];
  if (agents.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.textContent = 'Agent cards akan muncul saat swarm aktif.';
    agentsGrid.append(empty);
    return;
  }

  for (const agent of agents) {
    const fragment = agentCardTemplate.content.cloneNode(true);
    fragment.querySelector('.agent-role').textContent = agent.id;
    fragment.querySelector('.agent-title').textContent = agent.title;
    fragment.querySelector('.agent-card__summary').textContent = agent.summary || agent.purpose || 'Belum ada summary.';
    fragment.querySelector('.agent-thread').textContent = agent.threadId ? `thread ${agent.threadId}` : 'thread belum tersedia';
    fragment.querySelector('.agent-status-text').textContent = formatStatus(agent.status);
    fragment.querySelector('.agent-status-dot').classList.add(agent.status);

    const skillsHost = fragment.querySelector('.agent-skills');
    const chosenSkills = agent.selectedSkills?.length ? agent.selectedSkills : (agent.preferredSkills || []).map((name) => ({ name }));
    for (const skill of chosenSkills) {
      const chip = document.createElement('div');
      chip.className = 'agent-skill-chip';
      chip.textContent = skill.name || skill;
      skillsHost.append(chip);
    }

    fragment.querySelector('.agent-result').textContent = agent.result || 'Belum ada output akhir.';
    fragment.querySelector('.agent-log').textContent = (agent.logs || []).map((entry) => `[${formatTime(entry.at)}] ${entry.kind}\n${entry.text}`).join('\n\n') || 'Belum ada raw log.';
    agentsGrid.append(fragment);
  }
}

function renderTopologyStatic() {
  if (!state.run) {
    topologySvg.innerHTML = '';
    return;
  }

  const agents = state.run.agents || [];
  const positions = resolvePositions(agents);
  const links = resolveLinks(agents);
  const now = performance.now();
  state.signals = state.signals.filter((signal) => now - signal.startedAt < signal.duration);

  const edgeMarkup = links.map((link) => {
    const from = positions.get(link.from);
    const to = positions.get(link.to);
    return `<line class="edge" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`;
  }).join('');

  const signalMarkup = state.signals.map((signal) => {
    const from = positions.get(signal.from);
    const to = positions.get(signal.to);
    if (!from || !to) {
      return '';
    }
    const progress = Math.min(1, (now - signal.startedAt) / signal.duration);
    const x = from.x + ((to.x - from.x) * progress);
    const y = from.y + ((to.y - from.y) * progress);
    return `<circle class="signal" cx="${x}" cy="${y}" r="5.6" />`;
  }).join('');

  const nodeMarkup = agents.map((agent) => {
    const point = positions.get(agent.id);
    return `
      <g class="node ${agent.status}" transform="translate(${point.x}, ${point.y})">
        <circle r="46"></circle>
        <text class="label" y="-4">${escapeHtml(agent.title)}</text>
        <text class="status" y="18">${escapeHtml(formatStatus(agent.status))}</text>
      </g>
    `;
  }).join('');

  topologySvg.innerHTML = `${edgeMarkup}${signalMarkup}${nodeMarkup}`;
}

function animateTopology() {
  renderTopologyStatic();
  requestAnimationFrame(animateTopology);
}

function resolveLinks(agents) {
  const ids = agents.map((agent) => agent.id);
  const links = [];
  for (const id of ids) {
    if (id === 'lead') {
      continue;
    }
    links.push({ from: 'lead', to: id });
  }
  if (ids.includes('builder') && ids.includes('reviewer')) {
    links.push({ from: 'builder', to: 'reviewer' });
  }
  return links;
}

function resolvePositions(agents) {
  const map = new Map();
  const points = {
    lead: { x: 410, y: 88 },
    scout: { x: 175, y: 210 },
    router: { x: 645, y: 210 },
    builder: { x: 255, y: 340 },
    reviewer: { x: 565, y: 340 },
  };

  agents.forEach((agent, index) => {
    map.set(agent.id, points[agent.id] || { x: 160 + (index * 140), y: 340 });
  });
  return map;
}

function upsertEvent(event) {
  state.run.events = state.run.events || [];
  const index = state.run.events.findIndex((item) => item.id === event.id);
  if (index >= 0) {
    state.run.events[index] = event;
  } else {
    state.run.events.push(event);
    state.run.events = state.run.events.slice(-300);
  }
}

function maybeCreateSignal(event) {
  if (!state.run) {
    return;
  }
  if (!['mail', 'codex-message', 'agent-result'].includes(event.kind)) {
    return;
  }
  const from = event.agentId || 'lead';
  const to = event.to || (from === 'lead' ? 'reviewer' : 'lead');
  state.signals.push({
    id: event.id,
    from,
    to,
    startedAt: performance.now(),
    duration: 1500,
  });
}

function upsertAgent(agent) {
  state.run.agents = state.run.agents || [];
  const index = state.run.agents.findIndex((item) => item.id === agent.id);
  if (index >= 0) {
    state.run.agents[index] = agent;
  } else {
    state.run.agents.push(agent);
  }
}

function appendAgentLog(agentId, entry) {
  const agent = (state.run.agents || []).find((item) => item.id === agentId);
  if (!agent) {
    return;
  }
  agent.logs = [...(agent.logs || []), entry].slice(-400);
}

function resolvePhaseList(run) {
  const profile = state.profiles[run.profileId];
  return profile?.phases || ['plan', 'discovery', 'build', 'review', 'synthesis'];
}

function basename(input) {
  const parts = input.split('/').filter(Boolean);
  return parts[parts.length - 1] || input;
}

function formatPhase(phase) {
  const map = {
    queued: 'Queued',
    plan: 'Plan',
    discovery: 'Discovery',
    build: 'Build',
    review: 'Review',
    synthesis: 'Synthesis',
  };
  return map[phase] || phase || '-';
}

function formatStatus(status) {
  const map = {
    queued: 'Queued',
    idle: 'Idle',
    running: 'Running',
    completed: 'Completed',
    failed: 'Failed',
    stopping: 'Stopping',
    stopped: 'Stopped',
  };
  return map[status] || status || '-';
}

function formatEventKind(kind) {
  const map = {
    phase: 'phase',
    mail: 'handoff',
    'agent-status': 'agent',
    'agent-result': 'result',
    'codex-message': 'codex message',
    'codex-turn': 'turn',
    'codex-usage': 'usage',
    'run-status': 'run',
  };
  return map[kind] || kind;
}

function formatTime(value) {
  if (!value) {
    return '--:--:--';
  }
  const date = new Date(value);
  return date.toLocaleTimeString('id-ID', { hour12: false });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
