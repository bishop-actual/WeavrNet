'use strict';
// Working out who is on the other end of a request when WeavrNet sits behind
// one or more reverse proxies (Traefik, Caddy, nginx, Cloudflare...).

const net = require('net');

function normalize(ip) {
  if (typeof ip !== 'string') return '';
  let a = ip.trim();
  if (a.startsWith('[')) a = a.slice(1, a.indexOf(']'));
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);
  // "1.2.3.4:5678" from some proxies
  if (net.isIPv4(a.split(':')[0]) && a.split(':').length === 2) a = a.split(':')[0];
  return net.isIP(a) ? a : '';
}

/** Loopback, LAN, Docker, CGNAT and link-local addresses. */
function isPrivate(ip) {
  const a = normalize(ip);
  if (!a) return false;
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    return x === 10 || x === 127 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168)
      || (x === 169 && y === 254) || (x === 100 && y >= 64 && y <= 127) || x === 0;
  }
  const l = a.toLowerCase();
  return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

/**
 * Should forwarded headers be believed for this request? `mode` is true,
 * false or 'auto' — auto trusts them only when the connection itself comes
 * from a private address, i.e. from a proxy on the same machine or network.
 */
function trusts(mode, req) {
  if (mode === true) return true;
  if (mode === false) return false;
  return isPrivate(req.socket.remoteAddress);
}

/**
 * The real client address. Behind trusted proxies, prefer the headers CDNs
 * set (CF-Connecting-IP, True-Client-IP), then the left-most public entry of
 * X-Forwarded-For, then X-Real-IP; a chain of only private addresses means the
 * client really is on the local network.
 */
function clientIp(mode, req) {
  const peer = normalize(req.socket.remoteAddress) || req.socket.remoteAddress || '';
  if (!trusts(mode, req)) return peer;
  const h = req.headers;
  const xff = String(h['x-forwarded-for'] || '').split(',').map(normalize).filter(Boolean);
  const candidates = [normalize(h['cf-connecting-ip']), normalize(h['true-client-ip']), ...xff,
    normalize(h['x-real-ip'])].filter(Boolean);
  return candidates.find((ip) => !isPrivate(ip)) || candidates[0] || peer;
}

module.exports = { clientIp, isPrivate, trusts, normalize };
