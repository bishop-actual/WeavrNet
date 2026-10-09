'use strict';
// Tiny JSON-file store. Everything WeavrNet persists lives in one file in
// DATA_DIR so a single Docker volume is enough to back it up.

const fs = require('fs');
const path = require('path');

const EMPTY = () => ({
  version: 1,
  admin: { passwordHash: null },
  settings: { serverName: 'WeavrNet', requireApproval: false, joinKey: '' },
  devices: {},
  sessions: {},
});

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'weavrnet.json');
    this._timer = null;
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.accessSync(dir, fs.constants.W_OK);
    } catch (_) {
      throw new Error(`Data directory ${dir} is not writable by uid ${process.getuid?.()}. `
        + 'If it is a bind mount, chown it to that user (e.g. `chown 1000:1000 ./data`).');
    }
    this.data = this._read();
  }

  _read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const base = EMPTY();
      return {
        ...base,
        ...raw,
        admin: { ...base.admin, ...raw.admin },
        settings: { ...base.settings, ...raw.settings },
        devices: raw.devices || {},
        sessions: raw.sessions || {},
      };
    } catch (e) {
      if (e.code !== 'ENOENT') {
        // Never silently drop a corrupt store: keep a copy for recovery.
        const bad = `${this.file}.corrupt-${Date.now()}`;
        try { fs.copyFileSync(this.file, bad); } catch (_) {}
        console.error(`[store] Could not read ${this.file} (${e.message}); saved a copy to ${bad}`);
      }
      return EMPTY();
    }
  }

  /** Schedule a write; bursts of changes collapse into one disk write. */
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; this.flush(); }, 250);
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store };
