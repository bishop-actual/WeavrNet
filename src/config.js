'use strict';
// Runtime configuration, read once from the environment.

const path = require('path');

function bool(v, fallback) {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function load(env = process.env) {
  return {
    host: env.HOST || '0.0.0.0',
    port: parseInt(env.PORT || '7780', 10),
    dataDir: path.resolve(env.DATA_DIR || path.join(__dirname, '..', 'data')),
    publicDir: path.join(__dirname, '..', 'public'),
    // Optional native TLS. Most installs terminate TLS at a reverse proxy instead.
    tlsCert: env.TLS_CERT || null,
    tlsKey: env.TLS_KEY || null,
    // Honour X-Forwarded-* headers from a reverse proxy: true, false, or
    // (unset) auto — trusted only when the connection comes from a private
    // address, which is what a proxy on the same Docker host looks like.
    trustProxy: env.TRUST_PROXY === undefined || env.TRUST_PROXY === '' || env.TRUST_PROXY === 'auto'
      ? 'auto' : bool(env.TRUST_PROXY, false),
    // Values below override what the admin sets in the UI when present.
    serverName: env.WEAVRNET_NAME || null,
    adminPassword: env.WEAVRNET_ADMIN_PASSWORD || null,
    joinKey: env.WEAVRNET_JOIN_KEY !== undefined ? env.WEAVRNET_JOIN_KEY : null,
    requireApproval: env.WEAVRNET_REQUIRE_APPROVAL !== undefined
      ? bool(env.WEAVRNET_REQUIRE_APPROVAL, false) : null,
    sessionDays: parseInt(env.WEAVRNET_SESSION_DAYS || '30', 10),
  };
}

module.exports = { load };
