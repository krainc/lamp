import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('config');

const DEFAULTS = {
  // "private": a locked lamp neither receives nor sends. It is just a normal lamp.
  // "muted":   a locked lamp ignores everyone else, but its own changes still push
  //            out to unlocked friends.
  lockBehavior: 'private',

  // When someone unlocks, should their lamp immediately jump to the group's
  // current state? false = nothing happens until the next actual change.
  adoptGroupStateOnUnlock: false,

  // A plug with a failing relay (or a bad Wi-Fi link) can flap on/off rapidly.
  // Without this, four homes get strobe-lighted. If a lamp reports more than
  // `maxChanges` changes inside `windowMs`, we stop trusting its broadcasts for
  // `cooldownMs`. It still works locally; it just stops driving everyone else.
  flapGuard: { maxChanges: 8, windowMs: 10_000, cooldownMs: 60_000 },

  users: [],
};

export function loadConfig() {
  const raw = readRaw();
  const config = { ...DEFAULTS, ...raw, flapGuard: { ...DEFAULTS.flapGuard, ...(raw.flapGuard || {}) } };
  validate(config);
  return config;
}

function readRaw() {
  if (process.env.LAMPLINK_CONFIG) {
    log.info('loading config from LAMPLINK_CONFIG env var');
    return JSON.parse(process.env.LAMPLINK_CONFIG);
  }
  const file = process.env.CONFIG_PATH || path.resolve('config.json');
  if (!fs.existsSync(file)) {
    throw new Error(
      `No config found. Set LAMPLINK_CONFIG, or create ${file} ` +
        `(run \`npm run gen-config\` to generate one).`,
    );
  }
  log.info(`loading config from ${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function validate(config) {
  if (!['private', 'muted'].includes(config.lockBehavior)) {
    throw new Error(`lockBehavior must be "private" or "muted", got ${config.lockBehavior}`);
  }
  if (!Array.isArray(config.users) || config.users.length === 0) {
    throw new Error('config.users must be a non-empty array');
  }

  const userIds = new Set();
  const lampIds = new Set();
  const tokens = new Set();

  for (const user of config.users) {
    if (!user.id || !/^[a-z0-9-]+$/.test(user.id)) {
      throw new Error(`user.id must be lowercase alphanumeric/dashes, got ${JSON.stringify(user.id)}`);
    }
    if (userIds.has(user.id)) throw new Error(`duplicate user id: ${user.id}`);
    userIds.add(user.id);

    if (!user.name) throw new Error(`user ${user.id} is missing a name`);
    if (!user.token || user.token.length < 20) {
      throw new Error(`user ${user.id} needs a token of at least 20 chars`);
    }
    if (tokens.has(user.token)) throw new Error(`duplicate token on user ${user.id}`);
    tokens.add(user.token);

    const lamp = user.lamp;
    if (!lamp || !lamp.id) throw new Error(`user ${user.id} is missing lamp.id`);
    if (lampIds.has(lamp.id)) throw new Error(`duplicate lamp id: ${lamp.id}`);
    lampIds.add(lamp.id);

    if (!lamp.adapter) throw new Error(`lamp ${lamp.id} is missing an adapter name`);
    lamp.options = lamp.options || {};
    lamp.userId = user.id;
  }

  validateEwelink(config);
}

/**
 * Catch a malformed eWeLink block at boot rather than as a confusing HTTP 403
 * three layers down.
 */
function validateEwelink(config) {
  const usesEwelink = config.users.some((u) => u.lamp.adapter === 'sonoff-ewelink');
  if (!usesEwelink) return;

  if (!config.ewelink) {
    throw new Error('a lamp uses the sonoff-ewelink adapter, so config.ewelink is required');
  }

  for (const key of ['appId', 'appSecret', 'account', 'password']) {
    if (!config.ewelink[key]) throw new Error(`config.ewelink.${key} is required`);
  }

  const region = config.ewelink.region || 'us';
  if (!['us', 'eu', 'as', 'cn'].includes(region)) {
    throw new Error(`config.ewelink.region must be us, eu, as or cn (got "${region}")`);
  }
  config.ewelink.region = region;

  const seen = new Set();
  for (const user of config.users) {
    if (user.lamp.adapter !== 'sonoff-ewelink') continue;
    const id = user.lamp.options.deviceId;
    if (!id) {
      throw new Error(`lamp ${user.lamp.id} needs options.deviceId — run \`npm run ewelink\` to list them`);
    }
    if (/CHANGE-ME|REPLACE/i.test(id)) {
      throw new Error(
        `lamp ${user.lamp.id} still has the placeholder deviceId — run \`npm run ewelink\` ` +
          'to list your plugs, then paste the real ids into config.json',
      );
    }
    if (seen.has(id)) {
      throw new Error(`two lamps both point at eWeLink device ${id}; each needs its own plug`);
    }
    seen.add(id);
  }
}

export function lampsOf(config) {
  return config.users.map((u) => u.lamp);
}

export function userByToken(config, token) {
  if (!token) return null;
  // Length-independent scan; tokens are high-entropy randoms so a plain compare
  // is fine here, but keep it constant-time per candidate anyway.
  for (const user of config.users) {
    if (timingSafeEqualStr(user.token, token)) return user;
  }
  return null;
}

function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
