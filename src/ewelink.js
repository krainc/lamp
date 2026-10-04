import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { logger } from './log.js';

const log = logger('ewelink');

const API_HOSTS = {
  cn: 'https://cn-apia.coolkit.cn',
  as: 'https://as-apia.coolkit.cc',
  us: 'https://us-apia.coolkit.cc',
  eu: 'https://eu-apia.coolkit.cc',
};

const DISPATCH_HOSTS = {
  cn: 'https://cn-dispa.coolkit.cn',
  as: 'https://as-dispa.coolkit.cc',
  us: 'https://us-dispa.coolkit.cc',
  eu: 'https://eu-dispa.coolkit.cc',
};

/** eWeLink error codes worth translating into something actionable. */
const ERRORS = {
  400: 'bad request — check the account, password and areaCode in config.ewelink',
  401: 'eWeLink rejected the credentials (wrong email or password)',
  402: 'the access token expired',
  403: 'this app is not authorised — check appId/appSecret from dev.ewelink.cc',
  404: 'not found',
  406: 'the access token was rejected — Lamplink will sign in again',
  10001: 'the password is wrong',
  10004: 'wrong region for this account',
  30000: 'rate limited by eWeLink — too many requests',
};

/**
 * One shared connection to eWeLink's cloud, serving every Sonoff lamp.
 *
 * Sonoff's S40 runs on a BL602 chip, which no open firmware supports, and its
 * DIY/LAN mode only works from inside the same house. So the only way for a
 * server to reach a plug sitting in someone else's home is eWeLink's own cloud.
 * This class is that path: sign in once, hold a WebSocket open, push commands
 * and receive state changes in real time.
 *
 * Everything here is outbound — Lamplink dials eWeLink, never the reverse —
 * so it needs no inbound ports and works from behind any NAT.
 */
export class EwelinkCloud extends EventEmitter {
  constructor(options) {
    super();
    const { appId, appSecret, account, password, areaCode = '+1', region = 'us' } = options || {};

    for (const [key, value] of Object.entries({ appId, appSecret, account, password })) {
      if (!value) throw new Error(`config.ewelink.${key} is required`);
    }
    if (!API_HOSTS[region]) {
      throw new Error(`config.ewelink.region must be one of ${Object.keys(API_HOSTS).join(', ')}`);
    }

    this.appId = appId;
    this.appSecret = appSecret;
    this.account = account;
    this.password = password;
    this.areaCode = areaCode.startsWith('+') ? areaCode : `+${areaCode}`;
    this.region = region;

    this.at = null; // access token
    this.userApiKey = null;
    this.devices = new Map(); // deviceId -> { name, online, apikey, params }

    this.ws = null;
    this.hbTimer = null;
    this.pongTimer = null;
    this.reconnectTimer = null;
    this.backoff = 1000;
    this.stopped = false;
    this.ready = false;
    // Kept so the web UI can say *why* a Sonoff lamp is unreachable instead of
    // just showing it greyed out.
    this.lastError = null;
  }

  // --- signing ---------------------------------------------------------------

  #nonce() {
    return crypto.randomBytes(6).toString('base64url').slice(0, 8);
  }

  #sign(body) {
    return crypto.createHmac('sha256', this.appSecret).update(body).digest('base64');
  }

  async #request(path, { method = 'GET', body = null, auth = 'bearer' } = {}) {
    const raw = body ? JSON.stringify(body) : null;
    const headers = {
      'Content-Type': 'application/json',
      'X-CK-Appid': this.appId,
      'X-CK-Nonce': this.#nonce(),
    };

    if (auth === 'sign') headers.Authorization = `Sign ${this.#sign(raw ?? '')}`;
    else if (auth === 'bearer') headers.Authorization = `Bearer ${this.at}`;

    const url = `${API_HOSTS[this.region]}${path}`;
    const res = await fetch(url, { method, headers, body: raw });

    if (!res.ok) {
      throw new Error(`eWeLink ${path} returned HTTP ${res.status}`);
    }

    const json = await res.json();
    if (json.error && json.error !== 0) {
      const hint = ERRORS[json.error] || json.msg || 'unknown error';
      const err = new Error(`eWeLink ${path} error ${json.error}: ${hint}`);
      err.code = json.error;
      err.data = json.data;
      throw err;
    }
    return json.data;
  }

  // --- sign in ---------------------------------------------------------------

  async login() {
    const body = {
      password: this.password,
      countryCode: this.areaCode,
      // eWeLink accepts either; pick based on what the account looks like.
      ...(this.account.includes('@') ? { email: this.account } : { phoneNumber: this.account }),
    };

    let data;
    try {
      data = await this.#request('/v2/user/login', { method: 'POST', body, auth: 'sign' });
    } catch (err) {
      // 10004 means "right credentials, wrong datacentre" and the response
      // carries the region the account actually lives in.
      if (err.code === 10004 && err.data?.region && API_HOSTS[err.data.region]) {
        log.info(`account lives in the "${err.data.region}" region, not "${this.region}" — switching`);
        this.region = err.data.region;
        data = await this.#request('/v2/user/login', { method: 'POST', body, auth: 'sign' });
      } else {
        throw err;
      }
    }

    this.at = data.at;
    this.userApiKey = data.user?.apikey;
    if (!this.at || !this.userApiKey) {
      throw new Error('eWeLink login succeeded but returned no token — unexpected response shape');
    }
    log.info(`signed in to eWeLink (${this.region})`);
    return data;
  }

  async listDevices() {
    const data = await this.#request('/v2/device/thing?num=0');
    const list = data?.thingList || [];

    this.devices.clear();
    for (const thing of list) {
      const d = thing.itemData;
      if (!d?.deviceid) continue; // groups and rooms also come back here
      this.devices.set(d.deviceid, {
        deviceId: d.deviceid,
        name: d.name,
        online: Boolean(d.online),
        // For a device shared with this account, commands must carry the
        // *owner's* apikey, not ours.
        apikey: d.apikey || this.userApiKey,
        params: d.params || {},
        model: d.extra?.model || d.productModel || 'unknown',
      });
    }
    log.info(`found ${this.devices.size} device(s) on the account`);
    return [...this.devices.values()];
  }

  // --- realtime --------------------------------------------------------------

  async start() {
    this.stopped = false;
    try {
      await this.login();
      await this.listDevices();
      await this.#openSocket();
      this.lastError = null;
    } catch (err) {
      this.lastError = err.message;
      // Keep trying in the background. eWeLink being down at boot, or the
      // server starting before the network is up, must not mean the lamps stay
      // dead until someone redeploys.
      this.#scheduleReconnect();
      throw err;
    }
  }

  async #openSocket() {
    if (this.stopped) return;

    const dispatchUrl = `${DISPATCH_HOSTS[this.region]}/dispatch/app`;
    const res = await fetch(dispatchUrl, {
      headers: {
        'Content-Type': 'application/json',
        'X-CK-Appid': this.appId,
        'X-CK-Nonce': this.#nonce(),
        Authorization: `Bearer ${this.at}`,
      },
    });
    const dispatch = await res.json();
    if (!dispatch.domain) {
      throw new Error(`eWeLink dispatch gave no websocket host: ${JSON.stringify(dispatch)}`);
    }

    const url = `wss://${dispatch.domain}:${dispatch.port || 8080}/api/ws`;
    log.info(`connecting websocket to ${dispatch.domain}`);

    const ws = new WebSocket(url);
    this.ws = ws;

    ws.on('open', () => {
      ws.send(
        JSON.stringify({
          action: 'userOnline',
          version: 8,
          ts: Math.floor(Date.now() / 1000),
          at: this.at,
          userAgent: 'app',
          apikey: this.userApiKey,
          appid: this.appId,
          nonce: this.#nonce(),
          sequence: String(Date.now()),
        }),
      );
    });

    ws.on('message', (raw) => this.#onMessage(raw));
    ws.on('error', (err) => log.warn(`websocket error: ${err.message}`));
    ws.on('close', (code) => {
      log.warn(`websocket closed (${code})`);
      this.#teardownSocket();
      this.#scheduleReconnect();
    });
  }

  #onMessage(raw) {
    const text = raw.toString();

    // The heartbeat reply is a bare string, not JSON.
    if (text === 'pong') {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
      return;
    }

    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      log.debug(`ignoring non-JSON frame: ${text.slice(0, 80)}`);
      return;
    }

    // Handshake reply: no action, no deviceid — just a verdict on our login,
    // and the heartbeat interval the server wants us to use.
    if (!msg.action && !msg.deviceid) {
      if (msg.error) {
        log.error(`websocket handshake rejected with error ${msg.error}`);
        // A stale token needs a fresh sign-in, not just another socket.
        if ([401, 402, 406].includes(msg.error)) {
          this.#reauthenticate();
        } else {
          this.ws?.terminate();
        }
        return;
      }
      const interval = (msg.config?.hbInterval || 145) * 1000;
      this.#startHeartbeat(interval);

      const firstConnect = !this.ready;
      this.ready = true;
      this.backoff = 1000;
      log.info(`websocket ready (heartbeat every ${Math.round(interval / 1000)}s)`);
      this.emit('ready', { firstConnect });
      return;
    }

    if (!msg.deviceid) return;

    // A device told us something. `params` may carry switch state, and sysmsg
    // carries reachability.
    const device = this.devices.get(msg.deviceid);
    if (device && msg.params) Object.assign(device.params, msg.params);

    if (msg.action === 'sysmsg' && msg.params?.online !== undefined) {
      if (device) device.online = Boolean(msg.params.online);
      this.emit('device', { deviceId: msg.deviceid, online: Boolean(msg.params.online) });
      return;
    }

    if (msg.params?.switch !== undefined) {
      this.emit('device', {
        deviceId: msg.deviceid,
        online: true,
        on: msg.params.switch === 'on',
      });
    }
  }

  #startHeartbeat(interval) {
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return;
      this.ws.send('ping');

      // If the server doesn't answer, the socket is a zombie — NAT timeouts
      // and dropped Wi-Fi often leave one that looks open but carries nothing.
      clearTimeout(this.pongTimer);
      this.pongTimer = setTimeout(() => {
        log.warn('no pong from eWeLink; forcing a reconnect');
        this.ws?.terminate();
      }, 20_000);
      this.pongTimer.unref?.();
    }, interval);
    this.hbTimer.unref?.();
  }

  #teardownSocket() {
    clearInterval(this.hbTimer);
    clearTimeout(this.pongTimer);
    this.hbTimer = null;
    this.pongTimer = null;
    this.ready = false;
    this.ws = null;
  }

  #scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = this.backoff;
    this.backoff = Math.min(this.backoff * 2, 60_000);
    log.info(`reconnecting to eWeLink in ${Math.round(delay / 1000)}s`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        // No token means the last sign-in never succeeded (eWeLink down, or
        // the server booted before the network was up). Start from scratch.
        if (!this.at) {
          await this.login();
          await this.listDevices();
        }
        await this.#openSocket();
        this.lastError = null;
      } catch (err) {
        this.lastError = err.message;
        log.error(`reconnect failed: ${err.message}`);
        // A rejected token needs a fresh sign-in, not just another socket.
        if ([401, 402, 406].includes(err.code)) this.at = null;
        this.#scheduleReconnect();
      }
    }, delay);
    this.reconnectTimer.unref?.();
  }

  /**
   * Drop the token and let the reconnect loop sign in from scratch. eWeLink
   * invalidates tokens when the same account signs in elsewhere — which happens
   * every time someone opens the phone app — so this is routine, not alarming.
   */
  #reauthenticate() {
    log.info('access token rejected; signing in again');
    this.at = null;
    this.ws?.terminate();
  }

  // --- commands --------------------------------------------------------------

  /**
   * Set a device's relay. Resolves once the command is on the wire; the real
   * confirmation arrives later as a 'device' event.
   */
  async setSwitch(deviceId, on) {
    if (this.ws?.readyState !== WebSocket.OPEN || !this.ready) {
      throw new Error('not connected to eWeLink');
    }
    const device = this.devices.get(deviceId);

    this.ws.send(
      JSON.stringify({
        action: 'update',
        apikey: device?.apikey || this.userApiKey,
        selfApikey: this.userApiKey,
        deviceid: deviceId,
        params: { switch: on ? 'on' : 'off' },
        userAgent: 'app',
        sequence: String(Date.now()),
      }),
    );
  }

  known(deviceId) {
    return this.devices.get(deviceId) || null;
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;

    // Close before teardown — teardown drops the reference.
    const ws = this.ws;
    this.#teardownSocket();
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already gone */
      }
    }
  }
}
