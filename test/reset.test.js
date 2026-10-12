'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../src/index');
const { load } = require('../src/config');

const lines = [];
const capture = { info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(String(m)) };
let srv;
let base;
let dataDir;

const post = (p, body, extra = {}) => fetch(`http://${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(body),
});
const latestCode = () => {
  const line = [...lines].reverse().find((l) => l.includes('Password reset code'));
  return line && line.match(/(\d{4}-\d{4})/)[1];
};

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'weavrnet-reset-'));
  const created = createServer(load({ DATA_DIR: dataDir }), { log: capture });
  srv = await new Promise((resolve) => created.server.listen(0, '127.0.0.1', () => resolve(created)));
  base = `127.0.0.1:${srv.server.address().port}`;
  assert.equal((await post('/api/setup', { password: 'original-pass' })).status, 200);
});

after(() => new Promise((resolve) => {
  srv.server.closeAllConnections?.();
  srv.server.close(() => { srv.store.flush(); srv.store.save = () => {}; fs.rmSync(dataDir, { recursive: true, force: true }); resolve(); });
}));

test('wrong password says so, and whether the compose file decides the password', async () => {
  const r = await post('/api/login', { password: 'nope' });
  assert.equal(r.status, 401);
  assert.deepEqual(await r.json(), { error: 'Incorrect password', fromEnv: false });
});

test('a code from the log resets the password and signs you in', async () => {
  let r = await post('/api/reset/request', {});
  assert.equal(r.status, 200);
  const code = latestCode();
  assert.match(code, /^\d{4}-\d{4}$/);

  // Asking again straight away is refused (no spamming the log).
  assert.equal((await post('/api/reset/request', {})).status, 429);

  r = await post('/api/reset/confirm', { code: '0000-0000', password: 'brand-new-pass' });
  assert.equal(r.status, 401);
  r = await post('/api/reset/confirm', { code, password: 'short' });
  assert.equal(r.status, 400);
  r = await post('/api/reset/confirm', { code, password: 'brand-new-pass' });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^weavrnet_session=/);

  assert.equal((await post('/api/login', { password: 'original-pass' })).status, 401);
  assert.equal((await post('/api/login', { password: 'brand-new-pass' })).status, 200);
  // A used code can't be reused.
  assert.equal((await post('/api/reset/confirm', { code, password: 'another-pass' })).status, 400);
});

test('a code stops working after 5 wrong guesses', async () => {
  // Bypass the 20 s request spacing for the test.
  const realNow = Date.now;
  Date.now = () => realNow() + 60 * 1000;
  try {
    assert.equal((await post('/api/reset/request', {})).status, 200);
  } finally { Date.now = realNow; }
  const code = latestCode();
  for (let i = 0; i < 5; i++) assert.equal((await post('/api/reset/confirm', { code: '1111-1111', password: 'whatever-pass' })).status, 401);
  assert.equal((await post('/api/reset/confirm', { code, password: 'whatever-pass' })).status, 429);
});

test('reset requests are refused cross-site', async () => {
  const r = await post('/api/reset/request', {}, { origin: 'https://evil.example' });
  assert.equal(r.status, 403);
});

test('too many wrong passwords says how long to wait', async () => {
  for (let i = 0; i < 10; i++) await post('/api/login', { password: 'wrong' });
  const r = await post('/api/login', { password: 'brand-new-pass' });
  assert.equal(r.status, 429);
  const body = await r.json();
  assert.match(body.error, /Try again in \d+ minute/);
  assert.ok(body.retryAfterSeconds > 0);
});
