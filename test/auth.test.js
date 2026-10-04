import test from 'node:test';
import assert from 'node:assert/strict';
import { makeAuth, parseCookies } from '../src/auth.js';
import { userByToken } from '../src/config.js';

const SECRET = 'a'.repeat(48);

function fakeRes() {
  const headers = {};
  return { headers, setHeader: (k, v) => (headers[k] = v) };
}

test('a signed cookie round-trips', () => {
  const auth = makeAuth(SECRET);
  const res = fakeRes();
  auth.setCookie(res, 'kevin', { secure: true });

  const cookie = res.headers['Set-Cookie'].split(';')[0];
  assert.equal(auth.userFromRequest({ headers: { cookie } }), 'kevin');
});

test('a tampered cookie is rejected', () => {
  const auth = makeAuth(SECRET);
  const res = fakeRes();
  auth.setCookie(res, 'kevin', { secure: true });

  const value = res.headers['Set-Cookie'].split(';')[0].split('=')[1];
  const [userId, expiresAt, mac] = value.split('.');

  const forged = `lamplink=${['sam', expiresAt, mac].join('.')}`;
  assert.equal(auth.userFromRequest({ headers: { cookie: forged } }), null);

  const badMac = `lamplink=${[userId, expiresAt, 'x'.repeat(mac.length)].join('.')}`;
  assert.equal(auth.userFromRequest({ headers: { cookie: badMac } }), null);
});

test('an expired cookie is rejected', async () => {
  const auth = makeAuth(SECRET);
  // A cookie whose expiry is in the past must fail even with a valid MAC, so
  // build it through the same HMAC the module uses.
  const crypto = await import('node:crypto');
  const past = Date.now() - 3600_000;
  const mac = crypto.createHmac('sha256', SECRET).update(`kevin.${past}`).digest('base64url');
  assert.equal(auth.userFromRequest({ headers: { cookie: `lamplink=kevin.${past}.${mac}` } }), null);
});

test('a cookie signed with a different secret is rejected', () => {
  const a = makeAuth(SECRET);
  const b = makeAuth('b'.repeat(48));
  const res = fakeRes();
  a.setCookie(res, 'kevin', { secure: true });
  const cookie = res.headers['Set-Cookie'].split(';')[0];
  assert.equal(b.userFromRequest({ headers: { cookie } }), null);
});

test('a weak secret is refused outright', () => {
  assert.throws(() => makeAuth('short'), /at least 32/);
  assert.throws(() => makeAuth(undefined), /at least 32/);
});

test('secure and httpOnly flags are set in production', () => {
  const auth = makeAuth(SECRET);
  const res = fakeRes();
  auth.setCookie(res, 'kevin', { secure: true });
  const header = res.headers['Set-Cookie'];
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
});

test('cookie parsing survives junk', () => {
  assert.deepEqual(parseCookies(undefined), {});
  assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  assert.deepEqual(parseCookies('novalue; a=1'), { a: '1' });
});

test('token lookup finds the right user and rejects near-misses', () => {
  const config = {
    users: [
      { id: 'kevin', token: 'k'.repeat(24) },
      { id: 'sam', token: 's'.repeat(24) },
    ],
  };
  assert.equal(userByToken(config, 'k'.repeat(24)).id, 'kevin');
  assert.equal(userByToken(config, 's'.repeat(24)).id, 'sam');
  assert.equal(userByToken(config, 'k'.repeat(23)), null);
  assert.equal(userByToken(config, ''), null);
  assert.equal(userByToken(config, undefined), null);
});
