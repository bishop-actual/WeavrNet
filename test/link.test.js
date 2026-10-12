'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../src/index');
const { load } = require('../src/config');

const quiet = { info() {}, warn() {}, error() {} };
let srv;
let base;
let dataDir;
let cookie;
const sockets = [];

function socket(url, headers) {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  const queue = [];
  const waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    const i = waiters.findIndex((w) => w.match(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg); else queue.push(msg);
  });
  ws.next = (type, pred = () => true) => {
    const match = (m) => m.type === type && pred(m);
    const i = queue.findIndex(match);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
      waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  ws.sendJson = (m) => ws.send(JSON.stringify(m));
  ws.opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return ws;
}

/** A fake TV whose "WeavrLink" answers a couple of routes and echoes its socket. */
async function linkAgent({ features = ['link'] } = {}) {
  const deviceId = crypto.randomUUID();
  const ws = socket(`ws://${base}/agent`);
  await ws.opened;
  ws.sendJson({ type: 'hello', protocol: 1, deviceId, deviceName: 'Tunnel TV', shortCode: 'TUN123', features, localAddress: '192.168.1.50:1111' });
  await ws.next('challenge');
  ws.sendJson({ type: 'auth', secret: crypto.randomBytes(32).toString('base64url') });
  await ws.next('welcome');
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    const reply = (status, type, text) => {
      ws.sendJson({ type: 'http.res', id: m.id, status, headers: { 'content-type': type, 'x-secret': 'no' } });
      const buf = Buffer.from(text);
      for (let i = 0; i < buf.length; i += 5) ws.sendJson({ type: 'http.data', id: m.id, data: buf.subarray(i, i + 5).toString('base64') });
      ws.sendJson({ type: 'http.end', id: m.id });
    };
    if (m.type === 'http') {
      if (m.path.startsWith('/api/echo')) {
        reply(200, 'application/json', JSON.stringify({
          method: m.method, path: m.path, base: m.base, code: m.headers['x-weavr-code'] || null,
          body: m.body ? Buffer.from(m.body, 'base64').toString() : null, cookie: m.headers.cookie || null,
        }));
      } else if (m.path === '/slow') {
        // never answers
      } else {
        reply(200, 'text/html; charset=utf-8', '<html>hello from the TV</html>');
      }
    }
    if (m.type === 'ws.open') ws.sendJson({ type: 'ws.msg', sid: m.sid, data: JSON.stringify({ type: 'state', path: m.path }) });
    if (m.type === 'ws.msg') ws.sendJson({ type: 'ws.msg', sid: m.sid, data: JSON.stringify({ type: 'echo', data: m.data }) });
  });
  return { ws, deviceId };
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weavrnet-link-'));
  const created = createServer(load({ PORT: '0', DATA_DIR: dataDir, WEAVRNET_ADMIN_PASSWORD: 'link-test-pass' }), { log: quiet });
  srv = await new Promise((resolve) => created.server.listen(0, '127.0.0.1', () => resolve(created)));
  base = `127.0.0.1:${srv.server.address().port}`;
  const res = await fetch(`http://${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'link-test-pass' }),
  });
  cookie = res.headers.get('set-cookie').split(';')[0];
});

after(() => new Promise((resolve) => {
  for (const ws of sockets) ws.terminate();
  srv.server.closeAllConnections?.();
  srv.server.close(() => { srv.store.flush(); srv.store.save = () => {}; fs.rmSync(dataDir, { recursive: true, force: true }); resolve(); });
}));

async function openLink(deviceId) {
  const ui = socket(`ws://${base}/ws`, { cookie });
  await ui.next('hello');
  ui.sendJson({ type: 'link.open', deviceId });
  return { ui, msg: await ui.next('link') };
}

test('WeavrLink pages and API calls are tunnelled to the TV, sandboxed', async () => {
  const { deviceId } = await linkAgent();
  const { msg } = await openLink(deviceId);
  assert.match(msg.url, /^\/link\/[A-Za-z0-9_-]{43}\/\?code=TUN123$/);
  const prefix = msg.url.split('?')[0];

  let res = await fetch(`http://${base}${msg.url}`);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<html>hello from the TV</html>');
  assert.match(res.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('x-secret'), null, 'only whitelisted headers pass');

  res = await fetch(`http://${base}${prefix}api/echo?x=1`, {
    method: 'POST', body: '{"a":1}', headers: { 'content-type': 'application/json', 'x-weavr-code': 'TUN123', cookie },
  });
  const echo = await res.json();
  assert.deepEqual(echo, {
    method: 'POST', path: '/api/echo?x=1', base: prefix.slice(0, -1), code: 'TUN123', body: '{"a":1}', cookie: null,
  });

  res = await fetch(`http://${base}${prefix}api/echo`, { method: 'OPTIONS' });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-headers'), '*');
});

test('WeavrLink socket is piped both ways', async () => {
  const { deviceId } = await linkAgent();
  const { msg } = await openLink(deviceId);
  const wsUrl = `ws://${base}${msg.url.split('?')[0]}ws?code=TUN123`;
  const ws = socket(wsUrl, { origin: 'null' });
  await ws.opened;
  const first = await ws.next('state');
  assert.equal(first.path, '/ws?code=TUN123');
  ws.send('{"command":"play"}');
  assert.equal((await ws.next('echo')).data, '{"command":"play"}');
});

test('bad tokens, old apps and offline TVs are refused', async () => {
  let res = await fetch(`http://${base}/link/${'x'.repeat(43)}/`);
  assert.equal(res.status, 404);

  const old = await linkAgent({ features: [] });
  const ui = socket(`ws://${base}/ws`, { cookie });
  await ui.next('hello');
  ui.sendJson({ type: 'link.open', deviceId: old.deviceId });
  assert.match((await ui.next('error')).error, /Update Weavr/);

  const { ws: tv, deviceId } = await linkAgent();
  const { msg } = await openLink(deviceId);
  tv.close();
  await new Promise((r) => setTimeout(r, 100));
  res = await fetch(`http://${base}${msg.url}`);
  assert.equal(res.status, 503);
});

test('a TV that goes away mid-request fails the request instead of hanging', async () => {
  const { ws: tv, deviceId } = await linkAgent();
  const { msg } = await openLink(deviceId);
  const pending = fetch(`http://${base}${msg.url.split('?')[0]}slow`);
  await new Promise((r) => setTimeout(r, 100));
  tv.close();
  const res = await pending;
  assert.equal(res.status, 503);
});

test('device summary reports link support', async () => {
  const { deviceId } = await linkAgent();
  const res = await fetch(`http://${base}/api/devices`, { headers: { cookie } });
  const d = (await res.json()).devices.find((x) => x.id === deviceId);
  assert.equal(d.link, true);
  assert.equal(d.lastIp, undefined);
  assert.equal(d.localAddress, undefined);
});

test('a busy TV that misses pings stays online until it has been silent a long time', async () => {
  const { ws: tv, deviceId } = await linkAgent();
  const live = srv.hub.agents.get(deviceId);
  live.ws.lastHeard = Date.now() - 90 * 1000; // missed three pings — e.g. mid-import
  srv.hub._beat();
  assert.equal(srv.hub.agents.has(deviceId), true);
  await tv.next('ping'); // app-level ping the Weavr watchdog listens for
  live.ws.lastHeard = Date.now() - 200 * 1000;
  srv.hub._beat();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(srv.hub.agents.has(deviceId), false);
});
