import { LampAdapter } from './base.js';

/**
 * STUB — Tuya / Smart Life plugs (the $8 white ones sold under fifty brand
 * names: Gosund, Treatlife, Teckin, Merkury, ...).
 *
 * Three ways in, roughly in order of how happy you'll be:
 *
 *  1. Reflash to Tasmota and use `tasmota-mqtt` instead. Older units flash
 *     over-the-air; anything made after ~2019 ships a Wi-Fi module that
 *     refuses OTA and needs the case cracked open and pads soldered. If you're
 *     up for it, this is by far the best end state: local, instant, no cloud.
 *
 *  2. Tuya Cloud API (iot.tuya.com). Create a free developer account, link your
 *     Smart Life app account, and get client_id/client_secret. Reachable from
 *     anywhere. Two flavours:
 *       - REST polling: simple, ~5s lag.
 *       - Pulsar message queue: real push, but a heavier integration.
 *     The free tier's trial period expires and needs periodic renewal, which is
 *     an annoying thing to have your lamps depend on.
 *
 *  3. `tuya-local` style local control on TCP 6668 with the device's local key.
 *     Same fundamental problem as Kasa's local protocol: same-LAN only, so it
 *     needs a bridge box in each home.
 *
 * To implement the cloud path (option 2, REST):
 *   1. POST https://openapi.tuyaus.com/v1.0/token?grant_type=1 with the
 *      signed-request headers (client_id, t, sign, sign_method:HMAC-SHA256)
 *      -> access_token
 *   2. Command: POST /v1.0/iot-03/devices/{device_id}/commands
 *      body {commands:[{code:"switch_1", value: on}]}
 *   3. Poll:    GET  /v1.0/iot-03/devices/{device_id}/status
 *      -> [{code:"switch_1", value:true}]
 *   Note the `code` varies by device: "switch_1" on most plugs, "switch" on
 *   some. Read it off the status response once and hardcode it in options.
 *
 * The signing is the fiddly part: sign = HMAC-SHA256(client_secret,
 * client_id + access_token + t + nonce + stringToSign), uppercased hex.
 */
export class TuyaAdapter extends LampAdapter {
  async start() {
    throw new Error(
      'The tuya adapter is a stub. See src/adapters/tuya.js — reflashing to ' +
        'Tasmota and using the tasmota-mqtt adapter is usually the better move.',
    );
  }

  async set(_on) {
    throw new Error('tuya adapter not implemented');
  }
}
