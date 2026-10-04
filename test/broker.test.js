import test from 'node:test';
import assert from 'node:assert/strict';
import { Broker } from '../src/broker.js';

/** Aedes keeps internal timers alive, so every broker must be closed. */
function withBroker(t) {
  const broker = new Broker();
  t.after(() => broker.close());
  return broker;
}

test('topic filters match the way MQTT says they should', (t) => {
  const broker = withBroker(t);
  const hits = [];

  broker.subscribe('shellyplug-abc/events/rpc', (p, topic) => hits.push(['exact', topic]));
  broker.subscribe('shellyplug-abc/#', (p, topic) => hits.push(['hash', topic]));
  broker.subscribe('stat/+/POWER', (p, topic) => hits.push(['plus', topic]));

  const dispatch = (topic) =>
    broker.aedes.emit('publish', { topic, payload: Buffer.from('x') }, { id: 'c' });

  dispatch('shellyplug-abc/events/rpc');
  dispatch('shellyplug-abc/status/switch:0');
  dispatch('shellyplug-xyz/events/rpc');
  dispatch('stat/lamp-kevin/POWER');
  dispatch('stat/lamp-kevin/RESULT');

  assert.deepEqual(hits, [
    ['exact', 'shellyplug-abc/events/rpc'],
    ['hash', 'shellyplug-abc/events/rpc'],
    ['hash', 'shellyplug-abc/status/switch:0'],
    ['plus', 'stat/lamp-kevin/POWER'],
  ]);
});

test('our own publishes are not fed back into our own handlers', (t) => {
  const broker = withBroker(t);
  const hits = [];
  broker.subscribe('a/#', () => hits.push(1));

  // `client` is null for server-side publishes.
  broker.aedes.emit('publish', { topic: 'a/b', payload: Buffer.from('x') }, null);

  assert.deepEqual(hits, [], 'a command we sent must not look like a device report');
});

test('a device may only touch its own topics', async (t) => {
  const broker = withBroker(t);
  broker.addDevice('kevin-lamp', {
    password: 'pw1',
    topics: ['shellyplug-kev/#', 'lamplink/kevin-lamp/#'],
  });
  broker.addDevice('sam-lamp', { password: 'pw2', topics: ['shellyplug-sam/#'] });

  const canPublish = (username, topic) =>
    new Promise((resolve) => {
      broker.aedes.authorizePublish({ lamplinkUser: username }, { topic }, (err) => resolve(!err));
    });
  const canSubscribe = (username, topic) =>
    new Promise((resolve) => {
      broker.aedes.authorizeSubscribe({ lamplinkUser: username }, { topic }, (err) => resolve(!err));
    });

  assert.equal(await canPublish('kevin-lamp', 'shellyplug-kev/events/rpc'), true);
  assert.equal(await canPublish('kevin-lamp', 'lamplink/kevin-lamp/rpc'), true);
  assert.equal(await canSubscribe('kevin-lamp', 'shellyplug-kev/rpc'), true);

  // Kevin's plug must not be able to command or eavesdrop on Sam's lamp.
  assert.equal(await canPublish('kevin-lamp', 'shellyplug-sam/rpc'), false);
  assert.equal(await canPublish('kevin-lamp', 'lamplink/sam-lamp/rpc'), false);
  assert.equal(await canSubscribe('kevin-lamp', 'shellyplug-sam/#'), false);
  assert.equal(await canPublish('sam-lamp', 'shellyplug-kev/rpc'), false);
  assert.equal(await canPublish('unknown-lamp', 'shellyplug-kev/rpc'), false);
});

test('bad credentials are rejected', async (t) => {
  const broker = withBroker(t);
  broker.addDevice('kevin-lamp', { password: 'correct-horse', topics: ['x/#'] });

  const auth = (username, password) =>
    new Promise((resolve) => {
      broker.aedes.authenticate(
        { id: 'c' },
        username,
        password ? Buffer.from(password) : null,
        (err, ok) => resolve(Boolean(ok) && !err),
      );
    });

  assert.equal(await auth('kevin-lamp', 'correct-horse'), true);
  assert.equal(await auth('kevin-lamp', 'wrong'), false);
  assert.equal(await auth('kevin-lamp', 'correct-hors'), false);
  assert.equal(await auth('kevin-lamp', null), false);
  assert.equal(await auth('nobody', 'correct-horse'), false);
  assert.equal(await auth(null, 'correct-horse'), false);
});
