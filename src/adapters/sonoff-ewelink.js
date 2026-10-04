import { LampAdapter } from './base.js';

/**
 * SONOFF plugs (S40, S31, S60, BASIC...) via eWeLink's cloud.
 *
 * Unlike the MQTT adapters, every Sonoff lamp shares ONE cloud connection —
 * one sign-in, one WebSocket — handed in as `ctx.ewelink`. This adapter just
 * claims a device id on it and translates events.
 *
 * Options:
 *   deviceId  string  the plug's eWeLink device id, e.g. "10021f9a2b".
 *                     Run `npm run ewelink` to list the ids on your account.
 *   channel   number  for multi-outlet devices only; omit for the S40.
 *
 * Two things worth knowing about this hardware:
 *
 *  - The S40 runs a BL602 chip. Neither Tasmota nor ESPHome supports it, so
 *    unlike most Sonoff gear it genuinely cannot be reflashed. eWeLink's cloud
 *    is the only route to it from outside the house.
 *  - eWeLink does not say *why* a relay changed. A press of the plug's button
 *    and the echo of our own command look identical. That's safe here: the hub
 *    only fans out a change that disagrees with the group's current state, so
 *    an echo can't bounce back out. (`tasmota-mqtt` has the same property, and
 *    test/hub.test.js covers it.)
 */
export class SonoffEwelinkAdapter extends LampAdapter {
  async start() {
    this.deviceId = this.options.deviceId;
    if (!this.deviceId) {
      throw new Error(
        `lamp ${this.lampId}: sonoff-ewelink requires options.deviceId — run \`npm run ewelink\` to list them`,
      );
    }
    if (!this.ctx.ewelink) {
      throw new Error(
        `lamp ${this.lampId}: sonoff-ewelink needs an "ewelink" block in config.json`,
      );
    }

    this.cloud = this.ctx.ewelink;
    this.switchKey = this.options.channel ? `switch_${this.options.channel}` : 'switch';

    // The cloud connection is shared, so filter its stream down to our device.
    this.onDevice = (event) => {
      if (event.deviceId !== this.deviceId) return;
      this.report({
        online: event.online,
        ...(event.on === undefined ? {} : { on: event.on, source: 'local' }),
      });
    };
    this.cloud.on('device', this.onDevice);

    // On every (re)connect, resync from the cloud's view as a *boot* report, so
    // a connection dropping at 3am can't fan out and relight four houses.
    //
    // If eWeLink also replays the switch state right after, that arrives as
    // 'local' — harmless, because it matches what this report just recorded, so
    // the hub sees no change and fans nothing out.
    this.onReady = () => {
      const device = this.cloud.known(this.deviceId);
      if (!device) {
        this.log.warn(`device ${this.deviceId} is not on this eWeLink account`);
        this.report({ online: false, error: 'not found on the eWeLink account' });
        return;
      }
      const value = device.params?.[this.switchKey];
      this.report({
        online: device.online,
        ...(value === undefined ? {} : { on: value === 'on', source: 'init' }),
      });
    };
    this.cloud.on('ready', this.onReady);

    if (this.cloud.ready) {
      this.onReady();
    } else {
      // Say *why* rather than leaving the lamp silently greyed out. The cloud
      // retries in the background, so this is a status, not a dead end.
      this.report({
        online: false,
        error: this.cloud.lastError ? `eWeLink: ${this.cloud.lastError}` : 'connecting to eWeLink…',
      });
    }
    this.log.info(`bound to eWeLink device ${this.deviceId}`);
  }

  async set(on) {
    await this.cloud.setSwitch(this.deviceId, on);
  }

  async refresh() {
    const device = this.cloud.known(this.deviceId);
    if (!device) return;
    const value = device.params?.[this.switchKey];
    if (value !== undefined) this.report({ online: device.online, on: value === 'on', source: 'init' });
  }

  async stop() {
    this.cloud?.off('device', this.onDevice);
    this.cloud?.off('ready', this.onReady);
  }
}
