import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('state');
const MAX_EVENTS = 40;

/**
 * Durable bits of the world. Everything else (online status, in-flight
 * commands) is transient and rebuilt on boot.
 *
 * {
 *   groupState: boolean,           // the shared truth among unlocked lamps
 *   lamps: { [lampId]: { on, locked, lastChangeAt, lastChangeBy } },
 *   events: [{ at, lampId, userId, kind, detail }]
 * }
 */
export class Store {
  constructor({ filePath, lampIds }) {
    this.filePath = filePath;
    this.data = this.#read(lampIds);
    this.pendingWrite = null;
  }

  #read(lampIds) {
    let loaded = {};
    if (this.filePath && fs.existsSync(this.filePath)) {
      try {
        loaded = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        log.info(`restored state from ${this.filePath}`);
      } catch (err) {
        log.warn(`could not parse ${this.filePath}, starting fresh`, { error: err.message });
      }
    }

    const data = {
      groupState: loaded.groupState ?? false,
      lamps: {},
      events: Array.isArray(loaded.events) ? loaded.events.slice(-MAX_EVENTS) : [],
    };

    for (const id of lampIds) {
      const prev = loaded.lamps?.[id] || {};
      data.lamps[id] = {
        on: prev.on ?? false,
        locked: prev.locked ?? false,
        lastChangeAt: prev.lastChangeAt ?? null,
        lastChangeBy: prev.lastChangeBy ?? null,
      };
    }
    return data;
  }

  lamp(lampId) {
    return this.data.lamps[lampId];
  }

  addEvent(event) {
    this.data.events.push(event);
    if (this.data.events.length > MAX_EVENTS) {
      this.data.events = this.data.events.slice(-MAX_EVENTS);
    }
    this.save();
  }

  /** Debounced atomic write. Called on every mutation; cheap to over-call. */
  save() {
    if (!this.filePath || this.pendingWrite) return;
    this.pendingWrite = setTimeout(() => {
      this.pendingWrite = null;
      try {
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
        fs.renameSync(tmp, this.filePath);
      } catch (err) {
        log.error('failed to persist state', { error: err.message });
      }
    }, 250);
    this.pendingWrite.unref?.();
  }

  flush() {
    if (this.pendingWrite) {
      clearTimeout(this.pendingWrite);
      this.pendingWrite = null;
    }
    if (!this.filePath) return;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
    } catch (err) {
      log.error('failed to flush state', { error: err.message });
    }
  }
}
