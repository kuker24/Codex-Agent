import { Terminal } from '/vendor/xterm/xterm.mjs';
import { FitAddon } from '/vendor/xterm-fit/addon-fit.mjs';

const state = {
  cards: new Map(),
  settings: null,
  codexBinary: 'codex',
};

const grid = document.getElementById('agent-grid');
const template = document.getElementById('agent-card-template');
const settingsForm = document.getElementById('settings-form');
const panelCountInput = document.getElementById('panel-count');
const workspaceInput = document.getElementById('workspace');
const modelInput = document.getElementById('model');
const sandboxInput = document.getElementById('sandbox');
const approvalInput = document.getElementById('approval');
const restartAllButton = document.getElementById('restart-all');
const viewportMetric = document.getElementById('viewport-metric');
const layoutMetric = document.getElementById('layout-metric');
const codexBinaryMetric = document.getElementById('codex-binary');
const statusMessage = document.getElementById('status-message');

const GAP = 14;
const layoutPlans = {
  2: { columns: 2, rows: 1, spans: [1, 1] },
  4: { columns: 6, rows: 2, spans: [3, 3, 3, 3] },
  5: { columns: 6, rows: 2, spans: [2, 2, 2, 3, 3] },
  6: { columns: 6, rows: 2, spans: [2, 2, 2, 2, 2, 2] },
};

await bootstrap();

window.addEventListener('resize', debounce(() => {
  applyLayoutMetrics();
  for (const card of state.cards.values()) {
    fitTerminal(card);
  }
}, 120));

settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  await syncSessions();
});

restartAllButton.addEventListener('click', async () => {
  statusMessage.textContent = 'Restarting all Codex sessions...';
  await fetch('/api/sessions/restart-all', { method: 'POST' });
  statusMessage.textContent = 'Semua sesi di-restart.';
});

async function bootstrap() {
  const response = await fetch('/api/bootstrap');
  const payload = await response.json();
  state.settings = payload.defaults;
  state.codexBinary = payload.codexBinary || 'codex';

  const recommendedCount = recommendPanelCount(window.innerWidth, window.innerHeight);
  const initialCount = Number.isInteger(payload.defaults?.panelCount) ? payload.defaults.panelCount : recommendedCount;
  panelCountInput.value = String(initialCount);
  workspaceInput.value = payload.defaults.workspace;
  modelInput.value = payload.defaults.model;
  sandboxInput.value = payload.defaults.sandbox;
  approvalInput.value = payload.defaults.approval;
  codexBinaryMetric.textContent = state.codexBinary;

  await syncSessions();
}

async function syncSessions() {
  const payload = {
    panelCount: Number.parseInt(panelCountInput.value, 10),
    workspace: workspaceInput.value.trim(),
    model: modelInput.value.trim(),
    sandbox: sandboxInput.value,
    approval: approvalInput.value,
  };

  statusMessage.textContent = 'Menyelaraskan layout dan sesi Codex...';
  const response = await fetch('/api/sessions/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const result = await response.json();
  if (!response.ok || !result.ok) {
    statusMessage.textContent = result.error || 'Gagal menyelaraskan sesi.';
    return;
  }

  state.settings = result.settings;
  renderSessions(result.sessions);
  applyLayoutMetrics();
  statusMessage.textContent = `${result.sessions.length} sesi Codex aktif di ${state.settings.workspace}`;
}

function renderSessions(sessions) {
  const desiredIds = new Set(sessions.map((session) => session.id));

  for (const [id, card] of state.cards.entries()) {
    if (!desiredIds.has(id)) {
      state.cards.delete(id);
      teardownCard(card);
    }
  }

  grid.innerHTML = '';
  const plan = resolveLayoutPlan(sessions.length);
  grid.style.gridTemplateColumns = `repeat(${plan.columns}, minmax(0, 1fr))`;
  grid.style.gridTemplateRows = `repeat(${plan.rows}, minmax(0, 1fr))`;

  for (const session of sessions) {
    let card = state.cards.get(session.id);
    if (!card) {
      card = createCard(session);
      state.cards.set(session.id, card);
    }

    updateCardMeta(card, session);
    card.root.style.gridColumn = `span ${plan.spans[session.index] || 2}`;
    grid.append(card.root);

    requestAnimationFrame(() => {
      fitTerminal(card);
      updateResolutionLabel(card);
    });
  }
}

function createCard(session) {
  const fragment = template.content.cloneNode(true);
  const root = fragment.querySelector('.agent-card');
  const terminalHost = fragment.querySelector('.terminal-host');
  const terminal = new Terminal({
    allowProposedApi: false,
    cursorBlink: true,
    convertEol: true,
    fontFamily: 'IBM Plex Mono, JetBrains Mono, monospace',
    fontSize: 12,
    lineHeight: 1.22,
    theme: {
      background: '#071012',
      foreground: '#f0f3ea',
      cursor: '#8ce4c8',
      cursorAccent: '#071012',
      selectionBackground: 'rgba(140, 228, 200, 0.24)',
      black: '#091114',
      red: '#ff8d7d',
      green: '#9ce8c7',
      yellow: '#ffc16d',
      blue: '#7ea9ff',
      magenta: '#f3a8ff',
      cyan: '#8ce4c8',
      white: '#edf4ec',
      brightBlack: '#65706d',
      brightRed: '#ffb0a5',
      brightGreen: '#b7ffe7',
      brightYellow: '#ffd99c',
      brightBlue: '#aac6ff',
      brightMagenta: '#f8c4ff',
      brightCyan: '#c1fff0',
      brightWhite: '#ffffff',
    },
    scrollback: 5000,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  terminal.open(terminalHost);

  const elements = {
    root,
    name: fragment.querySelector('.agent-name'),
    index: fragment.querySelector('.agent-index'),
    resolution: fragment.querySelector('.agent-resolution'),
    statusDot: fragment.querySelector('.agent-status-dot'),
    statusText: fragment.querySelector('.agent-status-text'),
    command: fragment.querySelector('.agent-command'),
    restart: fragment.querySelector('.restart-button'),
  };

  const card = {
    id: session.id,
    root,
    terminal,
    fitAddon,
    elements,
    disposed: false,
    socket: null,
    observer: new ResizeObserver(() => {
      fitTerminal(card);
      updateResolutionLabel(card);
      sendResize(card);
    }),
  };

  elements.restart.addEventListener('click', async () => {
    statusMessage.textContent = `Restarting ${session.name}...`;
    await fetch(`/api/sessions/${session.id}/restart`, { method: 'POST' });
  });

  terminal.onData((data) => {
    if (card.socket?.readyState === WebSocket.OPEN) {
      card.socket.send(JSON.stringify({ type: 'input', data }));
    }
  });

  card.observer.observe(root);
  connectSocket(card, session.id);
  return card;
}

function updateCardMeta(card, session) {
  card.session = session;
  card.elements.index.textContent = `Slot ${String(session.index + 1).padStart(2, '0')}`;
  card.elements.name.textContent = session.name;
  card.elements.command.textContent = `${state.codexBinary} --cd ${session.workspace} --sandbox ${session.sandbox} --ask-for-approval ${session.approval}${session.model ? ` --model ${session.model}` : ''}`;
  card.elements.statusText.textContent = formatStatus(session.status, session.exitCode);
  card.elements.statusDot.className = `agent-status-dot ${session.status === 'online' ? 'online' : session.status === 'exited' ? 'exited' : ''}`;
}

function connectSocket(card, sessionId) {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${protocol}://${window.location.host}/ws?sessionId=${encodeURIComponent(sessionId)}`);
  card.socket = socket;

  socket.addEventListener('open', () => {
    sendResize(card);
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'bootstrap') {
      card.terminal.reset();
      if (message.backlog) {
        card.terminal.write(message.backlog);
      }
      updateCardMeta(card, message.session);
      requestAnimationFrame(() => {
        fitTerminal(card);
        sendResize(card);
      });
      return;
    }

    if (message.type === 'output') {
      card.terminal.write(message.data);
      return;
    }

    if (message.type === 'session') {
      updateCardMeta(card, message.session);
      return;
    }
  });

  socket.addEventListener('close', () => {
    if (!card.disposed && state.cards.has(sessionId)) {
      card.elements.statusText.textContent = 'disconnected';
      card.elements.statusDot.className = 'agent-status-dot exited';
      window.setTimeout(() => connectSocket(card, sessionId), 1200);
    }
  });
}

function fitTerminal(card) {
  try {
    card.fitAddon.fit();
  } catch (_error) {
    // Fit can throw during layout thrash; ignore and retry on next resize.
  }
}

function sendResize(card) {
  if (!card.socket || card.socket.readyState !== WebSocket.OPEN) {
    return;
  }

  card.socket.send(JSON.stringify({
    type: 'resize',
    cols: card.terminal.cols,
    rows: card.terminal.rows,
  }));
}

function updateResolutionLabel(card) {
  const rect = card.root.getBoundingClientRect();
  const width = Math.max(0, Math.floor(rect.width));
  const height = Math.max(0, Math.floor(rect.height));
  card.elements.resolution.textContent = `${width} x ${height}px`;
}

function applyLayoutMetrics() {
  const count = Number.parseInt(panelCountInput.value, 10);
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const plan = resolveLayoutPlan(count);
  viewportMetric.textContent = `${viewportWidth} x ${viewportHeight}px`;

  const gridRect = grid.getBoundingClientRect();
  const cardWidths = [...state.cards.values()].map((card) => Math.floor(card.root.getBoundingClientRect().width)).filter(Boolean);
  const cardHeights = [...state.cards.values()].map((card) => Math.floor(card.root.getBoundingClientRect().height)).filter(Boolean);
  const avgWidth = average(cardWidths);
  const avgHeight = average(cardHeights);
  layoutMetric.textContent = `${count} panel • grid ${Math.floor(gridRect.width)} x ${Math.floor(gridRect.height)}px • rata-rata ${avgWidth} x ${avgHeight}px`;
  grid.style.setProperty('--gap', `${GAP}px`);
}

function resolveLayoutPlan(count) {
  const width = window.innerWidth;
  if (width < 1180) {
    return {
      columns: 1,
      rows: count,
      spans: Array.from({ length: count }, () => 1),
    };
  }

  if (width < 1500 && count > 4) {
    return {
      columns: 4,
      rows: 3,
      spans: count === 5 ? [2, 2, 2, 2, 4] : [2, 2, 2, 2, 2, 2],
    };
  }

  return layoutPlans[count] || layoutPlans[4];
}

function recommendPanelCount(width, height) {
  if (width >= 1800 && height >= 980) {
    return 6;
  }
  if (width >= 1500 && height >= 860) {
    return 5;
  }
  return 4;
}

function formatStatus(status, exitCode) {
  if (status === 'online') {
    return 'online';
  }
  if (status === 'starting') {
    return 'starting';
  }
  if (status === 'restarting') {
    return 'restarting';
  }
  if (status === 'exited') {
    return exitCode === null ? 'exited' : `exited (${exitCode})`;
  }
  return status;
}

function teardownCard(card) {
  card.disposed = true;
  card.observer.disconnect();
  card.socket?.close();
  card.terminal.dispose();
}

function average(values) {
  if (!values.length) {
    return 0;
  }
  return Math.floor(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function debounce(callback, wait) {
  let timeoutId;
  return (...args) => {
    window.clearTimeout(timeoutId);
    timeoutId = window.setTimeout(() => callback(...args), wait);
  };
}
