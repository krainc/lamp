import { LampAdapter } from './base.js';

/**
 * Working adapter for any plug flashed with Tasmota — the escape hatch for
 * cheap Tuya/Sonoff hardware you're willing to reflash. Like Shelly, it dials
 * outbound to our broker, so it works from any home network.
 *
 * Options:
 *   topic         string  Tasmota's %topic%, e.g. "lamp-kevin"
 *   mqttPassword  string  password this device uses to reach our broker
 *   relay         number  relay index for multi-outlet devices (default 1)
 *
 * Device-side (Configuration -> Configure MQTT):
 *   Host / Port   <your-app>.fly.dev / 8883      (needs a TLS-enabled build)
 *   User          the lamp id
 *   Password      options.mqttPassword
 *   Topic         options.topic
 *
 * Note: Tasmota does not report *why* the relay changed, so every report looks
 * like a human acting locally. That is safe here — the hub only fans out a
 * change that disagrees with the group's current state, so a command echo can
 * never bounce back out. It does mean a Tasmota plug rebooting will announce
 * its restored relay state as if a person had pressed it; Tasmota's
 * `PowerOnState 0` (always start off) or `3` (restore last) keeps that sane.
 */
export class TasmotaMqttAdapter extends LampAdapter {
  async start() {
    this.topic = this.options.topic;
    if (!this.topic) {
      throw new Error(`lamp ${this.lampId}: tasmota-mqtt requires options.topic`);
    }
    this.relay = this.options.relay ?? 1;
    this.powerKey = this.relay === 1 ? 'POWER' : `POWER${this.relay}`;

    const { broker } = this.ctx;
    broker.subscribe(`tele/${this.topic}/LWT`, (p) => {
      const online = String(p).trim().toLowerCase() === 'online';
      this.report({ online });
      if (online) this.refresh().catch(() => {});
    });
    broker.subscribe(`stat/${this.topic}/${this.powerKey}`, (p) => this.#onPower(p));
    broker.subscribe(`stat/${this.topic}/RESULT`, (p) => this.#onResult(p));

    this.log.info(`listening for tasmota on "stat/${this.topic}/#"`);
  }

  mqttCredentials() {
    if (!this.options.mqttPassword) {
      throw new Error(`lamp ${this.lampId}: tasmota-mqtt requires options.mqttPassword`);
    }
    return {
      username: this.lampId,
      password: this.options.mqttPassword,
      topics: [`cmnd/${this.options.topic}/#`, `stat/${this.options.topic}/#`, `tele/${this.options.topic}/#`],
    };
  }

  async set(on) {
    this.ctx.broker.publish(`cmnd/${this.topic}/${this.powerKey}`, on ? 'ON' : 'OFF');
  }

  async refresh() {
    this.ctx.broker.publish(`cmnd/${this.topic}/${this.powerKey}`, '');
  }

  #onPower(payload) {
    const value = String(payload).trim().toUpperCase();
    if (value !== 'ON' && value !== 'OFF') return;
    this.report({ online: true, on: value === 'ON', source: 'local' });
  }

  #onResult(payload) {
    try {
      const result = JSON.parse(String(payload));
      const value = result[this.powerKey];
      if (value === 'ON' || value === 'OFF') {
        this.report({ online: true, on: value === 'ON', source: 'local' });
      }
    } catch {
      /* Tasmota publishes plenty of RESULT payloads we don't care about */
    }
  }
}
