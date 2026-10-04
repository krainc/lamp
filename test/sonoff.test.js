import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { SonoffEwelinkAdapter } from '../src/adapters/sonoff-ewelink.js';
import { loadConfig } from '../src/config.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/state.js';
import { logger } from '../src/log.js';

/** Stands in for EwelinkCloud: same events, same methods, no network. */
class FakeCloud extends EventEmitter {
  constructor(devices = {}) {
    super();
    this.devices = new Map(Object.entries(devices));
    this.sent = [];
    this.ready = false;
    this.failSend = false;
  }

  known(id) {
    return this.devices.get(id) || null;
  }

  async setSwitch(deviceId, on) {
    if (this.failSend) throw new Error('not connected to eWeLink');
    this.sent.push({ deviceId, on });
    this.devices.get(deviceId).params.switch = on ? 'on' : 'off';
  }

  /** The cloud finished its handshake and replayed current state. */
  connect() {
    this.ready = true;
    this.emit('ready', { firstConnect: true });
  }

  /** A genuine change arriving over the websocket. */
  push(deviceId, on) {
    const d = this.devices.get(deviceId);
    if (d) d.params.switch = on ? 'on' : 'off';
    this.emit('device', { deviceId, online: true, on });
  }

  setOnline(deviceId, online) {
    this.emit('device', { deviceId, online });
  }
}

function makeAdapter(cloud, { deviceId = 'dev-1', lampId = 'kevin-lamp' } = {}) {
  const reports = [];
  const adapter = new SonoffEwelinkAdapter({
    lampId,
    options: { deviceId },
    ctx: { ewelink: cloud, log: logger('test') },
    report: (r) => reports.push(r),
  });
  return { adapter, reports };
}

const DEVICE = () => ({ 'dev-1': { deviceId: 'dev-1', name: 'Lamp', online: true, params: { switch: 'off' } } });

// --- wiring -----------------------------------------------------------------

test('refuses to start without a deviceId', async () => {
  const cloud = new FakeCloud(DEVICE());
  const adapter = new SonoffEwelinkAdapter({
    lampId: 'kevin-lamp',
    options: {}, // no deviceId at all
    ctx: { ewelink: cloud, log: logger('test') },
    report: () => {},
  });
  await assert.rejects(() => adapter.start(), /requires options\.deviceId/);
});

test('refuses to start without a cloud connection', async () => {
  const reports = [];
  const adapter = new SonoffEwelinkAdapter({
    lampId: 'x',
    options: { deviceId: 'dev-1' },
    ctx: { log: logger('test') },
    report: (r) => reports.push(r),
  });
  await assert.rejects(() => adapter.start(), /needs an "ewelink" block/);
});

test('only reacts to its own device', async () => {
  const cloud = new FakeCloud({
    ...DEVICE(),
    'dev-2': { deviceId: 'dev-2', name: 'Other', online: true, params: { switch: 'off' } },
  });
  const { adapter, reports } = makeAdapter(cloud);
  await adapter.start();
  reports.length = 0;

  cloud.push('dev-2', true);
  assert.deepEqual(reports, [], 'another lamp’s device must not report here');

  cloud.push('dev-1', true);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].on, true);
});

test('a device missing from the account is reported, not thrown', async () => {
  const cloud = new FakeCloud(DEVICE());
  const { adapter, reports } = makeAdapter(cloud, { deviceId: 'nope' });
  await adapter.start();
  cloud.connect();

  const last = reports.at(-1);
  assert.equal(last.online, false);
  assert.match(last.error, /not found/);
});

// --- the reconnect hazard ---------------------------------------------------

test('state replayed on connect is tagged init, never local', async () => {
  const cloud = new FakeCloud(DEVICE());
  const { adapter, reports } = makeAdapter(cloud);
  await adapter.start();
  reports.length = 0;

  cloud.connect();

  const report = reports.at(-1);
  assert.equal(report.source, 'init', 'a reconnect must not look like a button press');
  assert.equal(report.on, false);
});

test('a real change after connecting is tagged local', async () => {
  const cloud = new FakeCloud(DEVICE());
  const { adapter, reports } = makeAdapter(cloud);
  await adapter.start();
  cloud.connect();
  reports.length = 0;

  cloud.push('dev-1', true);

  assert.equal(reports.at(-1).source, 'local', 'a genuine press must still propagate');
  assert.equal(reports.at(-1).on, true);
});

test('a reconnect does not turn the group off', async () => {
  // The scenario that matters: everyone is on, the server briefly loses its
  // websocket, and the replayed state must not fan out.
  const config = {
    lockBehavior: 'private',
    adoptGroupStateOnUnlock: false,
    flapGuard: { maxChanges: 8, windowMs: 10_000, cooldownMs: 60_000 },
    users: ['a', 'b'].map((id) => ({
      id,
      name: id,
      token: `token-${id}-0000000000000000`,
      lamp: { id: `${id}-lamp`, adapter: 'virtual', options: {}, userId: id },
    })),
  };
  const store = new Store({ filePath: null, lampIds: ['a-lamp', 'b-lamp'] });
  const hub = new Hub({ config, store });

  const cloud = new FakeCloud(DEVICE());
  const adapter = new SonoffEwelinkAdapter({
    lampId: 'a-lamp',
    options: { deviceId: 'dev-1' },
    ctx: { ewelink: cloud, log: logger('test') },
    report: (r) => hub.report('a-lamp', r),
  });
  hub.attachAdapter('a-lamp', adapter);

  const bCommands = [];
  hub.attachAdapter('b-lamp', { set: async (on) => bCommands.push(on) });
  hub.report('b-lamp', { online: true, on: true, source: 'init' });

  await adapter.start();
  cloud.push('dev-1', true); // A turns on for real; B follows
  assert.deepEqual(bCommands, [], 'B was already on');
  assert.equal(hub.snapshot().lamps.find((l) => l.userId === 'b').on, true);

  // Now the socket drops and reconnects while the plug reads "off" briefly.
  cloud.devices.get('dev-1').params.switch = 'off';
  cloud.connect();

  assert.deepEqual(bCommands, [], 'a reconnect replay must never command anyone');
});

// --- commands ---------------------------------------------------------------

test('set() forwards to the cloud', async () => {
  const cloud = new FakeCloud(DEVICE());
  const { adapter } = makeAdapter(cloud);
  await adapter.start();

  await adapter.set(true);
  await adapter.set(false);

  assert.deepEqual(cloud.sent, [
    { deviceId: 'dev-1', on: true },
    { deviceId: 'dev-1', on: false },
  ]);
});

test('a disconnected cloud surfaces the failure to the hub', async () => {
  const cloud = new FakeCloud(DEVICE());
  const { adapter } = makeAdapter(cloud);
  await adapter.start();
  cloud.failSend = true;

  await assert.rejects(() => adapter.set(true), /not connected/);
});

test('offline notifications reach the hub without touching lamp state', async () => {
  const cloud = new FakeCloud(DEVICE());
  const { adapter, reports } = makeAdapter(cloud);
  await adapter.start();
  reports.length = 0;

  cloud.setOnline('dev-1', false);

  assert.equal(reports.at(-1).online, false);
  assert.equal(reports.at(-1).on, undefined, 'going offline is not a state change');
});

test('stop() unsubscribes so a restarted adapter does not double-report', async () => {
  const cloud = new FakeCloud(DEVICE());
  const { adapter, reports } = makeAdapter(cloud);
  await adapter.start();
  await adapter.stop();
  reports.length = 0;

  cloud.push('dev-1', true);
  assert.deepEqual(reports, []);
});

// --- config validation ------------------------------------------------------

function withConfig(raw, fn) {
  const prev = process.env.LAMPLINK_CONFIG;
  process.env.LAMPLINK_CONFIG = JSON.stringify(raw);
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.LAMPLINK_CONFIG;
    else process.env.LAMPLINK_CONFIG = prev;
  }
}

const baseUser = (over = {}) => ({
  id: 'kevin',
  name: 'Kevin',
  token: 'token-kevin-0000000000000000',
  lamp: { id: 'kevin-lamp', adapter: 'sonoff-ewelink', options: { deviceId: 'dev-1' } },
  ...over,
});

test('config without an ewelink block is rejected when a lamp needs one', () => {
  withConfig({ users: [baseUser()] }, () => {
    assert.throws(() => loadConfig(), /config\.ewelink is required/);
  });
});

test('config missing an eWeLink credential names the field', () => {
  withConfig(
    { ewelink: { appId: 'a', appSecret: 'b', account: 'c' }, users: [baseUser()] },
    () => assert.throws(() => loadConfig(), /config\.ewelink\.password is required/),
  );
});

test('a bad region is rejected', () => {
  withConfig(
    {
      ewelink: { appId: 'a', appSecret: 'b', account: 'c', password: 'd', region: 'mars' },
      users: [baseUser()],
    },
    () => assert.throws(() => loadConfig(), /must be us, eu, as or cn/),
  );
});

test('a lamp without a deviceId points at the discovery command', () => {
  const user = baseUser();
  user.lamp.options = {};
  withConfig({ ewelink: { appId: 'a', appSecret: 'b', account: 'c', password: 'd' }, users: [user] }, () =>
    assert.throws(() => loadConfig(), /npm run ewelink/),
  );
});

test('two lamps sharing one plug is rejected', () => {
  const kevin = baseUser();
  const sam = baseUser({
    id: 'sam',
    name: 'Sam',
    token: 'token-sam-00000000000000000',
    lamp: { id: 'sam-lamp', adapter: 'sonoff-ewelink', options: { deviceId: 'dev-1' } },
  });
  withConfig(
    { ewelink: { appId: 'a', appSecret: 'b', account: 'c', password: 'd' }, users: [kevin, sam] },
    () => assert.throws(() => loadConfig(), /each needs its own plug/),
  );
});

test('a valid sonoff config loads and defaults the region', () => {
  withConfig(
    {
      ewelink: { appId: 'a', appSecret: 'b', account: 'c@d.com', password: 'e' },
      users: [baseUser()],
    },
    () => {
      const config = loadConfig();
      assert.equal(config.ewelink.region, 'us');
      assert.equal(config.users[0].lamp.options.deviceId, 'dev-1');
    },
  );
});

test('a placeholder deviceId points at the discovery command, not a duplicate error', () => {
  const user = baseUser();
  user.lamp.options = { deviceId: 'CHANGE-ME-run-npm-run-ewelink' };
  withConfig({ ewelink: { appId: 'a', appSecret: 'b', account: 'c', password: 'd' }, users: [user] }, () =>
    assert.throws(() => loadConfig(), /still has the placeholder deviceId/),
  );
});
