import { LampAdapter } from './base.js';

/**
 * STUB — TP-Link Kasa / Tapo plugs.
 *
 * Read this before buying Kasa hardware for this project.
 *
 * Kasa plugs speak two protocols, and neither is a clean fit:
 *
 *  1. A local protocol on TCP 9999 (XOR-obfuscated JSON). Fast and cloud-free,
 *     but it only works from *inside the same house*. A server on Fly.io cannot
 *     reach your friend's plug at 192.168.1.x. To use it you would run a small
 *     bridge process in each home (a Raspberry Pi, an always-on laptop, a
 *     container on a NAS) that holds a WebSocket open to Lamplink and relays
 *     commands to the local plug. That bridge is real work, and it puts a
 *     second box in every friend's home that can break.
 *
 *  2. TP-Link's cloud API (wap.tplinkcloud.com). Reachable from anywhere, but
 *     it must be *polled* — there is no push. Expect 2-10s of lag, a hard
 *     dependency on TP-Link's servers, and everyone's TP-Link password (or a
 *     derived token) living in your config.
 *
 * If you already own Kasa plugs, option 2 is the pragmatic path and the sketch
 * below is where to start. If you're still buying, a plug with native MQTT
 * (Shelly, or anything reflashed to Tasmota) skips this entire problem.
 *
 * To implement the cloud path:
 *   1. POST https://wap.tplinkcloud.com/ {method:"login", params:{appType, cloudUserName, cloudPassword, terminalUUID}}
 *      -> result.token
 *   2. POST ?token=... {method:"getDeviceList"} -> deviceId + appServerUrl
 *   3. Command:  POST <appServerUrl>?token=... {method:"passthrough",
 *        params:{deviceId, requestData: JSON.stringify({system:{set_relay_state:{state: on?1:0}}})}}
 *   4. Poll:     same shape with {system:{get_sysinfo:{}}} -> relay_state
 *
 * Poll on an interval, and report `source: 'local'` only when the observed
 * state differs from what you last commanded — otherwise every poll after your
 * own command looks like a button press. (The hub would absorb that anyway, but
 * the activity feed would be full of lies.)
 */
export class KasaAdapter extends LampAdapter {
  async start() {
    throw new Error(
      'The kasa adapter is a stub. See src/adapters/kasa.js for the two viable ' +
        'approaches (per-home bridge, or TP-Link cloud polling) before wiring it up.',
    );
  }

  async set(_on) {
    throw new Error('kasa adapter not implemented');
  }
}
