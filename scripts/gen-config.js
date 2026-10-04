#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';

const OUT = path.resolve('config.json');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const secret = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

/**
 * Read one line, returning '' at end of input.
 *
 * `rl.question` never settles once stdin hits EOF, which leaves the script
 * hanging on an unhelpful "unsettled top-level await" warning when input is
 * piped rather than typed. The async line iterator reports EOF properly and
 * still drains everything already buffered.
 */
const lines = rl[Symbol.asyncIterator]();

async function ask(prompt) {
  process.stdout.write(prompt);
  const { value, done } = await lines.next();
  if (done) {
    process.stdout.write('\n');
    return '';
  }
  return value.trim();
}

const names = [];
console.log('\nWho is in the group? Enter one name per line, blank line when done.\n');
for (;;) {
  const answer = await ask(`  name ${names.length + 1}: `);
  if (!answer) break;
  names.push(answer);
}

if (names.length === 0) {
  console.error('\nNo names given, nothing to do.');
  rl.close();
  process.exit(1);
}

const adapter =
  (
    await ask(
      '\nAdapter for every lamp?\n' +
        '  virtual         software lamps, no hardware needed (start here)\n' +
        '  sonoff-ewelink  SONOFF plugs (S40, S31, S60) via eWeLink\n' +
        '  shelly-mqtt     Shelly plugs\n' +
        '  tasmota-mqtt    plugs flashed with Tasmota\n' +
        '\n  [virtual]: ',
    )
  ) || 'virtual';

const url = await ask('\nPublic URL of the app (e.g. https://lamplink.fly.dev): ');
rl.close();

const config = {
  lockBehavior: 'private',
  adoptGroupStateOnUnlock: false,
  users: names.map((name) => {
    const id = slug(name);
    const lamp = { id: `${id}-lamp`, adapter, options: {} };

    if (adapter === 'shelly-mqtt') {
      lamp.options = { topicPrefix: `CHANGE-ME-shelly-device-id-for-${id}`, switchId: 0, mqttPassword: secret(18) };
    } else if (adapter === 'tasmota-mqtt') {
      lamp.options = { topic: `lamp-${id}`, relay: 1, mqttPassword: secret(18) };
    } else if (adapter === 'sonoff-ewelink') {
      lamp.options = { deviceId: `CHANGE-ME-run-npm-run-ewelink` };
    }

    return { id, name, token: secret(24), lamp };
  }),
};

if (adapter === 'sonoff-ewelink') {
  config.ewelink = {
    appId: 'CHANGE-ME-from-dev.ewelink.cc',
    appSecret: 'CHANGE-ME-from-dev.ewelink.cc',
    account: 'CHANGE-ME-the-group-ewelink-email',
    password: 'CHANGE-ME-the-group-ewelink-password',
    areaCode: '+1',
    region: 'us',
  };
}

if (fs.existsSync(OUT)) {
  console.error(`\n${OUT} already exists — refusing to overwrite it.`);
  process.exit(1);
}
fs.writeFileSync(OUT, `${JSON.stringify(config, null, 2)}\n`);

const cookieSecret = crypto.randomBytes(32).toString('hex');
console.log(`\nWrote ${OUT}\n`);
console.log('Add this to your environment (and to `fly secrets set` when you deploy):\n');
console.log(`  COOKIE_SECRET=${cookieSecret}\n`);
console.log('Personal links — send each person exactly one of these, privately:\n');
for (const user of config.users) {
  console.log(`  ${user.name.padEnd(14)} ${url || 'https://YOUR-APP-URL'}/?t=${user.token}`);
}
if (adapter === 'shelly-mqtt') {
  console.log('\nNext: set each lamp\'s options.topicPrefix to its real Shelly device id.');
  console.log('Find it in the plug\'s web UI under Settings -> MQTT, or on the device label.');
} else if (adapter === 'sonoff-ewelink') {
  console.log('\nNext, in this order:');
  console.log('  1. Fill in the "ewelink" block — appId/appSecret from https://dev.ewelink.cc,');
  console.log('     and the email + password of the eWeLink account the plugs are paired to.');
  console.log('  2. Make sure every plug is paired to that account in the eWeLink phone app.');
  console.log('  3. Run `npm run ewelink` to list the device ids, and paste them into');
  console.log('     each lamp\'s options.deviceId.');
}
console.log('\nconfig.json holds every credential. Do not commit it.\n');

function slug(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
