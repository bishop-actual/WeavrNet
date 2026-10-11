'use strict';
// WeavrLink over WeavrNet. Each signed-in admin who opens a device gets a
// capability URL, /link/<token>/, that serves that TV's own WeavrLink web app
// through the device's relay connection: HTTP requests become `http`
// messages to the TV, and WeavrLink's live socket is piped as `ws.*` messages.
//
// The TV's page is served with a CSP sandbox, so it runs in an opaque origin:
// whatever a TV sends can't read WeavrNet's session cookie or call its admin
// API. The token in the path is the only thing that authorises /link/ calls.

const crypto = require('crypto');

const TOKEN_IDLE_MS = 12 * 60 * 60 * 1000;
const RESPONSE_TIMEOUT_MS = 90 * 1000;
const MAX_BODY = 25 * 1024 * 1024;
const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

const LINK_HEADERS = {
  'Content-Security-Policy': "sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox "
    + "allow-modals allow-downloads; frame-ancestors 'self'",
  'Access-Control-Allow-Origin': '*',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
};
const PASS_RES = ['content-type', 'cache-control', 'content-disposition'];
const PASS_REQ = ['content-type', 'x-weavr-code', 'accept'];

class Links {
  constructor(hub, log = console) {
    this.hub = hub;
    this.log = log;
    this.tokens = new Map(); // token -> { deviceId, lastUsed }
    this.requests = new Map(); // id -> { res, deviceId, timer, started }
    this.sockets = new Map(); // sid -> { ws, deviceId }
  }

  /** Whether a device can serve WeavrLink right now. */
  available(deviceId) {
    const d = this.hub.store.data.devices[deviceId];
    return !!(d && d.status === 'approved' && this.hub.agents.has(deviceId)
      && Array.isArray(d.features) && d.features.includes('link'));
  }

  mint(deviceId) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.tokens.set(token, { deviceId, lastUsed: Date.now() });
    return token;
  }

  resolve(token) {
    if (!TOKEN_RE.test(token || '')) return null;
    const t = this.tokens.get(token);
    if (!t) return null;
    if (Date.now() - t.lastUsed > TOKEN_IDLE_MS) { this.tokens.delete(token); return null; }
    t.lastUsed = Date.now();
    return t.deviceId;
  }

  revokeDevice(deviceId) {
    for (const [tok, t] of this.tokens) if (t.deviceId === deviceId) this.tokens.delete(tok);
    this.deviceGone(deviceId);
  }

  revokeAll() {
    this.tokens.clear();
    for (const id of new Set([...this.sockets.values()].map((s) => s.deviceId))) this.deviceGone(id);
  }

  prune() {
    const now = Date.now();
    for (const [tok, t] of this.tokens) if (now - t.lastUsed > TOKEN_IDLE_MS) this.tokens.delete(tok);
  }

  _agent(deviceId) {
    return this.hub.agents.get(deviceId)?.ws;
  }

  _sendAgent(deviceId, msg) {
    const ws = this._agent(deviceId);
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(msg));
    return true;
  }

  // ── HTTP ──────────────────────────────────────────────────────────────────

  /** Handles GET/POST/OPTIONS /link/<token>/<rest>. */
  async http(req, res, token, rest) {
    const plain = (status, text) => {
      res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...LINK_HEADERS });
      res.end(text);
    };
    const deviceId = this.resolve(token);
    if (!deviceId) return plain(404, 'This WeavrLink session has expired. Go back and open the device again.');
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...LINK_HEADERS,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': '*',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    if (!['GET', 'HEAD', 'POST'].includes(req.method)) return plain(405, 'Method not allowed');
    if (!this.available(deviceId)) return plain(503, 'The TV is offline right now.');

    let body = null;
    if (req.method === 'POST') {
      try { body = await readRaw(req); } catch (e) { return plain(e.status || 400, e.message); }
    }
    const headers = {};
    for (const h of PASS_REQ) if (typeof req.headers[h] === 'string') headers[h] = req.headers[h];

    const id = crypto.randomUUID();
    const timer = setTimeout(() => this._finish(id, 504, 'The TV took too long to answer.'), RESPONSE_TIMEOUT_MS);
    this.requests.set(id, { res, deviceId, timer, started: false });
    res.on('close', () => { const r = this.requests.get(id); if (r) { clearTimeout(r.timer); this.requests.delete(id); } });

    const sent = this._sendAgent(deviceId, {
      type: 'http', id, method: req.method === 'HEAD' ? 'GET' : req.method,
      path: `/${rest}`, headers, body: body ? body.toString('base64') : null, base: `/link/${token}`,
    });
    if (!sent) this._finish(id, 503, 'The TV is offline right now.');
  }

  _finish(id, status, text) {
    const r = this.requests.get(id);
    if (!r) return;
    clearTimeout(r.timer);
    this.requests.delete(id);
    if (r.started) { r.res.end(); return; }
    r.res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...LINK_HEADERS });
    r.res.end(text);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────────

  /** Pipes a browser socket on /link/<token>/<rest> to the TV's WeavrLink socket. */
  socket(ws, deviceId, rest) {
    const sid = crypto.randomUUID();
    this.sockets.set(sid, { ws, deviceId });
    if (!this._sendAgent(deviceId, { type: 'ws.open', sid, path: `/${rest}` })) {
      this.sockets.delete(sid);
      ws.close(1013, 'TV offline');
      return;
    }
    ws.on('message', (data, isBinary) => {
      if (!isBinary) this._sendAgent(deviceId, { type: 'ws.msg', sid, data: data.toString() });
    });
    ws.on('close', () => {
      if (this.sockets.delete(sid)) this._sendAgent(deviceId, { type: 'ws.close', sid });
    });
  }

  // ── Messages from the TV ──────────────────────────────────────────────────

  /** Returns true if [msg] was a tunnel message from [deviceId]. */
  fromAgent(deviceId, msg) {
    switch (msg.type) {
      case 'http.res': {
        const r = this.requests.get(msg.id);
        if (!r || r.deviceId !== deviceId || r.started) return true;
        const headers = { ...LINK_HEADERS };
        if (msg.headers && typeof msg.headers === 'object') {
          for (const h of PASS_RES) if (typeof msg.headers[h] === 'string') headers[h] = msg.headers[h];
        }
        if (!headers['cache-control']) headers['Cache-Control'] = 'no-store';
        const status = Number.isInteger(msg.status) && msg.status >= 100 && msg.status < 600 ? msg.status : 502;
        r.res.writeHead(status, headers);
        r.started = true;
        return true;
      }
      case 'http.data': {
        const r = this.requests.get(msg.id);
        if (r && r.deviceId === deviceId && r.started && typeof msg.data === 'string') {
          r.res.write(Buffer.from(msg.data, 'base64'));
        }
        return true;
      }
      case 'http.end': {
        const r = this.requests.get(msg.id);
        if (r && r.deviceId === deviceId) this._finish(msg.id, 502, '');
        return true;
      }
      case 'ws.msg': {
        const s = this.sockets.get(msg.sid);
        if (s && s.deviceId === deviceId && typeof msg.data === 'string' && s.ws.readyState === 1) s.ws.send(msg.data);
        return true;
      }
      case 'ws.close': {
        const s = this.sockets.get(msg.sid);
        if (s && s.deviceId === deviceId) { this.sockets.delete(msg.sid); s.ws.close(1001, 'TV closed'); }
        return true;
      }
      default:
        return false;
    }
  }

  /** The TV's relay connection dropped: fail its requests and close its sockets. */
  deviceGone(deviceId) {
    for (const [id, r] of this.requests) if (r.deviceId === deviceId) this._finish(id, 503, 'The TV went offline.');
    for (const [sid, s] of this.sockets) {
      if (s.deviceId !== deviceId) continue;
      this.sockets.delete(sid);
      s.ws.close(1001, 'TV offline');
    }
  }
}

function readRaw(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = { Links, TOKEN_RE };
