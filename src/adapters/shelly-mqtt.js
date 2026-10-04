import { LampAdapter } from './base.js';

/**
 * Reference adapter: Shelly Gen2/Gen3/Gen4 devices (Plug US Gen4, Plug S Gen3,
 * Plus 1PM, etc) talking to our own embedded MQTT broker.
 *
 * Why this hardware is the easy path:
 *   - The plug connects *outbound* to our broker over TLS, so it works from any
 *     friend's home network with no port forwarding and no vendor cloud.
 *   - State changes are pushed instantly on `events/rpc`, not polled.
 *   - Those events carry a `source` field ("button", "MQTT", "init", ...) which
 *     is exactly what we need to tell a human's button press apart from the
 *     echo of our own command.
 *
 * Options:
 *   topicPrefix   string  the device's MQTT prefix. Defaults to the Shelly
 *                         device id, e.g. "shellyplugusg4-a0b1c2d3e4f5". Set it
 *                         in the plug's UI under Settings -> MQTT.
 *   switchId      number  relay index, 0 on a single-outlet plug (default 0)
 *   mqttPassword  string  password this device uses to reach our broker
 *
 * Device-side settings (Settings -> MQTT on the plug):
 *   Server            <your-app>.fly.dev:8883
 *   Enable TLS        on, "verify server certificate" with the built-in CA
 *   Username          the lamp id
 *   Password          options.mqttPassword
 *   RPC over MQTT     enabled
 *   RPC status notifications  enabled   <- this is the one that matters
 */
export class ShellyMqttAdapter extends LampAdapter {
  async start() {
    this.prefix = this.options.topicPrefix;
    if (!this.prefix) {
      throw new Error(`lamp ${this.lampId}: shelly-mqtt requires options.topicPrefix`);
    }
    this.switchId = this.options.switchId ?? 0;
    this.switchKey = `switch:${this.switchId}`;
    this.rpcSrc = `lamplink/${this.lampId}`;
    this.reqId = 0;

    const { broker } = this.ctx;
    broker.subscribe(`${this.prefix}/online`, (payload) => this.#onOnline(payload));
    broker.subscribe(`${this.prefix}/events/rpc`, (payload) => this.#onEvent(payload));
    broker.subscribe(`${this.prefix}/status/${this.switchKey}`, (payload) => this.#onStatus(payload));
    broker.subscribe(`${this.rpcSrc}/rpc`, (payload) => this.#onRpcResponse(payload));

    this.log.info(`listening for shelly on "${this.prefix}/#"`);
  }

  mqttCredentials() {
    if (!this.options.mqttPassword) {
      throw new Error(`lamp ${this.lampId}: shelly-mqtt requires options.mqttPassword`);
    }
    return {
      username: this.lampId,
      password: this.options.mqttPassword,
      // The plug may only touch its own topics plus its private reply channel.
      // One friend's compromised plug must not be able to command another's.
      topics: [`${this.options.topicPrefix}/#`, `${this.rpcSrc ?? `lamplink/${this.lampId}`}/#`],
    };
  }

  async set(on) {
    const id = ++this.reqId;
    this.ctx.broker.publish(
      `${this.prefix}/rpc`,
      JSON.stringify({
        id,
        src: this.rpcSrc,
        method: 'Switch.Set',
        params: { id: this.switchId, on },
      }),
    );
    this.log.debug(`sent Switch.Set on=${on} (req ${id})`);
  }

  async refresh() {
    const id = ++this.reqId;
    this.ctx.broker.publish(
      `${this.prefix}/rpc`,
      JSON.stringify({
        id,
        src: this.rpcSrc,
        method: 'Switch.GetStatus',
        params: { id: this.switchId },
      }),
    );
  }

  #onOnline(payload) {
    const online = String(payload).trim() === 'true';
    this.report({ online });
    if (online) {
      // Ask for authoritative state rather than trusting a possibly stale
      // retained status message.
      this.refresh().catch((err) => this.log.warn('refresh failed', { error: err.message }));
    }
  }

  #onEvent(payload) {
    const msg = parseJson(payload, this.log);
    if (!msg) return;

    if (msg.method === 'NotifyStatus' || msg.method === 'NotifyFullStatus') {
      const sw = msg.params?.[this.switchKey];
      if (sw && sw.output !== undefined) {
        this.report({ online: true, on: Boolean(sw.output), source: mapSource(sw.source) });
      }
      return;
    }

    if (msg.method === 'NotifyEvent') {
      for (const ev of msg.params?.events || []) {
        this.log.debug(`device event: ${ev.event}`);
      }
    }
  }

  #onStatus(payload) {
    const sw = parseJson(payload, this.log);
    if (!sw || sw.output === undefined) return;
    // The `status/` topic can lag the relay by up to a minute, so it is used
    // only to reconcile what we think is true — never to trigger a fan-out.
    this.report({ online: true, on: Boolean(sw.output), source: 'status' });
  }

  #onRpcResponse(payload) {
    const msg = parseJson(payload, this.log);
    if (!msg) return;
    if (msg.error) {
      this.log.warn(`device rejected rpc ${msg.id}`, msg.error);
      this.report({ error: `device error: ${msg.error.message || msg.error.code}` });
      return;
    }
    if (msg.result?.output !== undefined) {
      this.report({ online: true, on: Boolean(msg.result.output), source: 'init' });
    }
  }
}

/**
 * Shelly's `source` values -> our vocabulary.
 *
 * "MQTT" is us, and only us, provided no other MQTT client is driving the plug.
 * Everything else that isn't a boot report is treated as a human acting at the
 * device, which is the safe default: we would rather occasionally propagate a
 * change nobody made than fail to propagate a real button press.
 */
function mapSource(source) {
  const s = String(source || '').toLowerCase();
  if (s === 'mqtt') return 'self';
  if (s === 'init' || s === '') return 'init';
  return 'local'; // button, http, WS_in, timer, loopback, cloud, ...
}

function parseJson(payload, log) {
  try {
    return JSON.parse(String(payload));
  } catch (err) {
    log.warn('unparseable payload', { error: err.message });
    return null;
  }
}
