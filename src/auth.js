import crypto from 'node:crypto';

const COOKIE = 'lamplink';
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Auth is deliberately tiny: each friend gets one long random token, embedded
 * in a bookmarkable link. Visiting it exchanges the token for a signed cookie.
 *
 * No passwords, no accounts, no reset flow — for four friends and a lamp that
 * is the right amount of machinery. The token *is* the credential, so treat the
 * invite link like a house key: anyone holding it can drive that person's lamp.
 */
export function makeAuth(secret) {
  if (!secret || secret.length < 32) {
    throw new Error('COOKIE_SECRET must be set to at least 32 random characters');
  }

  function sign(userId, expiresAt) {
    const body = `${userId}.${expiresAt}`;
    const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  function verify(value) {
    if (typeof value !== 'string') return null;
    const parts = value.split('.');
    if (parts.length !== 3) return null;
    const [userId, expiresAt, mac] = parts;
    const expected = crypto.createHmac('sha256', secret).update(`${userId}.${expiresAt}`).digest('base64url');
    const a = Buffer.from(mac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    if (Number(expiresAt) < Date.now()) return null;
    return userId;
  }

  return {
    cookieName: COOKIE,

    setCookie(res, userId, { secure }) {
      const expiresAt = Date.now() + MAX_AGE_MS;
      const attrs = [
        `${COOKIE}=${sign(userId, expiresAt)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(MAX_AGE_MS / 1000)}`,
      ];
      if (secure) attrs.push('Secure');
      res.setHeader('Set-Cookie', attrs.join('; '));
    },

    clearCookie(res) {
      res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
    },

    /** @returns {string|null} userId */
    userFromRequest(req) {
      return verify(parseCookies(req.headers.cookie)[COOKIE]);
    },
  };
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}
