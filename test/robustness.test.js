'use strict';
// Nothing a browser, bot or broken client sends may take the server down.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const { createServer } = require('../src/index');
const { load } = require('../src/config');

const quiet = { info() {}, warn() {}, error() {} };
let srv;
let port;
let dataDir;
let cookie;

const alive = async () => (await fetch(`http://127.0.0.1:${port}/api/health`)).status === 200;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weavrnet-robust-'));
  const created = createServer(load({ DATA_DIR: dataDir, WEAVRNET_ADMIN_PASSWORD: 'Password1234' }), { log: quiet });
  srv = await new Promise((resolve) => created.server.listen(0, '127.0.0.1', () => resolve(created)));
  port = srv.server.address().port;
  const r = await fetch(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"Password1234"}',
  });
  cookie = r.headers.get('set-cookie').split(';')[0];
});

after(() => new Promise((resolve) => {
  srv.server.closeAllConnections?.();
  srv.server.close(() => { srv.store.flush(); srv.store.save = () => {}; fs.rmSync(dataDir, { recursive: true, force: true }); resolve(); });
}));

test('a malformed cookie from another app on the domain is ignored', async () => {
  const bad = `other_app=50%; legacy=%u00e9; ${cookie}`;
  const st = await fetch(`http://127.0.0.1:${port}/api/status`, { headers: { cookie: bad } });
  assert.equal(st.status, 200);
  assert.equal((await st.json()).authenticated, true);

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: bad } });
  const hello = await new Promise((resolve, reject) => {
    ws.on('message', (m) => resolve(JSON.parse(m)));
    ws.on('error', reject);
  });
  assert.equal(hello.type, 'hello');
  ws.close();
  assert.ok(await alive());
});

test('a malformed web address gets 400, not a crash', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/%E0%A4%A`);
  assert.equal(res.status, 400);
  assert.ok(await alive());
});

test('raw malformed requests do not crash it', async () => {
  for (const line of ['GET http://[ HTTP/1.1', 'GET /%zz%%% HTTP/1.1', 'GET /ws HTTP/1.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: a=%']) {
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => s.end(`${line}\r\nHost: x\r\n\r\n`));
      s.on('data', () => {}); s.on('close', resolve); s.on('error', resolve);
    });
  }
  assert.ok(await alive());
});

test('an oversized or broken message on /agent closes that socket only', async () => {
  const big = new WebSocket(`ws://127.0.0.1:${port}/agent`);
  await new Promise((r) => big.on('open', r));
  big.on('error', () => {});
  big.send(Buffer.alloc(2 * 1024 * 1024, 97));
  assert.equal(await new Promise((r) => big.on('close', r)), 1009);

  // An invalid frame (reserved opcode) straight onto the socket.
  await new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(
      'GET /agent HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n'));
    s.once('data', () => s.write(Buffer.from([0x83, 0x80, 0, 0, 0, 0])));
    s.on('close', resolve); s.on('error', resolve);
    setTimeout(() => s.destroy(), 1000);
  });
  assert.ok(await alive());
});
