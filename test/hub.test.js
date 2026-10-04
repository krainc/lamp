import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { Store } from '../src/state.js';

/**
 * A stand-in for a plug. Records commands, and can echo them back the way real
 * hardware does — which is exactly the path an infinite sync loop would take.
 */
class FakeLamp {
  constructor(hub, lampId, { echo = true, failing = false } = {}) {
    this.hub = hub;
    this.lampId = lampId;
    this.echo = echo;
    this.failing = failing;
    this.commands = [];
    this.on = false;
  }

  async set(on) {
    if (this.failing) throw new Error('plug unreachable');
    this.commands.push(on);
    this.on = on;
    if (this.echo) this.hub.report(this.lampId, { on, source: 'self' });
  }

  /** Someone pressed the button on the plug. */
  press(on = !this.on) {
    this.on = on;
    this.hub.report(this.lampId, { on, source: 'local' });
    return this;
  }

  /** The plug rebooted and is announcing where its relay landed. */
  boot(on) {
    this.on = on;
    this.hub.report(this.lampId, { on, source: 'init' });
  }
}

/**
 * The fan-out deliberately fires all commands in parallel rather than awaiting
 * each in turn, so a slow plug can't delay everyone else's. That means errors
 * surface a microtask later — tests that assert on them need to let it settle.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

function setup({ names = ['a', 'b', 'c'], lockBehavior = 'private', ...overrides } = {}) {
  const config = {
    lockBehavior,
    adoptGroupStateOnUnlock: false,
    flapGuard: { maxChanges: 8, windowMs: 10_000, cooldownMs: 60_000 },
    users: names.map((id) => ({
      id,
      name: id.toUpperCase(),
      token: `token-${id}-000000000000000000`,
      lamp: { id: `${id}-lamp`, adapter: 'virtual', options: {}, userId: id },
    })),
    ...overrides,
  };

  const store = new Store({ filePath: null, lampIds: config.users.map((u) => u.lamp.id) });
  const hub = new Hub({ config, store });

  const lamps = {};
  for (const user of config.users) {
    const fake = new FakeLamp(hub, user.lamp.id);
    lamps[user.id] = fake;
    hub.attachAdapter(user.lamp.id, fake);
    hub.report(user.lamp.id, { online: true, on: false, source: 'init' });
  }

  const stateOf = (id) => hub.snapshot().lamps.find((l) => l.userId === id);
  return { hub, store, lamps, stateOf, config };
}

// --- the happy path ---------------------------------------------------------

test('a button press on one lamp turns the others on', async () => {
  const { lamps, stateOf } = setup();

  lamps.a.press(true);

  assert.equal(stateOf('a').on, true);
  assert.equal(stateOf('b').on, true, 'B should have followed A');
  assert.equal(stateOf('c').on, true, 'C should have followed A');
  assert.deepEqual(lamps.b.commands, [true]);
  assert.deepEqual(lamps.c.commands, [true]);
});

test('turning off propagates too', async () => {
  const { lamps, stateOf } = setup();
  lamps.a.press(true);
  lamps.b.press(false);

  assert.equal(stateOf('a').on, false);
  assert.equal(stateOf('c').on, false);
});

test('tapping your own lamp in the app behaves like pressing its button', async () => {
  const { hub, lamps, stateOf } = setup();

  await hub.setOwnLamp('a', true);

  assert.equal(stateOf('a').on, true);
  assert.equal(stateOf('b').on, true);
  assert.deepEqual(lamps.a.commands, [true], 'A should have been commanded exactly once');
});

test('an app tap still fans out when the plug echoes back first', async () => {
  const { hub, lamps, stateOf } = setup();
  // FakeLamp echoes synchronously by default, so the plug's confirmation lands
  // before setOwnLamp gets to the fan-out. Driving that off a before/after diff
  // would see "no change" and silently drop the broadcast.
  assert.equal(lamps.a.echo, true);

  await hub.setOwnLamp('a', true);

  assert.equal(stateOf('b').on, true, 'the echo must not swallow the fan-out');
  assert.equal(stateOf('c').on, true);
});

test('an app tap fans out on plugs that never echo', async () => {
  const { hub, lamps, stateOf } = setup();
  lamps.a.echo = false;

  await hub.setOwnLamp('a', true);

  assert.equal(stateOf('a').on, true);
  assert.equal(stateOf('b').on, true);
});

// --- loop prevention, the thing most likely to burn the house down ----------

test('command echoes do not bounce back out', async () => {
  const { lamps } = setup();

  lamps.a.press(true);

  // Everyone echoed their new state back (FakeLamp does this by default).
  // Nobody should have been commanded a second time.
  assert.deepEqual(lamps.b.commands, [true]);
  assert.deepEqual(lamps.c.commands, [true]);
  assert.deepEqual(lamps.a.commands, []);
});

test('a plug that reports a local change matching group state does not re-fan-out', async () => {
  const { lamps } = setup();

  lamps.a.press(true);
  const before = lamps.c.commands.length;

  // B's plug re-announces ON as a local event (Tasmota does exactly this,
  // since it cannot tell us a change came from MQTT).
  lamps.b.press(true);

  assert.equal(lamps.c.commands.length, before, 'no redundant commands');
});

test('nobody is commanded to a state they are already in', async () => {
  const { lamps } = setup();

  lamps.a.press(true);
  lamps.b.press(false);
  lamps.a.press(true);

  assert.deepEqual(lamps.c.commands, [true, false, true], 'exactly one command per real transition');
});

test('a rebooting plug does not turn off the whole group', async () => {
  const { lamps, stateOf } = setup();

  lamps.a.press(true);
  assert.equal(stateOf('c').on, true);

  // B loses power, comes back, and announces its relay is off.
  lamps.b.boot(false);

  assert.equal(stateOf('a').on, true, 'A must be untouched');
  assert.equal(stateOf('c').on, true, 'C must be untouched');
  assert.deepEqual(lamps.c.commands, [true], 'no command from a boot report');
});

// --- locking ----------------------------------------------------------------

test('a locked lamp ignores the group', async () => {
  const { hub, lamps, stateOf } = setup();

  await hub.setLocked('b', true);
  lamps.a.press(true);

  assert.equal(stateOf('a').on, true);
  assert.equal(stateOf('b').on, false, 'B is locked and must not follow');
  assert.equal(stateOf('c').on, true);
  assert.deepEqual(lamps.b.commands, []);
});

test('a locked lamp still works as a normal lamp', async () => {
  const { hub, lamps, stateOf } = setup();

  await hub.setLocked('b', true);
  await hub.setOwnLamp('b', true);

  assert.equal(stateOf('b').on, true, 'B can still control its own lamp');
});

test('lockBehavior "private": a locked lamp does not push to others', async () => {
  const { hub, lamps, stateOf } = setup({ lockBehavior: 'private' });

  await hub.setLocked('b', true);
  lamps.b.press(true);

  assert.equal(stateOf('b').on, true);
  assert.equal(stateOf('a').on, false, 'A must not follow a private lamp');
  assert.equal(stateOf('c').on, false);
});

test('lockBehavior "muted": a locked lamp still pushes to others', async () => {
  const { hub, lamps, stateOf } = setup({ lockBehavior: 'muted' });

  await hub.setLocked('b', true);
  lamps.b.press(true);

  assert.equal(stateOf('a').on, true, 'A should follow a muted lamp');
  assert.equal(stateOf('c').on, true);

  // ...but B still refuses inbound.
  lamps.a.press(false);
  assert.equal(stateOf('b').on, true, 'B must not be turned off by A');
});

test('unlocking does not retroactively change your lamp by default', async () => {
  const { hub, lamps, stateOf } = setup();

  await hub.setLocked('b', true);
  lamps.a.press(true);
  await hub.setLocked('b', false);

  assert.equal(stateOf('b').on, false, 'B stays where it was until the next change');

  lamps.a.press(false);
  lamps.a.press(true);
  assert.equal(stateOf('b').on, true, 'B is back in the group now');
});

test('adoptGroupStateOnUnlock catches you up immediately', async () => {
  const { hub, lamps, stateOf } = setup({ adoptGroupStateOnUnlock: true });

  await hub.setLocked('b', true);
  lamps.a.press(true);
  await hub.setLocked('b', false);

  assert.equal(stateOf('b').on, true);
  assert.deepEqual(lamps.b.commands, [true]);
});

// --- resilience -------------------------------------------------------------

test('an offline lamp is skipped and rejoins on the next change', async () => {
  const { hub, lamps, stateOf } = setup();

  hub.report('b-lamp', { online: false });
  lamps.a.press(true);
  assert.deepEqual(lamps.b.commands, [], 'no point commanding an offline plug');

  hub.report('b-lamp', { online: true });
  lamps.a.press(false);
  lamps.a.press(true);
  assert.equal(stateOf('b').on, true);
});

test('one unreachable plug does not stop the others', async () => {
  const { hub, lamps, stateOf } = setup();
  lamps.b.failing = true;

  lamps.a.press(true);
  await settle();

  assert.equal(stateOf('c').on, true, 'C still gets the message');
  assert.match(stateOf('b').error, /unreachable/);
  assert.equal(stateOf('b').on, false, 'B is not marked on when the command failed');
});

test('a flapping plug is muted instead of strobing everyone', async () => {
  const { lamps, stateOf } = setup();

  for (let i = 0; i < 12; i++) lamps.a.press(i % 2 === 0);

  assert.equal(stateOf('a').muted, true, 'A should be flap-guarded');

  const before = lamps.c.commands.length;
  lamps.a.press(true);
  lamps.a.press(false);
  assert.equal(lamps.c.commands.length, before, 'C is shielded from the flapping');
});

test('a flap-guarded lamp still responds to its own owner', async () => {
  const { hub, lamps, stateOf } = setup();

  for (let i = 0; i < 12; i++) lamps.a.press(i % 2 === 0);
  await hub.setOwnLamp('a', true);

  assert.equal(stateOf('a').on, true);
});

// --- what the browsers actually see -----------------------------------------

test('the final pushed snapshot reflects the completed fan-out', async () => {
  const { hub, lamps } = setup();
  const pushes = [];
  hub.on('change', (snap) => pushes.push(snap.lamps.map((l) => l.on)));

  lamps.a.press(true);
  await settle();

  assert.ok(pushes.length > 0, 'something must be pushed');
  assert.deepEqual(
    pushes.at(-1),
    [true, true, true],
    'the last push a browser receives must show the whole group, not a mid-flight snapshot',
  );
});

test('a fan-out with no eligible targets still settles cleanly', async () => {
  const { hub, lamps, stateOf } = setup();
  await hub.setLocked('b', true);
  await hub.setLocked('c', true);

  lamps.a.press(true);
  await settle();

  assert.equal(stateOf('a').on, true);
  assert.equal(stateOf('b').on, false);
});

// --- bookkeeping ------------------------------------------------------------

test('snapshot marks the viewer and hides nothing else', async () => {
  const { hub } = setup();
  const snap = hub.snapshot('b');

  assert.equal(snap.you, 'b');
  assert.equal(snap.lamps.filter((l) => l.isYou).length, 1);
  assert.equal(snap.lamps.find((l) => l.isYou).userId, 'b');
  assert.equal(snap.lamps.length, 3);
});

test('the activity feed records who did what', async () => {
  const { hub, lamps } = setup();

  lamps.a.press(true);
  await hub.setLocked('b', true);

  const kinds = hub.snapshot().events.map((e) => `${e.userId}:${e.kind}`);
  assert.ok(kinds.includes('b:locked'), `expected a lock event, got ${kinds.join(', ')}`);
  assert.ok(kinds.includes('a:on'), `expected an on event, got ${kinds.join(', ')}`);
});

test('a two-person group works the same way', async () => {
  const { lamps, stateOf } = setup({ names: ['x', 'y'] });

  lamps.x.press(true);
  assert.equal(stateOf('y').on, true);

  lamps.y.press(false);
  assert.equal(stateOf('x').on, false);
});
