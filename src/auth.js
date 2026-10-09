'use strict';
// Admin password hashing, browser sessions and login throttling.

const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SESSION_COOKIE = 'weavrnet_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(password, Buffer.from(salt, 'base64'), expected.length,
    { N: +N, r: +r, p: +p });
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

class Sessions {
  constructor(store, days) {
    this.store = store;
    this.ttlMs = days * 24 * 3600 * 1000;
  }

  create(meta = {}) {
    const token = crypto.randomBytes(32).toString('base64url');
    this.store.data.sessions[sha256(token)] = {
      createdAt: Date.now(),
      expiresAt: Date.now() + this.ttlMs,
      ...meta,
    };
    this.store.save();
    return token;
  }

  valid(token) {
    if (!token) return false;
    const key = sha256(token);
    const s = this.store.data.sessions[key];
    if (!s) return false;
    if (s.expiresAt < Date.now()) {
      delete this.store.data.sessions[key];
      this.store.save();
      return false;
    }
    return true;
  }

  destroy(token) {
    if (!token) return;
    delete this.store.data.sessions[sha256(token)];
    this.store.save();
  }

  destroyAll() {
    this.store.data.sessions = {};
    this.store.save();
  }

  prune() {
    const now = Date.now();
    for (const [k, s] of Object.entries(this.store.data.sessions)) {
      if (s.expiresAt < now) delete this.store.data.sessions[k];
    }
    this.store.save();
  }
}

/** Fixed-window failure counter per key (client IP). */
class Throttle {
  constructor({ max = 10, windowMs = 15 * 60 * 1000 } = {}) {
    this.max = max;
    this.windowMs = windowMs;
    this.hits = new Map();
  }

  blocked(key) {
    const h = this.hits.get(key);
    if (!h) return false;
    if (Date.now() - h.start > this.windowMs) { this.hits.delete(key); return false; }
    return h.count >= this.max;
  }

  fail(key) {
    const h = this.hits.get(key);
    if (!h || Date.now() - h.start > this.windowMs) this.hits.set(key, { start: Date.now(), count: 1 });
    else h.count++;
  }

  reset(key) { this.hits.delete(key); }
}

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** HMAC proof a device sends to show it holds the secret it registered with. */
function deviceProof(secret, nonce) {
  return crypto.createHmac('sha256', secret).update(nonce).digest('base64');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

module.exports = {
  SESSION_COOKIE, hashPassword, verifyPassword, Sessions, Throttle,
  parseCookies, deviceProof, safeEqual,
};
