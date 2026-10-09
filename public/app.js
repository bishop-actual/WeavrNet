// WeavrNet web app. Plain JS, no build step. Event handlers are attached by
// delegation on [data-action] because the CSP forbids inline handlers.
'use strict';

// ═══════════════════════════════════════════════════════════════
// CONSTANTS (mirrors lib/models/app_settings.dart in Weavr)
// ═══════════════════════════════════════════════════════════════
const ROOM_ICONS = {
  tv: ['📺', 'TV'], sofa: ['🛋️', 'Living Room'], bed: ['🛏️', 'Bedroom'], kitchen: ['🍳', 'Kitchen'],
  gamepad: ['🎮', 'Games Room'], baby: ['🧸', 'Kids Room'], office: ['💻', 'Office'], dining: ['🍽️', 'Dining'],
  basement: ['🚗', 'Basement'], gym: ['🏋️', 'Gym'], cinema: ['🎬', 'Cinema'], music: ['🎵', 'Music Room'],
};
const ROOM_PRESETS = ['Living Room', 'Bedroom', 'Kitchen', 'Office', 'Games Room', 'Kids Room', 'Dining Room', 'Basement'];
const BG_PRESETS = [
  ['gradient', '#0EA5FF', '#00D4B8', 'Ocean'], ['gradient', '#7C6EFA', '#0EA5FF', 'Violet Blue'],
  ['gradient', '#FF4D6A', '#FFB340', 'Sunset'], ['gradient', '#00C896', '#0EA5FF', 'Emerald'],
  ['gradient', '#7C6EFA', '#FF4D6A', 'Cosmic'], ['gradient', '#FFB340', '#FF4D6A', 'Fire'],
  ['solid', '#0EA5FF', null, 'Blue'], ['solid', '#00D4B8', null, 'Teal'], ['solid', '#7C6EFA', null, 'Purple'],
  ['solid', '#FF4D6A', null, 'Red'], ['solid', '#00C896', null, 'Green'], ['solid', '#FFB340', null, 'Amber'],
  ['solid', '#18182A', null, 'Dark'],
];
const TOGGLES = [
  ['showFavouritesMenu', 'Show Favourites in menu', 'Hide this if they prefer the favourites filters inside each section.'],
  ['discoverEnabled', 'Discover catalogue', 'Prepopulate Movies and Series with popular TMDB titles.'],
  ['tmdbEnabled', 'TMDB enrichment', 'Fetch posters, backdrops and descriptions from TMDB.'],
];
const SECRETS = [
  ['tmdbApiKey', 'TMDB API key'], ['omdbApiKey', 'OMDb API key'], ['traktClientId', 'Trakt client ID'],
  ['fanartApiKey', 'Fanart.tv API key'], ['mdblistApiKey', 'MDBList API key'],
];

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════
const S = {
  server: { name: 'WeavrNet' },
  devices: new Map(),
  selected: null,       // device id
  playback: null,       // PlaybackState JSON for selected device
  config: undefined,    // config snapshot (null = remote edit off, undefined = unknown)
  tab: 'sources',
  ws: null,
  wsAttempt: 0,
  isPlaying: false,
  settingsDirty: false,
  requests: new Map(),  // requestId -> { label }
};
let positionTimer = null;
let uptimeTimer = null;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const safeUrl = (u) => (typeof u === 'string' && /^https?:\/\//i.test(u) ? u : null);
const safeColor = (c, fallback) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);

// ═══════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════
async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
let setupMode = false;

async function boot() {
  try {
    const st = await api('GET', '/api/status');
    S.server = st.server;
    if (st.authenticated) return startApp();
    showAuth(st.setupRequired);
  } catch (e) {
    showAuth(false);
    $('#authError').textContent = 'Cannot reach the WeavrNet server.';
  }
}

function showAuth(setup) {
  setupMode = setup;
  $('#app').hidden = true;
  $('#auth').hidden = false;
  $('#authSub').textContent = setup
    ? 'Welcome! Choose an admin password to finish setting up this WeavrNet server.'
    : `Sign in to ${S.server?.name || 'WeavrNet'} to control your Weavr devices from anywhere.`;
  $('#authConfirm').hidden = !setup;
  $('#authConfirm').required = setup;
  $('#authPassword').autocomplete = setup ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = setup ? 'Create admin password' : 'Sign in';
  $('#authPassword').focus();
}

$('#authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('#authPassword').value;
  const err = $('#authError');
  err.textContent = '';
  if (setupMode) {
    if (password.length < 8) { err.textContent = 'Use at least 8 characters.'; return; }
    if (password !== $('#authConfirm').value) { err.textContent = 'Passwords do not match.'; return; }
  }
  $('#authSubmit').disabled = true;
  try {
    await api('POST', setupMode ? '/api/setup' : '/api/login', { password });
    $('#authPassword').value = '';
    $('#authConfirm').value = '';
    startApp();
  } catch (ex) {
    err.textContent = ex.message;
  } finally {
    $('#authSubmit').disabled = false;
  }
});

function startApp() {
  $('#auth').hidden = true;
  $('#app').hidden = false;
  renderServer();
  renderDeviceList();
  connectWs();
  route();
}

// ═══════════════════════════════════════════════════════════════
// RELAY CONNECTION
// ═══════════════════════════════════════════════════════════════
let wsTimer = null;

function connectWs() {
  clearTimeout(wsTimer);
  if (S.ws) { S.ws.onclose = null; S.ws.close(); }
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  setRelayStatus('connecting');

  ws.onopen = () => {
    S.wsAttempt = 0;
    setRelayStatus('connected');
    if (S.selected) wsSend({ type: 'subscribe', deviceId: S.selected });
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch (_) { return; }
    onMessage(msg);
  };
  ws.onclose = async () => {
    setRelayStatus('disconnected');
    // A closed socket may mean the session expired — check before retrying.
    try {
      const st = await api('GET', '/api/status');
      if (!st.authenticated) { showAuth(st.setupRequired); return; }
    } catch (_) {}
    const delay = Math.min(15000, 1000 * 2 ** S.wsAttempt++);
    wsTimer = setTimeout(connectWs, delay);
  };
}

function wsSend(msg) {
  if (!S.ws || S.ws.readyState !== WebSocket.OPEN) { toast('Not connected to WeavrNet', true); return false; }
  S.ws.send(JSON.stringify(msg));
  return true;
}

function setRelayStatus(s) {
  $('#relayDot').className = `conn-dot ${s === 'connected' ? '' : s}`;
  $('#relayStatus').textContent = s === 'connected' ? 'Relay online' : s === 'connecting' ? 'Connecting…' : 'Reconnecting…';
}

function onMessage(msg) {
  switch (msg.type) {
    case 'hello':
      S.server = msg.server;
      S.devices = new Map(msg.devices.map((d) => [d.id, d]));
      renderServer();
      renderDeviceList();
      if (S.selected) renderHeader();
      break;
    case 'server':
      S.server = msg.server;
      renderServer();
      break;
    case 'device':
      S.devices.set(msg.device.id, msg.device);
      renderDeviceList();
      if (msg.device.id === S.selected) {
        if (!msg.device.online) { S.playback = null; S.config = undefined; renderPlayback(); renderTab(); }
        renderHeader();
      }
      break;
    case 'device.removed':
      S.devices.delete(msg.deviceId);
      renderDeviceList();
      if (msg.deviceId === S.selected) { toast('Device removed'); location.hash = ''; }
      break;
    case 'state':
      if (msg.deviceId !== S.selected) return;
      S.playback = msg.data;
      renderPlayback();
      break;
    case 'diagnostics':
      if (msg.deviceId !== S.selected || !S.playback) return;
      S.playback.diagnostics = msg.data;
      renderDiagnostics(msg.data);
      break;
    case 'config':
      if (msg.deviceId !== S.selected) return;
      S.config = msg.data;
      renderHeader();
      if (S.tab === 'settings') {
        if ($('#tab-settings')?.contains(document.activeElement)) S.settingsDirty = true;
        else renderTab();
      }
      break;
    case 'config.result': {
      const req = S.requests.get(msg.requestId);
      S.requests.delete(msg.requestId);
      if (msg.ok) toast(req?.label || 'Saved on device');
      else toast(msg.error || 'Change was rejected', true);
      break;
    }
    case 'error':
      if (msg.requestId) S.requests.delete(msg.requestId);
      toast(msg.error, true);
      break;
    default:
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTING  (#/device/<id> so the phone back button works)
// ═══════════════════════════════════════════════════════════════
window.addEventListener('hashchange', route);

function route() {
  if ($('#app').hidden) return;
  const m = location.hash.match(/^#\/device\/([A-Za-z0-9_-]+)/);
  const id = m ? m[1] : null;
  if (id === S.selected) return;
  if (S.selected) wsSend({ type: 'unsubscribe' });
  S.selected = id;
  S.playback = null;
  S.config = undefined;
  clearInterval(positionTimer);
  clearInterval(uptimeTimer);
  $('#app').classList.toggle('show-detail', !!id);
  $('#emptyDetail').hidden = !!id;
  $('#dashboard').hidden = !id;
  renderDeviceList();
  if (!id) return;
  renderDashboard();
  if (S.ws?.readyState === WebSocket.OPEN) S.ws.send(JSON.stringify({ type: 'subscribe', deviceId: id }));
  window.scrollTo(0, 0);
}

// ═══════════════════════════════════════════════════════════════
// SIDEBAR / DEVICE LIST
// ═══════════════════════════════════════════════════════════════
function renderServer() {
  $('#serverName').textContent = S.server?.name || 'WeavrNet';
  document.title = S.server?.name || 'WeavrNet';
}

function iconFor(d) {
  return (ROOM_ICONS[d?.appearance?.iconKey] || ROOM_ICONS.tv)[0];
}

function iconBg(a) {
  if (!a) return 'var(--grad)';
  const c1 = safeColor(a.bgColor1, '#57A7B3');
  if (a.bgType === 'solid' || !a.bgColor2) return c1;
  return `linear-gradient(135deg,${c1},${safeColor(a.bgColor2, '#7FC8D2')})`;
}

function statusLabel(s) {
  const map = {
    playing: '▶ Playing', idle: '⏸ Idle', buffering: '⟳ Buffering', loading: '⟳ Loading', paused: '⏸ Paused',
    error: '✗ Error', reconnecting: '↻ Reconnecting',
  };
  return map[s] || s || '';
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function deviceStatusLine(d) {
  if (d.status === 'pending') return ['pending', d.online ? 'Waiting for approval' : `Waiting for approval · seen ${ago(d.lastSeen)}`];
  if (d.status === 'blocked') return ['blocked', 'Blocked'];
  if (!d.online) return ['offline', `Offline · seen ${ago(d.lastSeen)}`];
  const st = d.playback?.status || 'idle';
  return [st, statusLabel(st)];
}

function deviceCard(d) {
  const [cls, label] = deviceStatusLine(d);
  const tag = d.status === 'pending' ? '<span class="tag pending">NEW</span>'
    : d.status === 'blocked' ? '<span class="tag blocked">BLOCKED</span>' : '';
  const actions = d.status === 'pending'
    ? `<div class="pending-actions">
         <button class="btn sm" data-action="approve" data-id="${esc(d.id)}">Approve</button>
         <button class="btn sm danger" data-action="block" data-id="${esc(d.id)}">Block</button>
       </div>`
    : '<div class="chevron">›</div>';
  return `
    <div class="device-card ${d.id === S.selected ? 'active' : ''} ${d.online ? '' : 'offline'}"
         data-action="select" data-id="${esc(d.id)}" role="button" tabindex="0">
      <div class="device-icon" style="background:${iconBg(d.appearance)}">${iconFor(d)}</div>
      <div class="device-info">
        <div class="device-name">${esc(d.name)} ${tag}</div>
        <div class="device-status status-${esc(cls)}">${esc(label)}</div>
        ${d.online && d.playback?.title ? `<div class="device-now-playing">${esc(d.playback.title)}</div>` : ''}
      </div>
      ${actions}
    </div>`;
}

function renderDeviceList() {
  const list = $('#deviceList');
  const all = [...S.devices.values()];
  const pending = all.filter((d) => d.status === 'pending');
  const rest = all.filter((d) => d.status !== 'pending');
  const online = rest.filter((d) => d.online).length;
  let html = '';
  if (pending.length) {
    html += `<div class="section-title">Waiting for approval</div>${pending.map(deviceCard).join('')}`;
  }
  html += `<div class="section-title">Devices${rest.length ? ` · ${online} online` : ''}</div>`;
  if (rest.length) {
    html += rest.map(deviceCard).join('');
  } else {
    html += `
      <div class="scanning"><div class="pulse"></div><span>Waiting for Weavr devices to connect…</span></div>
      <div class="card">
        <div class="card-title">Connect a Weavr device</div>
        <div class="steps">
          <div class="step"><b>1</b><span>On the TV open Weavr → Settings → Companion.</span></div>
          <div class="step"><b>2</b><span>Under <b style="all:unset;color:var(--text)">WeavrNet</b>, enter <span class="code" style="display:inline-flex;padding:2px 6px">${esc(location.host)}</span></span></div>
          <div class="step"><b>3</b><span>Leave it switched on. The device appears here once its handshake completes.</span></div>
        </div>
      </div>`;
  }
  list.innerHTML = html;
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════
const TABS = [['sources', 'Sources'], ['diagnostics', 'Diagnostics'], ['remote', 'Remote'], ['settings', 'Settings'], ['device', 'Device']];

function renderDashboard() {
  $('#dashboard').innerHTML = `
    <div class="comp-header">
      <button class="back-btn" data-action="back" aria-label="Back">‹</button>
      <div id="compIcon" class="device-icon" style="width:38px;height:38px;font-size:18px">📺</div>
      <div class="comp-device">
        <div class="comp-device-name" id="compName">—</div>
        <div class="comp-device-status"><span class="conn-dot connecting" id="compDot"></span><span id="compStatus">Connecting…</span></div>
      </div>
      <div class="short-code" id="compCode"></div>
    </div>
    <div id="compBanner"></div>

    <div class="now-playing">
      <div class="np-backdrop">
        <div class="np-idle" id="npIdle"><div class="np-idle-icon">📺</div><div style="font-size:13px">Nothing playing</div></div>
        <img id="npBackdrop" hidden alt="" referrerpolicy="no-referrer">
        <div class="np-backdrop-overlay"></div>
      </div>
      <div class="np-info">
        <div class="np-title" id="npTitle">Weavr</div>
        <div class="np-subtitle" id="npSubtitle">Ready to play</div>
        <div class="np-source"><span class="source-pill" id="npSource">—</span></div>
      </div>
      <div class="progress-wrap" id="progressWrap" hidden>
        <div class="progress-track" id="progressTrack" data-action="seek-bar">
          <div class="progress-fill" id="progressFill" style="width:0%"></div>
          <div class="progress-thumb" id="progressThumb" style="left:0%"></div>
        </div>
        <div class="progress-times"><span id="posTime">0:00</span><span id="durTime">0:00</span></div>
      </div>
      <div class="progress-wrap" id="liveBadgeWrap" hidden><span class="live-badge">● LIVE</span></div>
    </div>

    <div class="controls">
      <button class="ctrl-btn secondary" data-action="cmd" data-cmd="prevSource" title="Previous source">⏮</button>
      <button class="ctrl-btn secondary" data-action="cmd" data-cmd="seekBack" title="Back 10s">↩ 10</button>
      <button class="ctrl-btn primary" id="playPauseBtn" data-action="toggle-play" title="Play / pause">▶</button>
      <button class="ctrl-btn secondary" data-action="cmd" data-cmd="seekForward" title="Forward 10s">10 ↪</button>
      <button class="ctrl-btn secondary" data-action="cmd" data-cmd="nextSource" title="Next source">⏭</button>
    </div>

    <div class="tab-bar" role="tablist">
      ${TABS.map(([k, l]) => `<button class="tab ${S.tab === k ? 'active' : ''}" data-action="tab" data-tab="${k}" role="tab">${l}</button>`).join('')}
    </div>
    <div id="tabHost"></div>`;
  renderHeader();
  renderPlayback();
  renderTab();
}

function selectedDevice() { return S.devices.get(S.selected); }

function renderHeader() {
  const d = selectedDevice();
  if (!d || !$('#compName')) return;
  $('#compName').textContent = d.name;
  $('#compCode').textContent = d.shortCode || '';
  $('#compIcon').textContent = iconFor(d);
  $('#compIcon').style.background = iconBg(d.appearance);
  const dot = $('#compDot');
  const status = $('#compStatus');
  if (d.status === 'approved' && d.online) {
    dot.className = 'conn-dot';
    status.textContent = `Connected via ${S.server?.name || 'WeavrNet'}`;
  } else {
    dot.className = 'conn-dot disconnected';
    status.textContent = d.status === 'approved' ? `Offline · seen ${ago(d.lastSeen)}` : d.status === 'pending' ? 'Waiting for approval' : 'Blocked';
  }

  let banner = '';
  if (d.status === 'pending') {
    banner = `<div class="banner"><span class="grow">This device reached out to the relay and is waiting for approval.</span>
      <button class="btn sm" data-action="approve" data-id="${esc(d.id)}">Approve</button></div>`;
  } else if (d.status === 'blocked') {
    banner = `<div class="banner"><span class="grow">This device is blocked and cannot connect.</span>
      <button class="btn sm ghost" data-action="unblock" data-id="${esc(d.id)}">Unblock</button></div>`;
  } else if (!d.online) {
    banner = '<div class="banner info"><span class="grow">The device is offline. Controls return when Weavr reconnects to the relay.</span></div>';
  }
  $('#compBanner').innerHTML = banner;
  const usable = d.status === 'approved' && d.online;
  $$('.controls .ctrl-btn').forEach((b) => { b.disabled = !usable; });
}

// ── Playback (identical behaviour to WeavrLink) ──

function renderPlayback() {
  if (!$('#npTitle')) return;
  const state = S.playback;
  const status = state?.status || 'idle';
  S.isPlaying = status === 'playing';
  const hasContent = !!(state?.title && status !== 'idle');
  $('#npIdle').hidden = hasContent;

  const img = $('#npBackdrop');
  const src = safeUrl(state?.backdropUrl) || safeUrl(state?.posterUrl);
  if (src && hasContent) { if (img.getAttribute('src') !== src) img.src = src; img.hidden = false; } else { img.hidden = true; }

  $('#npTitle').textContent = (hasContent && state.title) || 'Weavr';
  $('#npSubtitle').textContent = (hasContent && state.subtitle) || (state ? statusLabel(status) : 'Ready to play');
  $('#npSource').textContent = state?.diagnostics?.sourceName || '—';
  $('#playPauseBtn').textContent = S.isPlaying ? '⏸' : '▶';

  const diag = state?.diagnostics;
  const isLive = diag?.isLive !== false;
  $('#progressWrap').hidden = !(hasContent && !isLive && diag?.durationMs);
  $('#liveBadgeWrap').hidden = !(isLive && hasContent);
  if (diag?.durationMs) {
    updateProgress(diag.positionMs || 0, diag.durationMs);
    startPositionInterpolation(diag.positionMs || 0, diag.durationMs, S.isPlaying);
  } else {
    clearInterval(positionTimer);
  }

  if (S.tab === 'sources') renderSources(diag);
  if (S.tab === 'diagnostics') renderDiagnostics(diag);

  clearInterval(uptimeTimer);
  if (diag?.startedAt && hasContent) {
    uptimeTimer = setInterval(updateUptime, 1000);
    updateUptime();
  }
}

function startPositionInterpolation(posMs, durMs, playing) {
  clearInterval(positionTimer);
  if (!playing || !durMs) return;
  const t0 = Date.now();
  positionTimer = setInterval(() => {
    if (!S.isPlaying) return;
    let pos = posMs + (Date.now() - t0);
    if (pos > durMs) { pos = durMs; clearInterval(positionTimer); }
    updateProgress(pos, durMs);
  }, 1000);
}

function updateProgress(posMs, durMs) {
  const pct = durMs > 0 ? Math.min(100, (posMs / durMs) * 100) : 0;
  $('#progressFill').style.width = `${pct}%`;
  $('#progressThumb').style.left = `${pct}%`;
  $('#posTime').textContent = fmtMs(posMs);
  $('#durTime').textContent = fmtMs(durMs);
}

function updateUptime() {
  const el = $('#diagUptime');
  const started = S.playback?.diagnostics?.startedAt;
  if (!el || !started) return;
  const secs = Math.max(0, Math.floor((Date.now() - new Date(started)) / 1000));
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  el.textContent = h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${secs % 60}s` : `${secs}s`;
}

function fmtMs(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

// ── Tabs ──

function renderTab() {
  const host = $('#tabHost');
  if (!host) return;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));
  S.settingsDirty = false;
  const diag = S.playback?.diagnostics;
  switch (S.tab) {
    case 'sources':
      host.innerHTML = `<div class="tab-panel"><div class="section"><div class="section-title">Available Sources</div>
        <div class="source-list" id="sourceList"></div></div>
        <div class="section"><button class="btn ghost block" data-action="cmd" data-cmd="refreshStream">↻ Refresh Stream</button></div></div>`;
      renderSources(diag);
      break;
    case 'diagnostics':
      host.innerHTML = diagnosticsHtml();
      renderDiagnostics(diag);
      updateUptime();
      break;
    case 'remote':
      host.innerHTML = `<div class="tab-panel">
        <div class="section remote-grid">
          <button class="btn danger" data-action="cmd" data-cmd="stop">⏹ Stop</button>
          <button class="btn ghost" data-action="cmd" data-cmd="refreshStream">↻ Refresh</button>
          <button class="btn ghost" data-action="cmd" data-cmd="seekBack" data-seconds="30">↩ 30s</button>
          <button class="btn ghost" data-action="cmd" data-cmd="seekForward" data-seconds="30">30s ↪</button>
        </div>
        <div class="section"><div class="section-title">Volume</div>
          <input class="range" type="range" min="0" max="100" value="80" data-action="volume"></div>
      </div>`;
      break;
    case 'settings':
      host.innerHTML = settingsHtml();
      break;
    case 'device':
      host.innerHTML = deviceAdminHtml();
      break;
    default:
  }
}

function renderSources(diag) {
  const list = $('#sourceList');
  if (!list) return;
  const sources = diag?.availableSources || [];
  const current = diag?.currentSourceIndex || 0;
  if (!sources.length) {
    list.innerHTML = '<div class="empty">No sources — start playing something on the TV</div>';
    return;
  }
  list.innerHTML = sources.map((name, i) => `
    <button class="source-row ${i === current ? 'active' : ''}" data-action="switch-source" data-index="${i}">
      <div class="source-num">${i + 1}</div>
      <div style="flex:1">
        <div class="source-name">${esc(name)}</div>
        ${i < current ? '<div class="source-failed-label">✗ Failed — skipped</div>' : ''}
      </div>
      ${i === current ? '<div class="source-action">Active</div>' : '<div style="color:var(--muted);font-size:12px">Available</div>'}
    </button>`).join('');
}

function diagnosticsHtml() {
  const cell = (id, label, full = false, extra = '') => `<div class="diag-card ${full ? 'full' : ''}"><div class="diag-label">${label}</div><div class="diag-value" id="${id}">—</div>${extra}</div>`;
  return `<div class="tab-panel"><div class="section"><div class="section-title">Stream Health</div><div class="diag-grid">
    ${cell('diagStatus', 'Status')}
    ${cell('diagBuffer', 'Buffer Health', false, '<div class="buffer-bar"><div class="buffer-fill" id="bufferFill" style="width:0%"></div></div>')}
    ${cell('diagBitrate', 'Bitrate')}${cell('diagResolution', 'Resolution')}${cell('diagCodec', 'Codec')}
    ${cell('diagReconnects', 'Reconnects')}${cell('diagFailover', 'Failover Attempts')}${cell('diagUptime', 'Uptime')}
    ${cell('diagSource', 'Active Source', true)}
    <div class="diag-card full"><div class="diag-label">Stream URL</div><div class="diag-url" id="diagUrl">—</div></div>
    <div class="diag-card full"><div class="diag-label">Failover History</div><div class="failover-list" id="diagFailoverHistory"></div></div>
  </div></div></div>`;
}

function renderDiagnostics(diag) {
  if (!$('#diagStatus')) return;
  const set = (id, v) => { $(`#${id}`).textContent = v ?? '—'; };
  const buf = diag?.bufferHealth ?? 0;
  const cls = buf > 60 ? 'good' : buf > 30 ? 'warn' : 'bad';
  set('diagStatus', statusLabel(S.playback?.status) || '—');
  set('diagBuffer', diag ? `${buf}%` : '—');
  $('#diagBuffer').className = `diag-value ${diag ? cls : ''}`;
  $('#bufferFill').style.width = `${buf}%`;
  $('#bufferFill').style.background = `var(--${{ good: 'success', warn: 'warn', bad: 'danger' }[cls]})`;
  set('diagBitrate', diag?.estimatedBitrate ? `${Math.round(diag.estimatedBitrate)} kbps` : '—');
  set('diagResolution', diag?.resolution || '—');
  set('diagCodec', diag?.codec || '—');
  set('diagReconnects', diag?.reconnectCount ?? 0);
  set('diagFailover', diag?.failoverAttempts ?? 0);
  set('diagSource', diag?.sourceName || '—');
  set('diagUrl', diag?.url || '—');
  const hist = diag?.failoverHistory || [];
  $('#diagFailoverHistory').innerHTML = hist.length === 0
    ? '<span style="color:var(--muted);font-size:12px">No failovers yet</span>'
    : hist.map((h, i) => `<div class="failover-item"><div class="failover-dot ${i === hist.length - 1 ? 'current' : (String(h).includes('✗') ? 'fail' : 'ok')}"></div><span>${esc(h)}</span></div>`).join('');
}

// ── Settings tab (remote config editing) ──

function switchHtml(attrs, checked, disabled = false) {
  return `<label class="switch"><input type="checkbox" ${attrs} ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}><span></span></label>`;
}

function settingsHtml() {
  const d = selectedDevice();
  if (!d || d.status !== 'approved') return '<div class="tab-panel"><div class="empty">Approve this device to manage its settings.</div></div>';
  if (!d.online) return '<div class="tab-panel"><div class="empty">The device is offline. Settings can be edited once it reconnects.</div></div>';
  if (S.config === undefined) return '<div class="tab-panel"><div class="scanning" style="justify-content:center"><div class="pulse"></div>Loading device settings…</div></div>';
  if (S.config === null) {
    return `<div class="tab-panel"><div class="section"><div class="card">
      <div class="card-title">🔒 Remote editing is off</div>
      <div class="card-sub">Whoever uses this TV has turned off “Allow remote settings changes” in Weavr → Settings → Companion → WeavrNet.
      Playback control still works; settings stay private to the device.</div></div></div></div>`;
  }
  const c = S.config;
  const a = c.appearance || {};
  const settings = c.settings || {};
  const secrets = c.secrets || {};
  const stats = c.stats || {};

  const sources = (c.sources || []).map((s) => `
    <div class="src-card">
      <div class="row">
        <span class="src-type">${esc(String(s.type).toUpperCase())}</span>
        <div class="grow" style="font-weight:600">${esc(s.name)}</div>
        ${switchHtml(`data-action="source-toggle" data-id="${esc(s.id)}"`, s.enabled)}
      </div>
      <div class="src-url">${esc(s.type === 'xtream' ? `${s.xtreamHost || ''} · ${s.xtreamUsername || ''}` : s.m3uUrl || '')}</div>
      <div class="row mt">
        <span class="grow" style="font-size:11px;color:var(--muted)">${s.lastRefreshed ? `Updated ${ago(Date.parse(s.lastRefreshed))}` : ''}</span>
        <button class="btn sm ghost" data-action="source-edit" data-id="${esc(s.id)}">Edit</button>
        <button class="btn sm danger" data-action="source-remove" data-id="${esc(s.id)}">Remove</button>
      </div>
    </div>`).join('') || '<div class="empty">No sources on this device yet.</div>';

  return `<div class="tab-panel" id="tab-settings">
    <div class="section">
      <div class="stats">
        <div class="stat"><b>${esc(stats.channels ?? '—')}</b><span>Channels</span></div>
        <div class="stat"><b>${esc(stats.movies ?? '—')}</b><span>Movies</span></div>
        <div class="stat"><b>${esc(stats.series ?? '—')}</b><span>Series</span></div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Room</div>
      <div class="card">
        <label class="label" for="cfgName">Room name</label>
        <div class="row">
          <input class="input grow" id="cfgName" maxlength="40" value="${esc(c.deviceName || '')}">
          <button class="btn" data-action="save-name">Save</button>
        </div>
        <div class="chips mt">${ROOM_PRESETS.map((r) => `<button class="chip" data-action="preset-name" data-name="${esc(r)}">${esc(r)}</button>`).join('')}</div>
        <label class="label mt">Icon</label>
        <div class="chips">${Object.entries(ROOM_ICONS).map(([k, [ico, label]]) => `<button class="chip ${a.iconKey === k ? 'active' : ''}" data-action="set-icon" data-key="${k}" title="${esc(label)}">${ico}</button>`).join('')}</div>
        <label class="label mt">Background</label>
        <div class="chips">${BG_PRESETS.map(([t, c1, c2, label], i) => {
          const active = a.bgType === t && a.bgColor1 === c1 && (t === 'solid' || a.bgColor2 === c2);
          return `<button class="swatch ${active ? 'active' : ''}" title="${label}" data-action="set-bg" data-index="${i}"
            style="background:${t === 'gradient' ? `linear-gradient(135deg,${c1},${c2})` : c1}"></button>`;
        }).join('')}</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">Sources</div>
      ${sources}
      <div class="row mt">
        <button class="btn grow" data-action="source-add" data-type="m3u">＋ Add M3U URL</button>
        <button class="btn ghost grow" data-action="source-add" data-type="xtream">＋ Add Xtream</button>
      </div>
      <button class="btn ghost block mt" data-action="refresh-sources">↻ Refresh all sources on the TV</button>
    </div>

    <div class="section">
      <div class="section-title">General</div>
      ${TOGGLES.map(([k, title, sub]) => `<div class="card"><div class="row"><div class="grow"><div class="card-title">${title}</div><div class="card-sub">${sub}</div></div>
        ${switchHtml(`data-action="setting-toggle" data-key="${k}"`, !!settings[k])}</div></div>`).join('')}
    </div>

    <div class="section">
      <div class="section-title">Metadata keys</div>
      <div class="card"><div class="card-sub" style="margin:0 0 10px">Keys are write-only: WeavrNet never receives the current values, only whether one is set.</div>
      <div class="stack">${SECRETS.map(([k, label]) => `
        <div>
          <div class="row"><label class="label grow" for="sec-${k}">${label}</label>
            <span class="secret-state ${secrets[k] ? 'set' : ''}">${secrets[k] ? '● Set' : 'Not set'}</span></div>
          <div class="row">
            <input class="input grow" id="sec-${k}" type="password" autocomplete="off" placeholder="${secrets[k] ? 'Enter a new value to replace' : 'Paste key'}">
            <button class="btn sm" data-action="secret-save" data-key="${k}">Save</button>
            ${secrets[k] ? `<button class="btn sm danger" data-action="secret-clear" data-key="${k}">Clear</button>` : ''}
          </div>
        </div>`).join('')}</div></div>
    </div>
  </div>`;
}

// ── Device admin tab ──

function deviceAdminHtml() {
  const d = selectedDevice();
  if (!d) return '';
  const remote = d.remoteEdit === true ? 'Allowed' : d.remoteEdit === false ? 'Turned off on device' : '—';
  return `<div class="tab-panel"><div class="section">
    <div class="card">
      <div class="card-title">Device</div>
      <dl class="kv mt">
        <dt>Status</dt><dd>${esc(d.status)}${d.online ? ' · online' : ''}</dd>
        <dt>Short code</dt><dd>${esc(d.shortCode || '—')}</dd>
        <dt>Platform</dt><dd>${esc(d.platform || '—')}</dd>
        <dt>Weavr version</dt><dd>${esc(d.appVersion || '—')}</dd>
        <dt>Remote editing</dt><dd>${esc(remote)}</dd>
        <dt>Last address</dt><dd>${esc(d.lastIp || '—')}</dd>
        <dt>Last seen</dt><dd>${d.online ? 'now' : esc(ago(d.lastSeen))}</dd>
        <dt>Added</dt><dd>${d.createdAt ? esc(new Date(d.createdAt).toLocaleString()) : '—'}</dd>
        <dt>Device ID</dt><dd title="${esc(d.id)}">${esc(d.id)}</dd>
      </dl>
    </div>
    <div class="card">
      ${d.status === 'pending' ? `<div class="card-title">Approve</div><div class="card-sub">Let this device be controlled through WeavrNet.</div>
        <button class="btn block mt" data-action="approve" data-id="${esc(d.id)}">Approve device</button>` : ''}
      ${d.status === 'blocked' ? `<div class="card-title">Unblock</div><div class="card-sub">Allow this device to connect again.</div>
        <button class="btn ghost block mt" data-action="unblock" data-id="${esc(d.id)}">Unblock device</button>` : ''}
      ${d.status === 'approved' ? `<div class="card-title">Block</div><div class="card-sub">Disconnect this device and refuse it from now on.</div>
        <button class="btn danger block mt" data-action="block" data-id="${esc(d.id)}">Block device</button>` : ''}
    </div>
    <div class="card">
      <div class="card-title">Remove</div>
      <div class="card-sub">Forget this device. Weavr shows “Removed by admin” and stops reconnecting until someone on the TV re-enables WeavrNet.</div>
      <button class="btn danger block mt" data-action="remove" data-id="${esc(d.id)}">Remove device</button>
    </div>
  </div></div>`;
}

// ═══════════════════════════════════════════════════════════════
// ACTIONS
// ═══════════════════════════════════════════════════════════════
function sendCmd(command, extra = {}) {
  if (!S.selected) return;
  wsSend({ type: 'command', deviceId: S.selected, command, ...extra });
}

function sendPatch(patch, label) {
  if (!S.selected) return;
  const requestId = (crypto.randomUUID && crypto.randomUUID()) || String(Math.random()).slice(2);
  S.requests.set(requestId, { label });
  if (wsSend({ type: 'config.update', deviceId: S.selected, requestId, patch })) toast('Sending to device…');
}

function confirmAction(text) { return window.confirm(text); }

const actions = {
  select: (el) => { location.hash = `#/device/${el.dataset.id}`; },
  back: () => { history.length > 1 && location.hash ? history.back() : (location.hash = ''); },
  tab: (el) => { S.tab = el.dataset.tab; renderTab(); },
  cmd: (el) => {
    const extra = el.dataset.seconds ? { seconds: parseInt(el.dataset.seconds, 10) } : {};
    sendCmd(el.dataset.cmd, extra);
    if (el.dataset.cmd === 'refreshStream') toast('Refreshing stream…');
  },
  'toggle-play': () => {
    sendCmd(S.isPlaying ? 'pause' : 'play');
    S.isPlaying = !S.isPlaying;
    $('#playPauseBtn').textContent = S.isPlaying ? '⏸' : '▶';
  },
  'switch-source': (el) => { sendCmd('switchSource', { sourceIndex: parseInt(el.dataset.index, 10) }); toast('Switching source…'); },
  'seek-bar': (el, e) => {
    const diag = S.playback?.diagnostics;
    if (!diag?.durationMs) return;
    const r = el.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    sendCmd('seek', { positionMs: Math.floor(pct * diag.durationMs) });
  },
  approve: (el) => wsSend({ type: 'device.approve', deviceId: el.dataset.id }),
  unblock: (el) => wsSend({ type: 'device.unblock', deviceId: el.dataset.id }),
  block: (el) => {
    const d = S.devices.get(el.dataset.id);
    if (confirmAction(`Block ${d?.name || 'this device'}? It will be disconnected and refused until unblocked.`)) {
      wsSend({ type: 'device.block', deviceId: el.dataset.id });
    }
  },
  remove: (el) => {
    const d = S.devices.get(el.dataset.id);
    if (confirmAction(`Remove ${d?.name || 'this device'} from WeavrNet?`)) wsSend({ type: 'device.remove', deviceId: el.dataset.id });
  },
  'preset-name': (el) => { $('#cfgName').value = el.dataset.name; },
  'save-name': () => {
    const name = $('#cfgName').value.trim();
    if (!name) return toast('Enter a room name', true);
    sendPatch({ deviceName: name }, 'Room name updated');
  },
  'set-icon': (el) => sendPatch({ appearance: { iconKey: el.dataset.key } }, 'Icon updated'),
  'set-bg': (el) => {
    const [bgType, bgColor1, bgColor2] = BG_PRESETS[+el.dataset.index];
    sendPatch({ appearance: { bgType, bgColor1, bgColor2 } }, 'Background updated');
  },
  'source-remove': (el) => {
    const s = (S.config?.sources || []).find((x) => x.id === el.dataset.id);
    if (confirmAction(`Remove source “${s?.name || ''}” from the device?`)) {
      sendPatch({ sources: { remove: [el.dataset.id] } }, 'Source removed');
    }
  },
  'source-add': (el) => openSourceSheet(el.dataset.type, null),
  'source-edit': (el) => {
    const s = (S.config?.sources || []).find((x) => x.id === el.dataset.id);
    if (s) openSourceSheet(s.type, s);
  },
  'refresh-sources': () => sendPatch({ refresh: true }, 'Refreshing sources on the TV'),
  'secret-save': (el) => {
    const input = $(`#sec-${el.dataset.key}`);
    const value = input.value.trim();
    if (!value) return toast('Enter a value first', true);
    input.value = '';
    sendPatch({ settings: { [el.dataset.key]: value } }, 'Key saved on device');
  },
  'secret-clear': (el) => {
    if (confirmAction('Clear this key on the device?')) sendPatch({ settings: { [el.dataset.key]: '' } }, 'Key cleared');
  },
  'open-server': () => openServerSheet(),
  'close-sheet': () => closeSheet(),
  'gen-join-key': () => {
    const bytes = crypto.getRandomValues(new Uint8Array(12));
    $('#srvJoinKey').value = [...bytes].map((b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 32]).join('').replace(/(.{4})(?!$)/g, '$1-');
  },
  copy: (el) => {
    navigator.clipboard?.writeText(el.dataset.text).then(() => toast('Copied'), () => toast('Copy failed', true));
  },
  logout: async () => {
    await api('POST', '/api/logout').catch(() => {});
    if (S.ws) { S.ws.onclose = null; S.ws.close(); }
    closeSheet();
    location.hash = '';
    showAuth(false);
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'INPUT') return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  // Buttons inside a clickable card shouldn't also select the card.
  e.stopPropagation();
  e.preventDefault();
  Promise.resolve(fn(el, e)).catch((ex) => toast(ex.message, true));
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.device-card[data-action]')) {
    e.preventDefault();
    e.target.click();
  }
  if (e.key === 'Escape') closeSheet();
});

document.addEventListener('change', (e) => {
  const el = e.target;
  switch (el.dataset.action) {
    case 'source-toggle':
      sendPatch({ sources: { update: [{ id: el.dataset.id, enabled: el.checked }] } }, el.checked ? 'Source enabled' : 'Source disabled');
      break;
    case 'setting-toggle':
      sendPatch({ settings: { [el.dataset.key]: el.checked } }, 'Setting updated');
      break;
    case 'volume':
      sendCmd('setVolume', { volume: parseInt(el.value, 10) });
      break;
    default:
  }
});

// Re-render settings that changed while the admin was typing in them.
document.addEventListener('focusout', () => {
  setTimeout(() => {
    if (S.settingsDirty && S.tab === 'settings' && !$('#tab-settings')?.contains(document.activeElement)) renderTab();
  }, 0);
});

// ═══════════════════════════════════════════════════════════════
// SHEETS
// ═══════════════════════════════════════════════════════════════
function openSheet(title, body, onSubmit) {
  closeSheet();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-backdrop';
  wrap.id = 'sheet';
  wrap.innerHTML = `<form class="sheet" novalidate>
      <div class="sheet-grip"></div>
      <div class="sheet-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-action="close-sheet" aria-label="Close">✕</button></div>
      ${body}
    </form>`;
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) closeSheet(); });
  if (onSubmit) {
    wrap.querySelector('form').addEventListener('submit', (e) => {
      e.preventDefault();
      Promise.resolve(onSubmit(e.submitter)).catch((ex) => toast(ex.message, true));
    });
  }
  document.body.appendChild(wrap);
  const first = wrap.querySelector('input');
  if (first && window.matchMedia('(min-width:900px)').matches) first.focus();
}

function closeSheet() { $('#sheet')?.remove(); }

function openSourceSheet(type, src) {
  const isX = type === 'xtream';
  const field = (id, label, value, attrs = '') => `<label class="label" for="${id}">${label}</label>
    <input class="input" id="${id}" value="${esc(value || '')}" ${attrs}>`;
  const body = `<div class="stack">
    ${field('srcName', 'Name', src?.name, 'required maxlength="60" placeholder="My provider"')}
    ${isX
    ? `${field('srcHost', 'Server URL', src?.xtreamHost, 'required inputmode="url" placeholder="http://provider.example:8080"')}
       ${field('srcUser', 'Username', src?.xtreamUsername, 'required autocomplete="off"')}
       <label class="label" for="srcPass">Password</label>
       <input class="input" id="srcPass" type="password" autocomplete="new-password" placeholder="${src?.hasPassword ? 'Leave blank to keep the current password' : ''}">`
    : field('srcUrl', 'M3U URL', src?.m3uUrl, 'required inputmode="url" placeholder="https://example.com/playlist.m3u"')}
    <button class="btn block mt" type="submit">${src ? 'Save source' : 'Add source'}</button>
  </div>`;
  openSheet(src ? `Edit ${isX ? 'Xtream' : 'M3U'} source` : `Add ${isX ? 'Xtream' : 'M3U'} source`, body, () => {
    const name = $('#srcName').value.trim();
    const entry = { name };
    if (isX) {
      entry.xtreamHost = $('#srcHost').value.trim();
      entry.xtreamUsername = $('#srcUser').value.trim();
      const pass = $('#srcPass').value;
      if (pass || !src) entry.xtreamPassword = pass;
      if (!entry.xtreamHost || !entry.xtreamUsername) return toast('Server URL and username are required', true);
    } else {
      entry.m3uUrl = $('#srcUrl').value.trim();
      if (!/^https?:\/\//i.test(entry.m3uUrl)) return toast('Enter an http(s) M3U URL', true);
    }
    if (!name) return toast('Give the source a name', true);
    if (src) sendPatch({ sources: { update: [{ id: src.id, ...entry }] } }, 'Source updated');
    else sendPatch({ sources: { add: [{ type, ...entry }] } }, 'Source added — the TV is refreshing');
    closeSheet();
  });
}

async function openServerSheet() {
  let st;
  try { st = await api('GET', '/api/settings'); } catch (e) { toast(e.message, true); return; }
  const lockNote = '<div class="card-sub">Set by an environment variable on the server.</div>';
  const addr = location.host;
  const body = `
    <div class="card">
      <div class="card-title">Connect Weavr to this server</div>
      <div class="card-sub">On the TV: Settings → Companion → WeavrNet, then enter this address and keep it switched on.</div>
      <div class="code mt"><span>${esc(addr)}</span><button type="button" class="btn sm ghost" data-action="copy" data-text="${esc(addr)}">Copy</button></div>
    </div>
    <div class="card">
      <label class="label" for="srvName">Server name</label>
      <input class="input" id="srvName" maxlength="64" value="${esc(st.serverName)}" ${st.locked.serverName ? 'disabled' : ''}>
      ${st.locked.serverName ? lockNote : ''}
    </div>
    <div class="card">
      <div class="row"><div class="grow"><div class="card-title">Require approval</div>
        <div class="card-sub">New devices wait in “Waiting for approval” until an admin approves them. When off, a device is added as soon as its handshake completes.</div></div>
        ${switchHtml('id="srvApproval"', st.requireApproval, st.locked.requireApproval)}</div>
      ${st.locked.requireApproval ? lockNote : ''}
    </div>
    <div class="card">
      <label class="label" for="srvJoinKey">Join key (optional)</label>
      <div class="card-sub" style="margin-bottom:8px">If set, new devices must enter this key in Weavr to register. Already-registered devices are not affected.</div>
      <div class="row">
        <input class="input grow" id="srvJoinKey" maxlength="128" autocomplete="off" value="${esc(st.joinKey)}" placeholder="No join key" ${st.locked.joinKey ? 'disabled' : ''}>
        ${st.locked.joinKey ? '' : '<button type="button" class="btn sm ghost" data-action="gen-join-key">Generate</button>'}
      </div>
      ${st.locked.joinKey ? lockNote : ''}
    </div>
    <button class="btn block mt" type="submit" name="save">Save server settings</button>

    <div class="section-title" style="margin-top:22px">Admin password</div>
    <div class="card stack">
      <input class="input" id="pwCurrent" type="password" autocomplete="current-password" placeholder="Current password">
      <input class="input" id="pwNext" type="password" autocomplete="new-password" placeholder="New password (8+ characters)">
      <button class="btn ghost block" type="submit" name="password">Change password</button>
    </div>
    <button type="button" class="btn danger block mt" data-action="logout">Sign out</button>`;
  openSheet('Server settings', body, async (submitter) => {
    if (submitter?.name === 'password') {
      await api('POST', '/api/password', { current: $('#pwCurrent').value, next: $('#pwNext').value });
      $('#pwCurrent').value = '';
      $('#pwNext').value = '';
      toast('Password changed. Other sessions were signed out.');
      return;
    }
    await api('PUT', '/api/settings', {
      serverName: $('#srvName').value,
      requireApproval: $('#srvApproval').checked,
      joinKey: $('#srvJoinKey').value,
    });
    toast('Server settings saved');
    closeSheet();
  });
}

// ═══════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════
let toastTimer;
function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('error', !!isError);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// Keep "seen 5m ago" labels fresh.
setInterval(() => { if (!$('#app').hidden) { renderDeviceList(); renderHeader(); } }, 30000);

boot();
