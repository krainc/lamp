import net from 'node:net';
import crypto from 'node:crypto';
import Aedes from 'aedes';
import { logger } from './log.js';

const log = logger('mqtt');

/**
 * An MQTT broker embedded in the app process.
 *
 * Running mosquitto as a second container would mean a second process to
 * supervise, a config file to mount, and an extra network hop — all so two
 * halves of the same program can talk. Embedding it means `fly deploy` ships
 * one image, and the broker and the sync logic share memory.
 *
 * TLS is deliberately *not* handled here. Fly (and most platforms) terminate
 * TLS at the edge: the plug connects to port 8883 with TLS, Fly unwraps it and
 * forwards plaintext MQTT to this listener on the private network. That gets
 * you a valid, auto-renewing certificate for free. See fly.toml.
 */
export class Broker {
  constructor() {
    this.aedes = new Aedes({ concurrency: 20 });
    this.credentials = new Map(); // username -> { password, topics: string[] }
    this.handlers = []; // { filter: RegExp, topic: string, fn }
    this.server = null;

    this.aedes.authenticate = (client, username, password, done) => {
      const creds = username ? this.credentials.get(username) : null;
      const supplied = password ? password.toString() : '';

      if (!creds || !timingSafeEqualStr(creds.password, supplied)) {
        log.warn(`rejected connection from ${client?.id} (username="${username || ''}")`);
        const err = new Error('unauthorised');
        err.returnCode = 4; // bad username or password
        return done(err, false);
      }

      client.lamplinkUser = username;
      log.info(`device authenticated: ${username} (client ${client.id})`);
      return done(null, true);
    };

    // A plug may only touch its own topics. One friend's compromised or
    // misconfigured plug must not be able to command another friend's lamp.
    this.aedes.authorizePublish = (client, packet, done) => {
      if (!client?.lamplinkUser) return done(null); // our own internal publishes
      if (this.#allowed(client.lamplinkUser, packet.topic)) return done(null);
      log.warn(`blocked publish from ${client.lamplinkUser} to ${packet.topic}`);
      return done(new Error('not authorised for this topic'));
    };

    this.aedes.authorizeSubscribe = (client, sub, done) => {
      if (!client?.lamplinkUser) return done(null, sub);
      if (this.#allowed(client.lamplinkUser, sub.topic)) return done(null, sub);
      log.warn(`blocked subscribe from ${client.lamplinkUser} to ${sub.topic}`);
      return done(new Error('not authorised for this topic'));
    };

    this.aedes.on('client', (c) => log.debug(`connected: ${c.id}`));
    this.aedes.on('clientDisconnect', (c) => log.info(`disconnected: ${c.lamplinkUser || c.id}`));
    this.aedes.on('clientError', (c, err) => log.warn(`client error ${c.id}: ${err.message}`));

    this.aedes.on('publish', (packet, client) => {
      if (!client) return; // ignore our own outbound commands
      this.#dispatch(packet.topic, packet.payload);
    });
  }

  /** Register the credentials and topic scope for one device. */
  addDevice(username, { password, topics }) {
    this.credentials.set(username, { password, topics: topics.map(compileFilter) });
  }

  #allowed(username, topic) {
    const creds = this.credentials.get(username);
    if (!creds) return false;
    return creds.topics.some((re) => re.test(topic));
  }

  /**
   * Subscribe the server itself to a topic. Supports MQTT `+` and `#`.
   * @param {string} topic
   * @param {(payload: Buffer, topic: string) => void} fn
   */
  subscribe(topic, fn) {
    this.handlers.push({ filter: compileFilter(topic), topic, fn });
  }

  #dispatch(topic, payload) {
    for (const h of this.handlers) {
      if (h.filter.test(topic)) {
        try {
          h.fn(payload, topic);
        } catch (err) {
          log.error(`handler for ${h.topic} threw on ${topic}`, { error: err.message });
        }
      }
    }
  }

  /** Publish from the server to devices. */
  publish(topic, payload, { qos = 0, retain = false } = {}) {
    this.aedes.publish({
      topic,
      payload: Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload)),
      qos,
      retain,
      cmd: 'publish',
    });
  }

  listen(port, host = '0.0.0.0') {
    return new Promise((resolve, reject) => {
      this.server = net.createServer(this.aedes.handle);
      this.server.on('error', reject);
      this.server.listen(port, host, () => {
        log.info(`mqtt broker listening on ${host}:${port}`);
        resolve();
      });
    });
  }

  async close() {
    if (this.server) {
      // MQTT connections are long-lived by design and never close on their own,
      // so `server.close()` alone waits forever. Drop them explicitly.
      this.server.closeAllConnections?.();
      await withTimeout(new Promise((resolve) => this.server.close(resolve)), 2000);
    }
    // Aedes can stall here if a client socket is still half-attached. Shutdown
    // is best-effort by nature — never let it hold a deploy hostage.
    await withTimeout(new Promise((resolve) => this.aedes.close(resolve)), 2000);
  }
}

/** Resolves either way — a slow close must not block process shutdown. */
function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      log.warn(`close timed out after ${ms}ms; continuing`);
      resolve();
    }, ms);
    timer.unref?.();
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/** MQTT topic filter -> RegExp. `+` matches one level, `#` matches the rest. */
function compileFilter(filter) {
  const escaped = filter.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = escaped
    .split('/')
    .map((seg) => {
      if (seg === '\\+') return '[^/]+';
      if (seg === '#') return '.*';
      return seg;
    })
    .join('/')
    // `a/#` should also match exactly `a`
    .replace(/\/\.\*$/, '(?:/.*)?');
  return new RegExp(`^${pattern}$`);
}
