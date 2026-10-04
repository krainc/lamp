import test from 'node:test';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import { Broker } from '../src/broker.js';
import { Hub } from '../src/hub.js';
import { Store } from '../src/state.js';
import { ShellyMqttAdapter } from '../src/adapters/shelly-mqtt.js';
import { logger } from '../src/log.js';

/**
 * End-to-end over a real MQTT socket: two pretend Shelly plugs connect to the
 * embedded broker, one reports a button press, and we assert the other actually
 * receives a `Switch.Set` RPC. This is the path that runs in production, so it
 * is worth testing over a real connection rather than with fakes.
 */

const PREFIX = { kevin: 'shellyplug-kev', sam: 'shellyplug-sam' };

function buildConfig() {
  return {
    lockBehavior: 'private',
    adoptGroupStateOnUnlock: false,
    flapGuard: { maxChanges: 8, windowMs: 10_000, cooldownMs: 60_000 },
    users: [
      {
        id: 'kevin',
        name: 'Kevin',
        token: 'x'.repeat(24),
        lamp: {
          id: 'kevin-lamp',
          adapter: 'shelly-mqtt',
          userId: 'kevin',
          options: { topicPrefix: PREFIX.kevin, switchId: 0, mqttPassword: 'pw-kevin' },
        },
      },
      {
        id: 'sam',
        name: 'Sam',
        token: 'y'.repeat(24),
        lamp: {
          id: 'sam-lamp',
          adapter: 'shelly-mqtt',
          userId: 'sam',
          options: { topicPrefix: PREFIX.sam, switchId: 0, mqttPassword: 'pw-sam' },
        },
      },
    ],
  };
}

let nextPort = 18830;

/** Boots a broker on its own port with both adapters wired to a hub. */
async function boot(t) {
  const config = buildConfig();
  const store = new Store({ filePath: null, lampIds: config.users.map((u) => u.lamp.id) });
  const hub = new Hub({ config, store });
  const broker = new Broker();
  const clients = [];

  // Registered before anything can throw: an un-closed Aedes instance keeps
  // timers alive and the whole test run never exits. Plugs are closed first —
  // aedes will not finish shutting down while a client socket is attached.
  t.after(async () => {
    await Promise.allSettled(clients.map((c) => c.endAsync(true)));
    await broker.close();
  });

  for (const user of config.users) {
    const adapter = new ShellyMqttAdapter({
      lampId: user.lamp.id,
      options: user.lamp.options,
      ctx: { broker, log: logger('test') },
      report: (report) => hub.report(user.lamp.id, report),
    });
    hub.attachAdapter(user.lamp.id, adapter);
    const creds = adapter.mqttCredentials();
    broker.addDevice(creds.username, creds);
    await adapter.start();
  }

  const port = nextPort++;
  await broker.listen(port, '127.0.0.1');

  return { hub, broker, port, clients, config, snapshot: () => hub.snapshot() };
}

/** A pretend Shelly plug speaking real MQTT. */
function connectPlug(env, { username, password, prefix }) {
  const client = mqtt.connect(`mqtt://127.0.0.1:${env.port}`, {
    username,
    password,
    clientId: username,
    reconnectPeriod: 0,
    connectTimeout: 4000,
  });
  env.clients.push(client);

  const rpcCalls = [];
  if (process.env.MQTT_TRACE) {
    for (const ev of ['connect', 'error', 'close', 'offline', 'end', 'reconnect']) {
      client.on(ev, (a) => console.error(`    [${username}] ${ev} ${a?.message || ''}`));
    }
  }
  client.on('connect', () => {
    client.subscribe(`${prefix}/rpc`);
    client.publish(`${prefix}/online`, 'true');
  });
  client.on('message', (topic, payload) => {
    if (topic === `${prefix}/rpc`) rpcCalls.push(JSON.parse(payload.toString()));
  });

  return {
    client,
    rpcCalls,
    ready: new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('error', reject);
    }),
    /** Publish a NotifyStatus the way a real Gen2/Gen3 device does. */
    notify(on, source) {
      client.publish(
        `${prefix}/events/rpc`,
        JSON.stringify({
          src: prefix,
          dst: `${prefix}/events`,
          method: 'NotifyStatus',
          params: { ts: 1_700_000_000, 'switch:0': { id: 0, output: on, source } },
        }),
      );
    },
  };
}

const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test('a real plug connecting is reported online', async (t) => {
  const env = await boot(t);
  const { snapshot } = env;
  const kevin = connectPlug(env, { username: 'kevin-lamp', password: 'pw-kevin', prefix: PREFIX.kevin });
  await kevin.ready;
  await settle();

  const lamp = snapshot().lamps.find((l) => l.userId === 'kevin');
  assert.equal(lamp.online, true);

  // Coming online triggers a Switch.GetStatus so we never trust stale state.
  assert.ok(
    kevin.rpcCalls.some((c) => c.method === 'Switch.GetStatus'),
    `expected a GetStatus, got ${JSON.stringify(kevin.rpcCalls)}`,
  );
});

test('a plug with the wrong password is refused', async (t) => {
  const env = await boot(t);
  const bad = connectPlug(env, { username: 'kevin-lamp', password: 'wrong', prefix: PREFIX.kevin });

  await assert.rejects(bad.ready, /Connection refused|Bad user name|not authorized/i);
});

test('a button press on one plug sends Switch.Set to the other', async (t) => {
  const env = await boot(t);
  const { snapshot } = env;

  const kevin = connectPlug(env, { username: 'kevin-lamp', password: 'pw-kevin', prefix: PREFIX.kevin });
  const sam = connectPlug(env, { username: 'sam-lamp', password: 'pw-sam', prefix: PREFIX.sam });
  await Promise.all([kevin.ready, sam.ready]);
  await settle();
  sam.rpcCalls.length = 0;

  // Somebody pressed the button on Kevin's plug.
  kevin.notify(true, 'button');
  await settle(250);

  const setCalls = sam.rpcCalls.filter((c) => c.method === 'Switch.Set');
  assert.equal(setCalls.length, 1, `expected one Switch.Set, got ${JSON.stringify(sam.rpcCalls)}`);
  assert.deepEqual(setCalls[0].params, { id: 0, on: true });
  assert.equal(setCalls[0].src, 'lamplink/sam-lamp', 'responses must route back to a per-lamp topic');

  assert.equal(snapshot().lamps.find((l) => l.userId === 'sam').on, true);
});

test('a change sourced from MQTT is treated as our own echo', async (t) => {
  const env = await boot(t);

  const kevin = connectPlug(env, { username: 'kevin-lamp', password: 'pw-kevin', prefix: PREFIX.kevin });
  const sam = connectPlug(env, { username: 'sam-lamp', password: 'pw-sam', prefix: PREFIX.sam });
  await Promise.all([kevin.ready, sam.ready]);
  await settle();

  kevin.notify(true, 'button');
  await settle(250);
  const afterFanout = sam.rpcCalls.length;

  // Sam's plug confirms the change it just received. This must not bounce back.
  sam.notify(true, 'MQTT');
  await settle(250);

  assert.equal(sam.rpcCalls.length, afterFanout, 'an MQTT-sourced report must not cause more commands');
  assert.equal(kevin.rpcCalls.filter((c) => c.method === 'Switch.Set').length, 0, 'Kevin must not be re-commanded');
});

test('a plug going offline stops it being commanded', async (t) => {
  const env = await boot(t);
  const { snapshot } = env;

  const kevin = connectPlug(env, { username: 'kevin-lamp', password: 'pw-kevin', prefix: PREFIX.kevin });
  const sam = connectPlug(env, { username: 'sam-lamp', password: 'pw-sam', prefix: PREFIX.sam });
  await Promise.all([kevin.ready, sam.ready]);
  await settle();

  sam.client.publish(`${PREFIX.sam}/online`, 'false');
  await settle(200);
  assert.equal(snapshot().lamps.find((l) => l.userId === 'sam').online, false);

  sam.rpcCalls.length = 0;
  kevin.notify(true, 'button');
  await settle(250);

  assert.deepEqual(sam.rpcCalls, [], 'an offline plug should not be commanded');
});
