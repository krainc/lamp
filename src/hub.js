import { EventEmitter } from 'node:events';
import { logger } from './log.js';

const log = logger('hub');

/**
 * Origin of a reported state change:
 *
 *   'local'  someone physically pressed the plug's button, or used the plug's
 *            own web UI. A real human intent, worth broadcasting.
 *   'app'    someone tapped their own lamp in the Lamplink web app. Also real.
 *   'self'   the echo of a command *we* sent. Never broadcast; that's the loop.
 *   'init'   the device just booted and is telling us where its relay happens
 *            to be sitting. Never broadcast — otherwise a plug rebooting at 3am
 *            turns off four houses.
 */
const BROADCASTABLE = new Set(['local', 'app']);

export class Hub extends EventEmitter {
  constructor({ config, store }) {
    super();
    this.config = config;
    this.store = store;
    this.adapters = new Map(); // lampId -> adapter
    this.runtime = new Map(); // lampId -> { online, changeTimes[], mutedUntil, lastError }

    for (const user of config.users) {
      this.runtime.set(user.lamp.id, {
        online: false,
        changeTimes: [],
        mutedUntil: 0,
        lastError: null,
      });
    }
  }

  attachAdapter(lampId, adapter) {
    this.adapters.set(lampId, adapter);
  }

  userForLamp(lampId) {
    return this.config.users.find((u) => u.lamp.id === lampId);
  }

  lampForUser(userId) {
    return this.config.users.find((u) => u.id === userId)?.lamp;
  }

  // ---------------------------------------------------------------------------
  // Inbound: adapters call this whenever a device tells us something.
  // ---------------------------------------------------------------------------

  /**
   * @param {string} lampId
   * @param {{on?: boolean, online?: boolean, source?: string, error?: string}} report
   */
  report(lampId, report) {
    const lamp = this.store.lamp(lampId);
    const rt = this.runtime.get(lampId);
    if (!lamp || !rt) {
      log.warn(`report for unknown lamp ${lampId}`);
      return;
    }

    let changed = false;

    if (report.online !== undefined && report.online !== rt.online) {
      rt.online = report.online;
      changed = true;
      const user = this.userForLamp(lampId);
      this.#addEvent({
        lampId,
        userId: user?.id,
        kind: report.online ? 'online' : 'offline',
      });
    }

    if (report.error !== undefined) {
      rt.lastError = report.error;
      changed = true;
    }

    if (report.on !== undefined) {
      changed = this.#applyStateReport(lampId, report.on, report.source || 'local') || changed;
    }

    if (changed) this.#publish();
  }

  #applyStateReport(lampId, on, source) {
    const lamp = this.store.lamp(lampId);
    const rt = this.runtime.get(lampId);
    const user = this.userForLamp(lampId);
    const wasOn = lamp.on;

    lamp.on = on;

    // Nothing actually moved. Note it and stop — this is the common case for
    // command echoes and periodic status republishes.
    if (wasOn === on) {
      this.store.save();
      return false;
    }

    lamp.lastChangeAt = Date.now();
    lamp.lastChangeBy = source === 'self' ? 'sync' : user?.id || null;
    this.store.save();

    this.#addEvent({
      lampId,
      userId: user?.id,
      kind: on ? 'on' : 'off',
      detail: source,
    });

    this.#considerBroadcast(lampId, on, source);
    return true;
  }

  /**
   * Decide whether one lamp's change should move everyone else's.
   *
   * Kept separate from #applyStateReport so that an app tap can reach it
   * directly. Routing an app tap through the state *diff* would lose the
   * fan-out whenever the plug's own echo arrived first — it would have already
   * written the new value, making the tap look like "no change at all".
   *
   * @param {boolean} count  whether this counts toward the flap guard. False
   *   for app taps that didn't actually move the relay.
   */
  #considerBroadcast(lampId, on, source, { count = true } = {}) {
    if (!BROADCASTABLE.has(source)) {
      log.debug(`${lampId} -> ${on ? 'on' : 'off'} (source=${source}); not broadcasting`);
      return;
    }

    const rt = this.runtime.get(lampId);

    if (count && this.#tripsFlapGuard(lampId)) {
      log.warn(`${lampId} is flapping; suppressing its broadcasts for ${this.config.flapGuard.cooldownMs}ms`);
      rt.mutedUntil = Date.now() + this.config.flapGuard.cooldownMs;
      this.#addEvent({ lampId, userId: this.userForLamp(lampId)?.id, kind: 'flap-guard' });
      return;
    }

    if (rt.mutedUntil > Date.now()) {
      log.debug(`${lampId} is muted by the flap guard; not broadcasting`);
      return;
    }

    if (this.store.lamp(lampId).locked && this.config.lockBehavior === 'private') {
      log.debug(`${lampId} is locked (private); not broadcasting`);
      return;
    }

    this.#broadcast(lampId, on);
  }

  /**
   * The whole loop-prevention trick lives here.
   *
   * `groupState` is the shared truth among unlocked lamps. A local change only
   * propagates when it *disagrees* with that truth. Fanning out then makes every
   * other lamp report the same value, which by definition now equals groupState,
   * so those reports propagate nothing further. No timers, no suppression
   * windows, no way to build an infinite echo.
   */
  #broadcast(originLampId, on) {
    if (on === this.store.data.groupState) {
      log.debug(`${originLampId} already agrees with group state; nothing to fan out`);
      return;
    }

    this.store.data.groupState = on;
    this.store.save();

    const targets = [];
    for (const user of this.config.users) {
      const lampId = user.lamp.id;
      if (lampId === originLampId) continue;

      const lamp = this.store.lamp(lampId);
      const rt = this.runtime.get(lampId);

      if (lamp.locked) continue; // locked means locked, in both lock modes
      if (!rt.online) continue; // it'll catch up on the next change
      if (lamp.on === on) continue; // already there; don't cycle the relay

      targets.push(lampId);
    }

    log.info(`fan-out ${on ? 'ON' : 'OFF'} from ${originLampId} -> [${targets.join(', ') || 'nobody'}]`);

    // Fire every command in parallel — one slow plug must not delay the rest —
    // but publish once the whole fan-out has settled. Without this, browsers
    // only ever see a snapshot taken mid-flight, and their lamp rows lag a full
    // step behind reality.
    const sends = targets.map((lampId) => this.#send(lampId, on, 'sync'));
    if (sends.length) Promise.allSettled(sends).then(() => this.#publish());
  }

  /**
   * @param {boolean} optimistic  Record the new state immediately rather than
   *   waiting for the device to confirm. True for fan-out targets. False when
   *   the caller is about to run the change through #applyStateReport itself —
   *   otherwise that call would see "no change" and skip the broadcast.
   */
  async #send(lampId, on, why, { optimistic = true } = {}) {
    const adapter = this.adapters.get(lampId);
    if (!adapter) {
      log.warn(`no adapter attached for ${lampId}`);
      return;
    }
    try {
      await adapter.set(on);
      const rt = this.runtime.get(lampId);
      rt.lastError = null;
      // The device's own report will confirm this (and arrives with source
      // 'self', so it can't bounce back out).
      const lamp = this.store.lamp(lampId);
      if (optimistic && lamp.on !== on) {
        lamp.on = on;
        lamp.lastChangeAt = Date.now();
        lamp.lastChangeBy = why;
        this.store.save();
      }
    } catch (err) {
      log.error(`failed to set ${lampId} -> ${on}`, { error: err.message });
      this.runtime.get(lampId).lastError = err.message;
      this.#publish();
    }
  }

  #tripsFlapGuard(lampId) {
    const { maxChanges, windowMs } = this.config.flapGuard;
    const rt = this.runtime.get(lampId);
    const now = Date.now();
    rt.changeTimes = rt.changeTimes.filter((t) => now - t < windowMs);
    rt.changeTimes.push(now);
    return rt.changeTimes.length > maxChanges;
  }

  // ---------------------------------------------------------------------------
  // Outbound: the web app calls these.
  // ---------------------------------------------------------------------------

  /** A user tapped their own lamp. */
  async setOwnLamp(userId, on) {
    const lamp = this.lampForUser(userId);
    if (!lamp) throw new Error(`unknown user ${userId}`);

    // Command the hardware first so a dead plug surfaces as an error rather
    // than as a phantom state change everyone else obeys.
    await this.#send(lamp.id, on, userId, { optimistic: false });

    // Record the intent. The plug's echo may already have landed and written
    // this same value, which is why the fan-out below is driven by the tap
    // itself rather than by a before/after comparison.
    const record = this.store.lamp(lamp.id);
    const moved = record.on !== on;
    if (moved) {
      record.on = on;
      record.lastChangeAt = Date.now();
      record.lastChangeBy = userId;
      this.#addEvent({ lampId: lamp.id, userId, kind: on ? 'on' : 'off', detail: 'app' });
    }
    this.store.save();

    this.#considerBroadcast(lamp.id, on, 'app', { count: moved });
    this.#publish();
  }

  async setLocked(userId, locked) {
    const lamp = this.lampForUser(userId);
    if (!lamp) throw new Error(`unknown user ${userId}`);

    const record = this.store.lamp(lamp.id);
    if (record.locked === locked) return;

    record.locked = locked;
    this.store.save();
    this.#addEvent({ lampId: lamp.id, userId, kind: locked ? 'locked' : 'unlocked' });

    if (!locked && this.config.adoptGroupStateOnUnlock) {
      const target = this.store.data.groupState;
      if (record.on !== target && this.runtime.get(lamp.id).online) {
        log.info(`${lamp.id} unlocked; adopting group state ${target ? 'ON' : 'OFF'}`);
        await this.#send(lamp.id, target, 'sync');
      }
    }

    this.#publish();
  }

  #addEvent(event) {
    this.store.addEvent({ at: Date.now(), ...event });
  }

  #publish() {
    this.emit('change', this.snapshot());
  }

  /** Everything the web UI needs, from one user's point of view. */
  snapshot(viewerId = null) {
    const lamps = this.config.users.map((user) => {
      const lamp = this.store.lamp(user.lamp.id);
      const rt = this.runtime.get(user.lamp.id);
      return {
        userId: user.id,
        name: user.name,
        lampId: user.lamp.id,
        adapter: user.lamp.adapter,
        on: lamp.on,
        locked: lamp.locked,
        online: rt.online,
        muted: rt.mutedUntil > Date.now(),
        error: rt.lastError,
        lastChangeAt: lamp.lastChangeAt,
        lastChangeBy: lamp.lastChangeBy,
        isYou: viewerId ? user.id === viewerId : false,
      };
    });

    return {
      you: viewerId,
      groupState: this.store.data.groupState,
      lockBehavior: this.config.lockBehavior,
      lamps,
      events: this.store.data.events.slice(-20).reverse(),
      serverTime: Date.now(),
    };
  }
}
