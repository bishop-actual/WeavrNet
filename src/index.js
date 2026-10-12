'use strict';
// WeavrNet entry point: HTTP API + static web app + the two WebSocket
// endpoints (/agent for Weavr devices, /ws for signed-in admin browsers).

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { WebSocketServer } = require('ws');

const { load } = require('./config');
const { Store } = require('./store');
const { Hub, PROTOCOL } = require('./hub');
const {
  SESSION_COOKIE, hashPassword, verifyPassword, Sessions, Throttle, parseCookies, safeEqual,
} = require('./auth');
const { version } = require('../package.json');
const { TOKEN_RE } = require('./link');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // Posters and backdrops come from whatever hosts the IPTV/TMDB sources use.
  'Content-Security-Policy': "default-src 'self'; img-src * data:; style-src 'self' 'unsafe-inline'; "
    + "script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};

function createServer(config = load(), { log = console } = {}) {
  const store = new Store(config.dataDir);
  // Changes on every start. The web app uses it to spot two different
  // WeavrNet containers answering at the same address.
  const instance = crypto.randomBytes(6).toString('hex');
  // Fingerprint of the web app's files. The page compares it with the
  // server's whenever it connects and reloads itself after an update, so a
  // home-screen app (which never reloads on its own) can't get stuck on an
  // old version.
  const assets = (() => {
    const h = crypto.createHash('sha256');
    for (const f of ['index.html', 'app.js', 'app.css']) {
      try { h.update(fs.readFileSync(path.join(config.publicDir, f))); } catch (_) {}
    }
    return h.digest('hex').slice(0, 12);
  })();
  const sessions = new Sessions(store, config.sessionDays);
  const throttle = new Throttle();
  const hub = new Hub({ store, config, log });
  hub.instance = instance;
  hub.assets = assets;

  // An env-provided password always wins, so a lost password can be reset
  // by restarting the container with WEAVRNET_ADMIN_PASSWORD set.
  if (config.adminPassword && !verifyPassword(config.adminPassword, store.data.admin.passwordHash)) {
    store.data.admin.passwordHash = hashPassword(config.adminPassword);
    store.flush();
    log.info(`[auth] admin password set from WEAVRNET_ADMIN_PASSWORD (${config.adminPassword.length} characters)`);
  }
  sessions.prune();

  const setupRequired = () => !store.data.admin.passwordHash;

  // Forgotten password: a one-time code written to the container log, so
  // whoever can run `docker logs` can get back in whatever the compose file says.
  const RESET_TTL_MS = 15 * 60 * 1000;
  const reset = { hash: null, expires: 0, attempts: 0, lastRequest: 0 };
  const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

  const clientIp = (req) => {
    if (config.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return fwd.split(',')[0].trim();
    }
    return req.socket.remoteAddress;
  };

  const isSecure = (req) => !!req.socket.encrypted
    || (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');

  const sessionToken = (req) => parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const authed = (req) => sessions.valid(sessionToken(req));

  // Browsers always send Origin on cross-site writes and WebSocket upgrades;
  // reject any that don't match the host we're being served from.
  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return true;
    const host = (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
    try { return new URL(origin).host === host; } catch (_) { return false; }
  };

  const json = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(body));
  };

  const cookie = (req, token, maxAge) => [
    `${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`,
    ...(isSecure(req) ? ['Secure'] : []),
  ].join('; ');

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 64 * 1024) { reject(Object.assign(new Error('Body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (_) {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });

  const startSession = (req, res, body) => {
    const token = sessions.create({ ua: String(req.headers['user-agent'] || '').slice(0, 120) });
    json(res, 200, body, { 'Set-Cookie': cookie(req, token, config.sessionDays * 86400) });
  };

  async function api(req, res, url) {
    const route = `${req.method} ${url.pathname}`;
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && !sameOrigin(req)) return json(res, 403, { error: 'Cross-origin request refused' });
    if (write && !/application\/json/.test(req.headers['content-type'] || '') && req.headers['content-length'] !== '0') {
      return json(res, 415, { error: 'Expected application/json' });
    }

    switch (route) {
      case 'GET /api/health':
        return json(res, 200, { ok: true });

      // Public probe the Weavr app uses to test an address before saving it.
      case 'GET /api/ping':
        return json(res, 200, { app: 'weavrnet', version, protocol: PROTOCOL, server: hub.serverInfo() });

      case 'GET /api/status':
        return json(res, 200, {
          app: 'weavrnet', version, instance, assets, setupRequired: setupRequired(), authenticated: authed(req),
          server: hub.serverInfo(),
        });

      case 'POST /api/setup': {
        if (!setupRequired()) return json(res, 409, { error: 'Already set up' });
        const { password } = await readBody(req);
        if (typeof password !== 'string' || password.length < 8) {
          return json(res, 400, { error: 'Password must be at least 8 characters' });
        }
        store.data.admin.passwordHash = hashPassword(password);
        store.flush();
        log.info('[auth] admin password set via first-run setup');
        return startSession(req, res, { ok: true });
      }

      case 'POST /api/login': {
        const ip = clientIp(req);
        if (throttle.blocked(ip)) {
          const wait = throttle.retryAfter(ip);
          return json(res, 429, {
            error: `Too many wrong passwords. Try again in ${Math.ceil(wait / 60)} minute(s), or use “Forgot password?”.`,
            retryAfterSeconds: wait,
          });
        }
        const { password } = await readBody(req);
        if (!verifyPassword(password, store.data.admin.passwordHash)) {
          throttle.fail(ip);
          log.warn('[auth] failed sign-in (wrong password)');
          // Says whether the compose file's WEAVRNET_ADMIN_PASSWORD decides the
          // password, which is the usual reason a "right" password fails.
          return json(res, 401, { error: 'Incorrect password', fromEnv: !!config.adminPassword });
        }
        throttle.reset(ip);
        return startSession(req, res, { ok: true });
      }

      case 'POST /api/reset/request': {
        if (Date.now() - reset.lastRequest < 20 * 1000) {
          return json(res, 429, { error: 'A code was just written to the log. Wait a few seconds before asking again.' });
        }
        reset.lastRequest = Date.now();
        const code = String(crypto.randomInt(0, 100000000)).padStart(8, '0');
        Object.assign(reset, { hash: sha256(code), expires: Date.now() + RESET_TTL_MS, attempts: 0 });
        log.warn(`[auth] Password reset code: ${code.slice(0, 4)}-${code.slice(4)} `
          + '(valid 15 minutes). Enter it on the WeavrNet sign-in page.');
        return json(res, 200, { ok: true });
      }

      case 'POST /api/reset/confirm': {
        const { code, password } = await readBody(req);
        if (!reset.hash || Date.now() > reset.expires) {
          return json(res, 400, { error: 'That code has expired. Ask for a new one.' });
        }
        if (reset.attempts >= 5) {
          reset.hash = null;
          return json(res, 429, { error: 'Too many wrong codes. Ask for a new one.' });
        }
        if (!safeEqual(sha256(String(code || '').replace(/\D/g, '')), reset.hash)) {
          reset.attempts++;
          return json(res, 401, { error: 'That code isn\'t right. Use the newest code in the log.' });
        }
        if (typeof password !== 'string' || password.length < 8) {
          return json(res, 400, { error: 'Password must be at least 8 characters' });
        }
        reset.hash = null;
        store.data.admin.passwordHash = hashPassword(password);
        sessions.destroyAll();
        hub.links.revokeAll();
        throttle.hits.clear();
        store.flush();
        log.info('[auth] admin password reset with a code from the log');
        return startSession(req, res, { ok: true, fromEnv: !!config.adminPassword });
      }

      case 'POST /api/logout':
        sessions.destroy(sessionToken(req));
        return json(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
      default:
    }

    if (!authed(req)) return json(res, 401, { error: 'Sign in required' });

    switch (route) {
      case 'GET /api/devices':
        return json(res, 200, { devices: hub.deviceList() });

      case 'GET /api/settings':
        return json(res, 200, hub.settings());

      case 'PUT /api/settings':
        return json(res, 200, hub.updateSettings(await readBody(req)));

      case 'POST /api/password': {
        const { current, next } = await readBody(req);
        if (!verifyPassword(current, store.data.admin.passwordHash)) return json(res, 401, { error: 'Current password is incorrect' });
        if (typeof next !== 'string' || next.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
        store.data.admin.passwordHash = hashPassword(next);
        sessions.destroyAll();
        hub.links.revokeAll();
        store.flush();
        return startSession(req, res, { ok: true });
      }
      default:
        return json(res, 404, { error: 'Not found' });
    }
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA fallback
    const file = path.join(config.publicDir, path.normalize(rel));
    if (!file.startsWith(config.publicDir + path.sep)) { res.writeHead(400); return res.end(); }
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404, SECURITY_HEADERS); return res.end('Not found'); }
      const page = path.basename(file) === 'index.html';
      if (page) {
        // Stamp the page with its version and version its script and styles,
        // so no cache anywhere can pair a new page with old code or vice versa.
        buf = Buffer.from(buf.toString()
          .replace('<meta charset="UTF-8">', `<meta charset="UTF-8">\n<meta name="weavrnet-assets" content="${assets}">`)
          .replace('href="/app.css"', `href="/app.css?v=${assets}"`)
          .replace('src="/app.js"', `src="/app.js?v=${assets}"`));
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': page ? 'no-store' : 'no-cache',
        ...SECURITY_HEADERS,
      });
      res.end(req.method === 'HEAD' ? undefined : buf);
    });
  }

  const handler = (req, res) => {
    // Lets the web app tell WeavrNet's own answers from a proxy's error page.
    res.setHeader('X-WeavrNet', version);
    res.setHeader('X-WeavrNet-Instance', instance);
    res.setHeader('X-WeavrNet-Assets', assets);
    const url = new URL(req.url, 'http://localhost');
    const link = url.pathname.match(/^\/link\/([^/]+)\/(.*)$/);
    if (link) {
      hub.links.http(req, res, link[1], link[2] + url.search).catch((e) => {
        log.error(e);
        if (!res.headersSent) { res.writeHead(500); res.end(); }
      });
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      api(req, res, url).catch((e) => {
        if (!e.status) log.error(e);
        if (!res.headersSent) json(res, e.status || 500, { error: e.status ? e.message : 'Server error' });
      });
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    serveStatic(req, res, url);
  };

  const server = config.tlsCert && config.tlsKey
    ? https.createServer({ cert: fs.readFileSync(config.tlsCert), key: fs.readFileSync(config.tlsKey) }, handler)
    : http.createServer(handler);

  const agentWss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const uiWss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });
  const linkWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    const refuse = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const link = pathname.match(/^\/link\/([^/]+)\/(.*)$/);
    if (link) {
      // Authorised by the token alone: the sandboxed page has an opaque
      // origin (Origin: null) and no cookies.
      const deviceId = TOKEN_RE.test(link[1]) ? hub.links.resolve(link[1]) : null;
      if (!deviceId) return refuse(404, 'Not Found');
      if (!hub.links.available(deviceId)) return refuse(503, 'Service Unavailable');
      const search = new URL(req.url, 'http://localhost').search;
      linkWss.handleUpgrade(req, socket, head, (ws) => hub.links.socket(ws, deviceId, link[2] + search));
      return;
    }
    if (pathname === '/agent') {
      agentWss.handleUpgrade(req, socket, head, (ws) => hub.attachAgent(ws, clientIp(req)));
    } else if (pathname === '/ws') {
      if (!sameOrigin(req)) return refuse(403, 'Forbidden');
      if (!authed(req)) return refuse(401, 'Unauthorized');
      uiWss.handleUpgrade(req, socket, head, (ws) => hub.attachUi(ws));
    } else {
      refuse(404, 'Not Found');
    }
  });

  server.on('close', () => { hub.close(); store.flush(); });

  return { server, hub, store, config };
}

if (require.main === module) {
  let created;
  try {
    created = createServer();
  } catch (e) {
    console.error(`[weavrnet] ${e.message}`);
    process.exit(1);
  }
  const { server, store, config } = created;
  server.listen(config.port, config.host, () => {
    const scheme = config.tlsCert ? 'https' : 'http';
    console.log(`[weavrnet] v${version} listening on ${scheme}://${config.host}:${config.port}`);
    console.log(`[weavrnet] data dir: ${config.dataDir}`);
    if (!store.data.admin.passwordHash) {
      console.log('[weavrnet] No admin password yet — open the web UI to finish setup.');
    }
  });
  const shutdown = () => {
    console.log('[weavrnet] shutting down');
    store.flush();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer };
