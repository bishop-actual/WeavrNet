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

function start(env = {}) {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weavrnet-test-'));
  const config = load({ PORT: '0', DATA_DIR: dataDir, ...env });
  const created = createServer(config, { log: quiet });
  return new Promise((resolve) => created.server.listen(0, '127.0.0.1', () => {
    resolve({ ...created, base: `127.0.0.1:${created.server.address().port}` });
  }));
}

async function request(method, p, { body, cookie, origin } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (origin) headers.origin = origin;
  const res = await fetch(`http://${base}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, body: await res.json().catch(() => null), cookie: setCookie && setCookie.split(';')[0] };
}

/** Opens a socket and buffers incoming messages so tests can await by type. */
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
    const types = [].concat(type);
    const match = (m) => types.includes(m.type) && pred(m);
    const i = queue.findIndex(match);
    if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 3000);
      waiters.push({ match, resolve: (m) => { clearTimeout(t); resolve(m); } });
    });
  };
  ws.sendJson = (m) => ws.send(JSON.stringify(m));
  ws.closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
  ws.opened = new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
  return ws;
}

async function agent({ deviceId = crypto.randomUUID(), secret = crypto.randomBytes(32).toString('base64url'), joinKey, name = 'Lounge' } = {}) {
  const ws = socket(`ws://${base}/agent`);
  await ws.opened;
  ws.sendJson({ type: 'hello', protocol: 1, deviceId, deviceName: name, shortCode: 'ABC123', platform: 'test', joinKey });
  const msg = await ws.next(['challenge', 'rejected']);
  if (msg.type === 'rejected') return { ws, rejected: msg, deviceId, secret };
  ws.sendJson(msg.known
    ? { type: 'auth', proof: crypto.createHmac('sha256', secret).update(msg.nonce).digest('base64') }
    : { type: 'auth', secret });
  const res = await ws.next(['welcome', 'rejected']);
  return { ws, deviceId, secret, known: msg.known, welcome: res.type === 'welcome' ? res : null, rejected: res.type === 'rejected' ? res : null };
}

let cookie;

before(async () => {
  srv = await start();
  base = srv.base;
});

after(() => new Promise((resolve) => {
  for (const ws of sockets) ws.terminate();
  srv.server.closeAllConnections?.();
  srv.server.close(() => { fs.rmSync(dataDir, { recursive: true, force: true }); resolve(); });
}));

test('first-run setup creates the admin and signs in', async () => {
  let r = await request('GET', '/api/status');
  assert.equal(r.body.setupRequired, true);
  r = await request('POST', '/api/setup', { body: { password: 'short' } });
  assert.equal(r.status, 400);
  r = await request('POST', '/api/setup', { body: { password: 'correct horse battery' } });
  assert.equal(r.status, 200);
  cookie = r.cookie;
  assert.match(cookie, /^weavrnet_session=/);
  r = await request('POST', '/api/setup', { body: { password: 'another password' } });
  assert.equal(r.status, 409);
  r = await request('GET', '/api/status', { cookie });
  assert.equal(r.body.authenticated, true);
});

test('login rejects bad passwords and cross-origin writes', async () => {
  let r = await request('POST', '/api/login', { body: { password: 'nope' } });
  assert.equal(r.status, 401);
  r = await request('POST', '/api/login', { body: { password: 'correct horse battery' }, origin: 'https://evil.example' });
  assert.equal(r.status, 403);
  r = await request('POST', '/api/login', { body: { password: 'correct horse battery' } });
  assert.equal(r.status, 200);
  r = await request('GET', '/api/devices');
  assert.equal(r.status, 401);
});

test('admin socket requires a session', async () => {
  const anon = new WebSocket(`ws://${base}/ws`);
  const err = await new Promise((resolve) => anon.on('unexpected-response', (_, res) => resolve(res.statusCode)));
  assert.equal(err, 401);
});

test('device registers, relays state and commands, and re-authenticates by HMAC', async () => {
  const ui = socket(`ws://${base}/ws`, { cookie });
  const hello = await ui.next('hello');
  assert.ok(Array.isArray(hello.devices));

  const a = await agent({ name: 'Den' });
  assert.equal(a.known, false);
  assert.equal(a.welcome.status, 'approved');
  const dev = await ui.next('device', (m) => m.device.id === a.deviceId);
  assert.equal(dev.device.online, true);
  assert.equal(dev.device.name, 'Den');

  ui.sendJson({ type: 'subscribe', deviceId: a.deviceId });
  await ui.next('device', (m) => m.device.id === a.deviceId);
  a.ws.sendJson({ type: 'state', data: { status: 'playing', title: 'News' } });
  const st = await ui.next('state', (m) => m.data?.title === 'News');
  assert.equal(st.deviceId, a.deviceId);

  ui.sendJson({ type: 'command', deviceId: a.deviceId, command: 'seek', positionMs: 5000, evil: 'x' });
  const cmd = await a.ws.next('command');
  assert.deepEqual(cmd.data, { command: 'seek', positionMs: 5000 });

  ui.sendJson({ type: 'command', deviceId: a.deviceId, command: 'rm -rf' });
  assert.match((await ui.next('error')).error, /Unknown command/);

  a.ws.close();
  await ui.next('device', (m) => m.device.id === a.deviceId && !m.device.online);

  // Reconnect with the pinned secret.
  const again = await agent({ deviceId: a.deviceId, secret: a.secret });
  assert.equal(again.known, true);
  assert.ok(again.welcome);
  again.ws.close();

  // Wrong secret for a known device is refused.
  const imposter = await agent({ deviceId: a.deviceId, secret: crypto.randomBytes(32).toString('base64url') });
  assert.equal(imposter.rejected.reason, 'authentication failed');
  assert.equal(await imposter.ws.closed, 4001);
  ui.close();
});

test('remote config edits round-trip through the device', async () => {
  const ui = socket(`ws://${base}/ws`, { cookie });
  await ui.next('hello');
  const a = await agent();
  ui.sendJson({ type: 'subscribe', deviceId: a.deviceId });

  ui.sendJson({ type: 'config.update', deviceId: a.deviceId, requestId: 'r0', patch: { deviceName: 'X' } });
  assert.match((await ui.next('error')).error, /Remote editing is turned off/);

  a.ws.sendJson({ type: 'config', data: { allowRemoteEdit: true, deviceName: 'Lounge', sources: [] } });
  await ui.next('config', (m) => m.data?.deviceName === 'Lounge');

  ui.sendJson({ type: 'config.update', deviceId: a.deviceId, requestId: 'r1', patch: { deviceName: 'Kitchen' } });
  const upd = await a.ws.next('config.update');
  assert.deepEqual(upd.patch, { deviceName: 'Kitchen' });
  a.ws.sendJson({ type: 'config.result', requestId: upd.requestId, ok: true });
  const res = await ui.next('config.result');
  assert.equal(res.ok, true);
  assert.equal(res.requestId, 'r1');

  // Turning remote edit off on the device withdraws its config.
  a.ws.sendJson({ type: 'config', data: null });
  await ui.next('config', (m) => m.data === null);
  a.ws.close();
  ui.close();
});

test('approval mode holds new devices until the admin approves them', async () => {
  let r = await request('PUT', '/api/settings', { cookie, body: { requireApproval: true, joinKey: 'sesame' } });
  assert.equal(r.body.requireApproval, true);

  const noKey = await agent();
  assert.equal(noKey.rejected.reason, 'join key required');
  assert.equal(await noKey.ws.closed, 4005);

  const ui = socket(`ws://${base}/ws`, { cookie });
  await ui.next('hello');
  const a = await agent({ joinKey: 'sesame' });
  assert.equal(a.welcome.status, 'pending');
  ui.sendJson({ type: 'command', deviceId: a.deviceId, command: 'play' });
  assert.match((await ui.next('error')).error, /not approved/);

  ui.sendJson({ type: 'device.approve', deviceId: a.deviceId });
  await a.ws.next('approved');
  await ui.next('device', (m) => m.device.id === a.deviceId && m.device.status === 'approved');

  ui.sendJson({ type: 'device.block', deviceId: a.deviceId });
  assert.equal(await a.ws.closed, 4003);
  const blocked = await agent({ deviceId: a.deviceId, secret: a.secret });
  assert.equal(blocked.rejected.reason, 'blocked');

  ui.sendJson({ type: 'device.unblock', deviceId: a.deviceId });
  await ui.next('device', (m) => m.device.id === a.deviceId && m.device.status === 'approved');
  const back = await agent({ deviceId: a.deviceId, secret: a.secret });
  assert.ok(back.welcome);

  ui.sendJson({ type: 'device.remove', deviceId: a.deviceId });
  await back.ws.next('removed');
  assert.equal(await back.ws.closed, 4004);
  await ui.next('device.removed', (m) => m.deviceId === a.deviceId);

  r = await request('PUT', '/api/settings', { cookie, body: { requireApproval: false, joinKey: '' } });
  assert.equal(r.body.joinKey, '');
  ui.close();
});

test('state persists across restarts', async () => {
  srv.store.flush();
  const saved = JSON.parse(fs.readFileSync(path.join(dataDir, 'weavrnet.json'), 'utf8'));
  assert.ok(saved.admin.passwordHash.startsWith('scrypt$'));
  assert.ok(Object.keys(saved.devices).length >= 1);
  const mode = fs.statSync(path.join(dataDir, 'weavrnet.json')).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('static files are served without path traversal', async () => {
  let res = await fetch(`http://${base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  res = await fetch(`http://${base}/..%2fpackage.json`);
  assert.notEqual(res.status, 200);
});
