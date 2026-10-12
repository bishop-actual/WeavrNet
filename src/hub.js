'use strict';
// The relay itself. Weavr devices ("agents") dial in on /agent and stay
// connected; admin browsers ("UIs") connect on /ws. The hub pairs them up:
// device state flows to subscribed UIs, commands and config edits flow back.

const crypto = require('crypto');
const { deviceProof, safeEqual } = require('./auth');
const { Links } = require('./link');

const PROTOCOL = 1;

const CLOSE = {
  REPLACED: 4000,
  AUTH_FAILED: 4001,
  PROTOCOL: 4002,
  BLOCKED: 4003,
  REMOVED: 4004,
  JOIN_KEY: 4005,
  HANDSHAKE_TIMEOUT: 4008,
};

// Same command set the WeavrLink companion page sends over the LAN.
const COMMANDS = new Set([
  'play', 'pause', 'seek', 'seekForward', 'seekBack', 'nextSource',
  'prevSource', 'switchSource', 'refreshStream', 'setVolume', 'stop',
]);
const COMMAND_ARGS = { positionMs: 'number', seconds: 'number', sourceIndex: 'number', volume: 'number' };

const HANDSHAKE_MS = 15000;
const CONFIG_TIMEOUT_MS = 20000;
const HEARTBEAT_MS = 30000;
// A TV busy with a big import can't answer pings for a while; only drop a
// device after this long without hearing anything from it.
const AGENT_SILENCE_MS = 150000;

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function parse(raw) {
  try {
    const msg = JSON.parse(raw.toString());
    return isObj(msg) && typeof msg.type === 'string' ? msg : null;
  } catch (_) {
    return null;
  }
}

function sanitizeAppearance(a) {
  if (!isObj(a)) return null;
  const out = {};
  for (const k of ['roomName', 'iconKey', 'iconColor', 'bgType', 'bgColor1', 'bgColor2']) {
    if (typeof a[k] === 'string') out[k] = a[k].slice(0, 64);
  }
  return out;
}

class Hub {
  constructor({ store, config, log = console }) {
    this.store = store;
    this.config = config;
    this.log = log;
    this.agents = new Map(); // deviceId -> { ws, ip, state, config, connectedAt }
    this.uis = new Set();    // { ws, deviceId }
    this.pending = new Map(); // requestId -> { ui, deviceId, timer }
    this.links = new Links(this, log);
    this._heartbeat = setInterval(() => this._beat(), HEARTBEAT_MS);
    this._heartbeat.unref();
  }

  close() {
    clearInterval(this._heartbeat);
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }

  // ── Settings ────────────────────────────────────────────────────────────

  settings() {
    const s = this.store.data.settings;
    const c = this.config;
    return {
      serverName: c.serverName ?? s.serverName,
      requireApproval: c.requireApproval ?? s.requireApproval,
      joinKey: c.joinKey ?? s.joinKey,
      locked: {
        serverName: c.serverName !== null,
        requireApproval: c.requireApproval !== null,
        joinKey: c.joinKey !== null,
      },
    };
  }

  updateSettings(patch) {
    const s = this.store.data.settings;
    const locked = this.settings().locked;
    if (typeof patch.serverName === 'string' && !locked.serverName) {
      s.serverName = patch.serverName.trim().slice(0, 64) || 'WeavrNet';
    }
    if (typeof patch.requireApproval === 'boolean' && !locked.requireApproval) {
      s.requireApproval = patch.requireApproval;
    }
    if (typeof patch.joinKey === 'string' && !locked.joinKey) {
      s.joinKey = patch.joinKey.trim().slice(0, 128);
    }
    this.store.save();
    this._broadcastUi({ type: 'server', server: this.serverInfo() });
    return this.settings();
  }

  serverInfo() {
    const s = this.settings();
    return { name: s.serverName, requireApproval: s.requireApproval, joinKeyRequired: !!s.joinKey };
  }

  // ── Device views ────────────────────────────────────────────────────────

  summary(id) {
    const d = this.store.data.devices[id];
    if (!d) return null;
    const live = this.agents.get(id);
    const st = live?.state;
    return {
      id,
      name: d.name,
      location: d.location || '',
      shortCode: d.shortCode,
      appearance: d.appearance,
      platform: d.platform,
      appVersion: d.appVersion,
      status: d.status,
      online: !!live,
      createdAt: d.createdAt,
      lastSeen: live ? Date.now() : d.lastSeen,
      link: Array.isArray(d.features) && d.features.includes('link'),
      remoteEdit: live ? live.remoteEdit : null,
      playback: st && d.status === 'approved'
        ? { status: st.status, title: st.title || null, subtitle: st.subtitle || null }
        : null,
    };
  }

  deviceList() {
    return Object.keys(this.store.data.devices)
      .map((id) => this.summary(id))
      .sort((a, b) => a.location.localeCompare(b.location) || (b.online - a.online) || a.name.localeCompare(b.name));
  }

  _deviceChanged(id) {
    const summary = this.summary(id);
    this._broadcastUi(summary ? { type: 'device', device: summary } : { type: 'device.removed', deviceId: id });
  }

  _broadcastUi(msg) {
    const raw = JSON.stringify(msg);
    for (const ui of this.uis) if (ui.ws.readyState === 1) ui.ws.send(raw);
  }

  _toSubscribers(id, msg) {
    const raw = JSON.stringify(msg);
    for (const ui of this.uis) {
      if (ui.deviceId === id && ui.ws.readyState === 1) ui.ws.send(raw);
    }
  }

  // ── Agents (Weavr devices) ──────────────────────────────────────────────

  attachAgent(ws, ip) {
    const conn = { ws, ip, stage: 'hello', id: null, nonce: null, hello: null };
    ws.lastHeard = Date.now();
    ws.on('pong', () => { ws.lastHeard = Date.now(); });

    const timer = setTimeout(() => {
      if (conn.stage !== 'ready') ws.close(CLOSE.HANDSHAKE_TIMEOUT, 'handshake timeout');
    }, HANDSHAKE_MS);

    ws.on('message', (raw) => {
      ws.lastHeard = Date.now();
      const msg = parse(raw);
      if (!msg) return;
      try {
        if (conn.stage === 'hello') this._agentHello(conn, msg);
        else if (conn.stage === 'auth') this._agentAuth(conn, msg);
        else if (conn.stage === 'ready') this._agentMessage(conn, msg);
      } catch (e) {
        this.log.error(`[agent ${conn.id || ip}] ${e.stack || e}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (conn.stage !== 'ready') return;
      const live = this.agents.get(conn.id);
      if (live && live.ws === ws) {
        this.agents.delete(conn.id);
        const d = this.store.data.devices[conn.id];
        if (d) { d.lastSeen = Date.now(); this.store.save(); }
        this._failPendingFor(conn.id, 'Device disconnected');
        this.links.deviceGone(conn.id);
        this._deviceChanged(conn.id);
        this.log.info(`[agent] ${conn.id} offline`);
      }
    });
  }

  _reject(conn, code, reason) {
    send(conn.ws, { type: 'rejected', reason });
    conn.stage = 'closed';
    conn.ws.close(code, reason);
  }

  _agentHello(conn, msg) {
    if (msg.type !== 'hello') return this._reject(conn, CLOSE.PROTOCOL, 'expected hello');
    if (!ID_RE.test(msg.deviceId || '')) return this._reject(conn, CLOSE.PROTOCOL, 'invalid deviceId');
    const known = this.store.data.devices[msg.deviceId];
    if (known?.status === 'blocked') return this._reject(conn, CLOSE.BLOCKED, 'blocked');

    // A join key only gates new devices, so rotating it never strands
    // devices that already registered.
    const { joinKey } = this.settings();
    if (!known && joinKey && !safeEqual(str(msg.joinKey, 128), joinKey)) {
      return this._reject(conn, CLOSE.JOIN_KEY, 'join key required');
    }

    conn.id = msg.deviceId;
    conn.hello = msg;
    conn.nonce = crypto.randomBytes(24).toString('base64');
    conn.stage = 'auth';
    send(conn.ws, { type: 'challenge', protocol: PROTOCOL, nonce: conn.nonce, known: !!known });
  }

  _agentAuth(conn, msg) {
    if (msg.type !== 'auth') return this._reject(conn, CLOSE.PROTOCOL, 'expected auth');
    const devices = this.store.data.devices;
    let d = devices[conn.id];
    const h = conn.hello;

    if (d) {
      if (!safeEqual(msg.proof || '', deviceProof(d.secret, conn.nonce))) {
        this.log.warn(`[agent] ${conn.id} failed authentication from ${conn.ip}`);
        return this._reject(conn, CLOSE.AUTH_FAILED, 'authentication failed');
      }
    } else {
      // First contact: the device picks its own secret and we pin it.
      const secret = str(msg.secret, 256);
      if (secret.length < 32) return this._reject(conn, CLOSE.PROTOCOL, 'secret too short');
      d = devices[conn.id] = {
        secret,
        status: this.settings().requireApproval ? 'pending' : 'approved',
        createdAt: Date.now(),
      };
      this.log.info(`[agent] registered ${conn.id} (${str(h.deviceName, 64)}) as ${d.status}`);
    }

    d.name = str(h.deviceName, 64) || d.name || 'Weavr';
    if (typeof h.locationName === 'string') d.location = str(h.locationName, 64);
    d.shortCode = str(h.shortCode, 12) || d.shortCode || '';
    d.appearance = sanitizeAppearance(h.appearance) || d.appearance || null;
    d.platform = str(h.platform, 32) || d.platform || '';
    d.appVersion = str(h.appVersion, 32) || d.appVersion || '';
    delete d.lastIp; // no longer kept
    d.features = Array.isArray(h.features) ? h.features.filter((f) => typeof f === 'string').slice(0, 16) : [];
    delete d.localAddress;
    d.lastSeen = Date.now();
    this.store.save();

    const prev = this.agents.get(conn.id);
    if (prev) {
      send(prev.ws, { type: 'rejected', reason: 'replaced by a newer connection' });
      prev.ws.close(CLOSE.REPLACED, 'replaced');
      this.links.deviceGone(conn.id);
    }
    this.agents.set(conn.id, { ws: conn.ws, ip: conn.ip, state: null, config: null, remoteEdit: null });
    conn.stage = 'ready';
    send(conn.ws, { type: 'welcome', protocol: PROTOCOL, deviceId: conn.id, status: d.status, server: this.serverInfo() });
    this._deviceChanged(conn.id);
    this.log.info(`[agent] ${conn.id} online from ${conn.ip}`);
  }

  _agentMessage(conn, msg) {
    const id = conn.id;
    const live = this.agents.get(id);
    const d = this.store.data.devices[id];
    if (!live || live.ws !== conn.ws || !d) return;
    const approved = d.status === 'approved';
    if (approved && this.links.fromAgent(id, msg)) return;

    switch (msg.type) {
      case 'state': {
        if (!isObj(msg.data)) return;
        const prev = live.state;
        live.state = msg.data;
        if (!approved) return;
        this._toSubscribers(id, { type: 'state', deviceId: id, data: msg.data });
        if (!prev || prev.status !== msg.data.status || prev.title !== msg.data.title) this._deviceChanged(id);
        return;
      }
      case 'diagnostics': {
        if (!isObj(msg.data)) return;
        if (live.state) live.state.diagnostics = msg.data;
        if (approved) this._toSubscribers(id, { type: 'diagnostics', deviceId: id, data: msg.data });
        return;
      }
      case 'profile': {
        d.name = str(msg.deviceName, 64) || d.name;
        if (typeof msg.locationName === 'string') d.location = str(msg.locationName, 64);
        if (typeof msg.shortCode === 'string') d.shortCode = str(msg.shortCode, 12);
        const a = sanitizeAppearance(msg.appearance);
        if (a) d.appearance = a;
        this.store.save();
        this._deviceChanged(id);
        return;
      }
      case 'config': {
        // A device that turned off remote editing sends config:null and
        // stops sharing its settings with the relay.
        live.config = isObj(msg.data) ? msg.data : null;
        live.remoteEdit = !!live.config;
        if (approved) this._toSubscribers(id, { type: 'config', deviceId: id, data: live.config });
        this._deviceChanged(id);
        return;
      }
      case 'notice': {
        // WeavrLink progress messages ("Source added — 120 movies…").
        if (approved && isObj(msg.data)) this._toSubscribers(id, { type: 'notice', deviceId: id, data: msg.data });
        return;
      }
      case 'config.result': {
        const p = this.pending.get(msg.requestId);
        if (!p || p.deviceId !== id) return;
        clearTimeout(p.timer);
        this.pending.delete(msg.requestId);
        send(p.ui.ws, {
          type: 'config.result', deviceId: id, requestId: msg.requestId,
          ok: msg.ok === true, error: msg.ok === true ? null : str(msg.error, 300) || 'Rejected by device',
        });
        return;
      }
      default:
    }
  }

  // ── Admin actions on devices ────────────────────────────────────────────

  approve(id) {
    const d = this.store.data.devices[id];
    if (!d || d.status === 'approved') return false;
    d.status = 'approved';
    this.store.save();
    const live = this.agents.get(id);
    if (live) {
      send(live.ws, { type: 'approved' });
      if (live.state) this._toSubscribers(id, { type: 'state', deviceId: id, data: live.state });
      if (live.config) this._toSubscribers(id, { type: 'config', deviceId: id, data: live.config });
    }
    this._deviceChanged(id);
    return true;
  }

  block(id) {
    const d = this.store.data.devices[id];
    if (!d) return false;
    d.status = 'blocked';
    this.store.save();
    this.links.revokeDevice(id);
    const live = this.agents.get(id);
    if (live) {
      send(live.ws, { type: 'rejected', reason: 'blocked' });
      live.ws.close(CLOSE.BLOCKED, 'blocked');
    }
    this._deviceChanged(id);
    return true;
  }

  unblock(id) {
    const d = this.store.data.devices[id];
    if (!d || d.status !== 'blocked') return false;
    d.status = 'approved';
    this.store.save();
    this._deviceChanged(id);
    return true;
  }

  remove(id) {
    if (!this.store.data.devices[id]) return false;
    delete this.store.data.devices[id];
    this.store.save();
    this.links.revokeDevice(id);
    const live = this.agents.get(id);
    if (live) {
      this.agents.delete(id);
      send(live.ws, { type: 'removed' });
      live.ws.close(CLOSE.REMOVED, 'removed');
    }
    this._failPendingFor(id, 'Device removed');
    this._deviceChanged(id);
    return true;
  }

  // ── UIs (admin browsers) ────────────────────────────────────────────────

  attachUi(ws) {
    const ui = { ws, deviceId: null };
    this.uis.add(ui);
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    send(ws, { type: 'hello', instance: this.instance, server: this.serverInfo(), devices: this.deviceList() });

    ws.on('message', (raw) => {
      const msg = parse(raw);
      if (!msg) return;
      try {
        this._uiMessage(ui, msg);
      } catch (e) {
        this.log.error(`[ui] ${e.stack || e}`);
      }
    });
    ws.on('close', () => {
      this.uis.delete(ui);
      for (const [rid, p] of this.pending) {
        if (p.ui === ui) { clearTimeout(p.timer); this.pending.delete(rid); }
      }
    });
  }

  _uiMessage(ui, msg) {
    const id = str(msg.deviceId, 64);
    const d = id ? this.store.data.devices[id] : null;
    const live = id ? this.agents.get(id) : null;
    const error = (text) => send(ui.ws, { type: 'error', deviceId: id || null, requestId: msg.requestId || null, error: text });

    switch (msg.type) {
      case 'subscribe': {
        ui.deviceId = d ? id : null;
        if (!d) return error('Unknown device');
        send(ui.ws, { type: 'device', device: this.summary(id) });
        if (d.status === 'approved' && live) {
          send(ui.ws, { type: 'state', deviceId: id, data: live.state });
          send(ui.ws, { type: 'config', deviceId: id, data: live.config });
        }
        return;
      }
      case 'unsubscribe':
        ui.deviceId = null;
        return;
      case 'command': {
        if (!d || d.status !== 'approved') return error('Device is not approved');
        if (!live) return error('Device is offline');
        const command = str(msg.command, 32);
        if (!COMMANDS.has(command)) return error(`Unknown command ${command}`);
        const data = { command };
        for (const [k, t] of Object.entries(COMMAND_ARGS)) {
          if (typeof msg[k] === t && Number.isFinite(msg[k])) data[k] = msg[k];
        }
        send(live.ws, { type: 'command', data });
        return;
      }
      case 'config.update': {
        if (!d || d.status !== 'approved') return error('Device is not approved');
        if (!live) return error('Device is offline');
        if (!live.config) return error('Remote editing is turned off on this device');
        if (!isObj(msg.patch)) return error('Missing patch');
        const requestId = str(msg.requestId, 64) || crypto.randomUUID();
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          send(ui.ws, { type: 'config.result', deviceId: id, requestId, ok: false, error: 'Device did not respond' });
        }, CONFIG_TIMEOUT_MS);
        this.pending.set(requestId, { ui, deviceId: id, timer });
        send(live.ws, { type: 'config.update', requestId, patch: msg.patch });
        return;
      }
      case 'device.approve': return this.approve(id) || error('Cannot approve device');
      case 'device.block': return this.block(id) || error('Cannot block device');
      case 'device.unblock': return this.unblock(id) || error('Cannot unblock device');
      case 'device.remove': return this.remove(id) || error('Cannot remove device');
      case 'link.open': {
        if (!d) return error('Unknown device');
        if (!this.links.available(id)) {
          return error(live ? 'Update Weavr on this TV to use WeavrLink through WeavrNet' : 'Device is offline');
        }
        const token = this.links.mint(id);
        const code = encodeURIComponent(d.shortCode || '');
        return send(ui.ws, { type: 'link', deviceId: id, url: `/link/${token}/?code=${code}` });
      }
      case 'ping': return send(ui.ws, { type: 'pong' });
      default: return error(`Unknown message ${msg.type}`);
    }
  }

  _failPendingFor(id, reason) {
    for (const [rid, p] of this.pending) {
      if (p.deviceId !== id) continue;
      clearTimeout(p.timer);
      this.pending.delete(rid);
      send(p.ui.ws, { type: 'config.result', deviceId: id, requestId: rid, ok: false, error: reason });
    }
  }

  _beat() {
    const now = Date.now();
    for (const { ws } of this.agents.values()) {
      if (now - ws.lastHeard > AGENT_SILENCE_MS) { ws.terminate(); continue; }
      try { ws.ping(); } catch (_) {}
      // App-level too: the Weavr app can't see protocol pings, and uses
      // these to notice a relay that has silently gone away.
      send(ws, { type: 'ping' });
    }
    for (const { ws } of this.uis) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (_) {}
    }
    this.links.prune();
  }
}

module.exports = { Hub, PROTOCOL, CLOSE, COMMANDS };
