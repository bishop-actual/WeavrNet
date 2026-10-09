#!/usr/bin/env node
'use strict';
// A stand-in Weavr device for trying WeavrNet without a TV. It speaks the
// same /agent protocol as the app, pretends to play something, applies
// remote config edits to an in-memory copy and logs the commands it gets.
//
//   node tools/fake-agent.js ws://localhost:7780 --name "Test Lounge" [--location "Dad's house"] [--join-key KEY]

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const base = (args.find((a) => !a.startsWith('--') && /^(wss?|https?):/.test(a)) || 'ws://localhost:7780')
  .replace(/^http/, 'ws').replace(/\/+$/, '');
const name = flag('name', 'Fake Weavr');
const location = flag('location', '');
const idFile = path.join(os.tmpdir(), `weavrnet-fake-${name.replace(/\W+/g, '_')}.json`);

let identity;
try { identity = JSON.parse(fs.readFileSync(idFile, 'utf8')); } catch (_) {
  identity = { deviceId: crypto.randomUUID(), secret: crypto.randomBytes(32).toString('base64url') };
  fs.writeFileSync(idFile, JSON.stringify(identity));
}

const config = {
  allowRemoteEdit: true,
  deviceName: name,
  locationName: location,
  appearance: { roomName: name, iconKey: 'tv', iconColor: '#FFFFFF', bgType: 'gradient', bgColor1: '#0EA5FF', bgColor2: '#00D4B8' },
  sources: [
    { id: 'src-1', type: 'm3u', name: 'Demo M3U', enabled: true, m3uUrl: 'http://example.com/list.m3u', hasPassword: false },
    { id: 'src-2', type: 'xtream', name: 'Demo Xtream', enabled: false, xtreamHost: 'http://xt.example.com', xtreamUsername: 'demo', hasPassword: true },
  ],
  settings: { showFavouritesMenu: true, discoverEnabled: true, tmdbEnabled: false },
  secrets: { tmdbApiKey: false, omdbApiKey: false, traktClientId: false, fanartApiKey: false, mdblistApiKey: false },
  stats: { channels: 1234, movies: 560, series: 78 },
};

let playing = true;
let positionMs = 61000;
const state = () => ({
  status: playing ? 'playing' : 'paused',
  contentType: 'movie',
  title: 'Big Buck Bunny',
  subtitle: '2008 · Animation',
  posterUrl: null,
  backdropUrl: null,
  deviceName: config.deviceName,
  shortCode: 'FAK123',
  updatedAt: new Date().toISOString(),
  diagnostics: {
    url: 'http://example.com/movie.mp4', sourceId: 'src-1', sourceName: 'Demo M3U',
    reconnectCount: 0, failoverAttempts: 0, failoverHistory: ['Demo M3U'],
    startedAt: new Date(Date.now() - positionMs).toISOString(), positionMs, durationMs: 596000,
    isLive: false, codec: 'h264', resolution: '1920x1080', estimatedBitrate: 4200, bufferHealth: 85,
    availableSources: ['Demo M3U', 'Demo Xtream'], currentSourceIndex: 0,
  },
});

function applyPatch(p) {
  if (typeof p.deviceName === 'string') { config.deviceName = p.deviceName; config.appearance.roomName = p.deviceName; }
  if (typeof p.locationName === 'string') config.locationName = p.locationName;
  if (p.appearance) Object.assign(config.appearance, p.appearance);
  if (p.settings) {
    for (const [k, v] of Object.entries(p.settings)) {
      if (k in config.secrets) config.secrets[k] = !!v; else config.settings[k] = v;
    }
  }
  const s = p.sources || {};
  for (const id of s.remove || []) config.sources = config.sources.filter((x) => x.id !== id);
  for (const u of s.update || []) {
    const src = config.sources.find((x) => x.id === u.id);
    if (!src) throw new Error(`No source ${u.id}`);
    const { xtreamPassword, ...rest } = u;
    Object.assign(src, rest);
    if (xtreamPassword !== undefined) src.hasPassword = !!xtreamPassword;
  }
  for (const a of s.add || []) {
    const { xtreamPassword, ...rest } = a;
    config.sources.push({ id: crypto.randomUUID(), enabled: true, ...rest, hasPassword: !!xtreamPassword });
  }
}

let attempt = 0;
function connect() {
  const ws = new WebSocket(`${base}/agent`);
  let timer;
  const send = (m) => ws.readyState === 1 && ws.send(JSON.stringify(m));

  ws.on('open', () => {
    attempt = 0;
    send({
      type: 'hello', protocol: 1, deviceId: identity.deviceId, deviceName: config.deviceName,
      shortCode: 'FAK123', appearance: config.appearance, platform: 'fake', appVersion: '0.0.0',
      joinKey: flag('join-key', undefined), locationName: config.locationName,
    });
  });

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    switch (msg.type) {
      case 'challenge':
        send(msg.known
          ? { type: 'auth', proof: crypto.createHmac('sha256', identity.secret).update(msg.nonce).digest('base64') }
          : { type: 'auth', secret: identity.secret });
        break;
      case 'welcome':
        console.log(`[fake] connected to "${msg.server.name}" as ${msg.deviceId} (${msg.status})`);
        send({ type: 'state', data: state() });
        send({ type: 'config', data: config });
        timer = setInterval(() => { if (playing) positionMs += 5000; send({ type: 'state', data: state() }); }, 5000);
        break;
      case 'approved':
        console.log('[fake] approved by admin');
        send({ type: 'state', data: state() });
        send({ type: 'config', data: config });
        break;
      case 'command':
        console.log('[fake] command', msg.data);
        if (msg.data.command === 'play') playing = true;
        if (msg.data.command === 'pause') playing = false;
        if (msg.data.command === 'seek') positionMs = msg.data.positionMs;
        send({ type: 'state', data: state() });
        break;
      case 'config.update':
        console.log('[fake] config.update', JSON.stringify(msg.patch));
        try {
          applyPatch(msg.patch);
          send({ type: 'config.result', requestId: msg.requestId, ok: true });
          send({ type: 'profile', deviceName: config.deviceName, locationName: config.locationName, shortCode: 'FAK123', appearance: config.appearance });
          send({ type: 'config', data: config });
        } catch (e) {
          send({ type: 'config.result', requestId: msg.requestId, ok: false, error: e.message });
        }
        break;
      case 'rejected':
      case 'removed':
        console.log(`[fake] ${msg.type}${msg.reason ? `: ${msg.reason}` : ''}`);
        break;
      default:
    }
  });

  ws.on('close', (code) => {
    clearInterval(timer);
    if (code === 4004 || code === 4003) { console.log('[fake] stopping (removed/blocked)'); process.exit(0); }
    const delay = Math.min(30000, 1000 * 2 ** attempt++);
    console.log(`[fake] disconnected (${code}); retrying in ${delay / 1000}s`);
    setTimeout(connect, delay);
  });
  ws.on('error', (e) => console.log(`[fake] ${e.message}`));
}

console.log(`[fake] ${name} → ${base}/agent (identity: ${idFile})`);
connect();
