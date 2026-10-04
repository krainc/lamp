/**
 * A lamp adapter owns exactly one plug/relay and translates between it and the
 * hub. To support new hardware, implement this and register it in ./index.js.
 *
 * The contract:
 *
 *   - Call `this.report({...})` whenever the device tells you anything. Never
 *     wait to be polled for something the device already pushed.
 *   - `source` on a state report matters enormously:
 *       'local' a human acted at the device (button, the plug's own UI)
 *       'self'  the echo of a command this adapter sent
 *       'init'  the device booted and is reporting where its relay sits
 *     Get this wrong in the 'local' direction and one plug rebooting will
 *     toggle every house in the group.
 *   - `set(on)` should resolve once the command is *accepted*, and reject if it
 *     could not be delivered. Do not wait for the relay to confirm; the report
 *     path handles confirmation.
 */
export class LampAdapter {
  /**
   * @param {object} args
   * @param {string} args.lampId
   * @param {object} args.options       the `lamp.options` blob from config
   * @param {object} args.ctx           shared services: { broker, log }
   * @param {(report: object) => void} args.report
   */
  constructor({ lampId, options, ctx, report }) {
    this.lampId = lampId;
    this.options = options;
    this.ctx = ctx;
    this.report = report;
    this.log = ctx.log.child(lampId);
  }

  /** Connect / subscribe / begin polling. */
  async start() {}

  /** Clean shutdown. */
  async stop() {}

  /**
   * Turn the relay on or off.
   * @param {boolean} on
   */
  async set(on) {
    throw new Error(`${this.constructor.name} does not implement set()`);
  }

  /** Optional: ask the device for its current state. */
  async refresh() {}

  /**
   * MQTT credentials this adapter's device should use, if it speaks MQTT.
   * Return null for adapters that don't (cloud APIs, local HTTP, etc).
   * @returns {{username: string, password: string, topics: string[]} | null}
   */
  mqttCredentials() {
    return null;
  }
}
