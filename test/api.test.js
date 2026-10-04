import test from 'node:test';
import assert from 'node:assert/strict';
import { Hub } from '../src/hub.js';
import { Store } from '../src/state.js';
import { makeAuth } from '../src/auth.js';
import { createServer } from '../src/server.js';
import { VirtualAdapter } from '../src/adapters/virtual.js';
import { logger } from '../src/log.js';

const TOKENS = {
  kevin: 'tok-kevin-000000000000000000',
  sam: 'tok-sam-0000000000000000000',
};

/** Boots a real HTTP server on an ephemeral port. */
async function boot(t) {
  const config = {
    lockBehavior: 'private',
    adoptGroupStateOnUnlock: false,
    flapGuard: { maxChanges: 8, windowMs: 10_000, cooldownMs: 60_000 },
    users: [
      { id: 'kevin', name: 'Kevin', token: TOKENS.kevin, lamp: { id: 'kevin-lamp', adapter: 'virtual', options: {}, userId: 'kevin' } },
      { id: 'sam', name: 'Sam', token: TOKENS.sam, lamp: { id: 'sam-lamp', adapter: 'virtual', options: {}, userId: 'sam' } },
    ],
  };

  const store = new Store({ filePath: null, lampIds: ['kevin-lamp', 'sam-lamp'] });
  const hub = new Hub({ config, store });
  const adapters = new Map();

  for (const user of config.users) {
    const adapter = new VirtualAdapter({
      lampId: user.lamp.id,
      options: {},
      ctx: { log: logger('test') },
      report: (r) => hub.report(user.lamp.id, r),
    });
    adapters.set(user.lamp.id, adapter);
    hub.attachAdapter(user.lamp.id, adapter);
    await adapter.start();
  }

  const auth = makeAuth('t'.repeat(48));
  const { server, close } = createServer({
    config,
    hub,
    auth,
    adapters,
    publicDir: new URL('../public', import.meta.url).pathname,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(() => close());

  return { base, hub };
}

const bearer = (token) => ({ Authorization: `Bearer ${token}` });
const json = (body) => ({ 'content-type': 'application/json' });

async function post(base, path, { token, body } = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { ...json(), ...(token ? bearer(token) : {}) },
    body: body ? JSON.stringify(body) : '{}',
  });
}

// --- who gets in ------------------------------------------------------------

test('no credential is refused', async (t) => {
  const { base } = await boot(t);
  for (const path of ['/api/state', '/api/lamp', '/api/lock', '/api/toggle']) {
    const res = path === '/api/state' ? await fetch(`${base}${path}`) : await post(base, path);
    assert.equal(res.status, 401, `${path} should refuse an anonymous caller`);
  }
});

test('a wrong bearer token is refused', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, '/api/toggle', { token: 'definitely-not-a-real-token' });
  assert.equal(res.status, 401);
});

test('a token that is a prefix of a real one is refused', async (t) => {
  const { base } = await boot(t);
  const res = await post(base, '/api/toggle', { token: TOKENS.kevin.slice(0, -1) });
  assert.equal(res.status, 401);
});

test('an empty bearer is refused', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/api/state`, { headers: { Authorization: 'Bearer ' } });
  assert.equal(res.status, 401);
});

test('a valid bearer token identifies the right person', async (t) => {
  const { base } = await boot(t);

  for (const [id, token] of Object.entries(TOKENS)) {
    const res = await fetch(`${base}/api/state`, { headers: bearer(token) });
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.equal(state.you, id, 'the token must map to its own owner');
  }
});

// --- doing things -----------------------------------------------------------

test('toggle flips your lamp and carries the group with it', async (t) => {
  const { base } = await boot(t);
  const lampOf = (state, id) => state.lamps.find((l) => l.userId === id);

  let state = await (await post(base, '/api/toggle', { token: TOKENS.kevin })).json();
  assert.equal(lampOf(state, 'kevin').on, true);
  assert.equal(lampOf(state, 'sam').on, true, 'Sam follows');

  state = await (await post(base, '/api/toggle', { token: TOKENS.kevin })).json();
  assert.equal(lampOf(state, 'kevin').on, false);
  assert.equal(lampOf(state, 'sam').on, false);
});

test('toggle only ever moves your own lamp', async (t) => {
  const { base } = await boot(t);

  // Sam goes private, so Kevin's toggle must not reach him.
  await post(base, '/api/lock', { token: TOKENS.sam, body: { locked: true } });
  const state = await (await post(base, '/api/toggle', { token: TOKENS.kevin })).json();

  assert.equal(state.lamps.find((l) => l.userId === 'kevin').on, true);
  assert.equal(state.lamps.find((l) => l.userId === 'sam').on, false);
});

test('lock and unlock over bearer auth', async (t) => {
  const { base } = await boot(t);

  let state = await (await post(base, '/api/lock', { token: TOKENS.kevin, body: { locked: true } })).json();
  assert.equal(state.lamps.find((l) => l.userId === 'kevin').locked, true);

  state = await (await post(base, '/api/lock', { token: TOKENS.kevin, body: { locked: false } })).json();
  assert.equal(state.lamps.find((l) => l.userId === 'kevin').locked, false);
});

test('malformed bodies are rejected, not crashed on', async (t) => {
  const { base } = await boot(t);

  const bad = await post(base, '/api/lamp', { token: TOKENS.kevin, body: { on: 'yes' } });
  assert.equal(bad.status, 400);

  const alsoBad = await post(base, '/api/lock', { token: TOKENS.kevin, body: { locked: 1 } });
  assert.equal(alsoBad.status, 400);
});

test('the invite link still works and sets a cookie', async (t) => {
  const { base } = await boot(t);

  const res = await fetch(`${base}/?t=${TOKENS.kevin}`, { redirect: 'manual' });
  assert.equal(res.status, 303);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^lamplink=/);
  assert.match(cookie, /HttpOnly/);

  // And that cookie authenticates subsequent calls.
  const state = await fetch(`${base}/api/state`, {
    headers: { cookie: cookie.split(';')[0] },
  });
  assert.equal(state.status, 200);
  assert.equal((await state.json()).you, 'kevin');
});

test('a bad invite token does not sign anyone in', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/?t=nope-nope-nope-nope-nope-nope`, { redirect: 'manual' });
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
});

test('healthz needs no credential', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).ok, true);
});
