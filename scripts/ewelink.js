#!/usr/bin/env node
/**
 * Signs in to eWeLink and lists every device on the account, with the device
 * ids you paste into config.json.
 *
 *   npm run ewelink
 *
 * Run this before anything else when setting up Sonoff plugs — it turns "the
 * lamp doesn't work" into a specific, fixable error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EwelinkCloud } from '../src/ewelink.js';

const file = process.env.CONFIG_PATH || path.resolve('config.json');
if (!fs.existsSync(file)) {
  console.error(`\nNo config at ${file}. Run \`npm run gen-config\` first.\n`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!config.ewelink) {
  console.error(`
No "ewelink" block in ${file}. It should look like:

  "ewelink": {
    "appId": "...",          from https://dev.ewelink.cc  (Console -> your app)
    "appSecret": "...",
    "account": "you@example.com",
    "password": "...",
    "areaCode": "+1",
    "region": "us"
  }
`);
  process.exit(1);
}

const cloud = new EwelinkCloud(config.ewelink);

try {
  await cloud.login();
  const devices = await cloud.listDevices();

  if (devices.length === 0) {
    console.log('\nSigned in fine, but the account has no devices.');
    console.log('Pair each plug in the eWeLink phone app first, then re-run this.\n');
    process.exit(0);
  }

  console.log(`\nFound ${devices.length} device(s):\n`);
  const width = Math.max(...devices.map((d) => d.name.length), 4);
  console.log(`  ${'NAME'.padEnd(width)}  ${'DEVICE ID'.padEnd(12)}  STATUS`);
  for (const d of devices) {
    const state = d.params?.switch ? `, ${d.params.switch}` : '';
    console.log(
      `  ${d.name.padEnd(width)}  ${d.deviceId.padEnd(12)}  ${d.online ? 'online' : 'OFFLINE'}${state}`,
    );
  }

  // Show exactly what to paste, matched up to the people already in the config.
  console.log('\nPaste these into the matching lamps in config.json:\n');
  for (const [i, user] of (config.users || []).entries()) {
    const guess = devices[i];
    console.log(`  ${user.name}:`);
    console.log(`    "adapter": "sonoff-ewelink",`);
    console.log(`    "options": { "deviceId": "${guess ? guess.deviceId : 'PASTE-ONE-FROM-ABOVE'}" }`);
  }
  console.log(
    '\n(The pairing above is just the listing order — check the names match the right person.)\n',
  );
} catch (err) {
  console.error(`\n${err.message}\n`);
  if (err.code === 403) {
    console.error('Check appId/appSecret. They come from https://dev.ewelink.cc -> Console.');
  } else if (err.code === 401 || err.code === 10001) {
    console.error('Check the account email and password — these are your eWeLink *app* login.');
  } else if (err.code === 10004) {
    console.error('Set "region" to the one eWeLink named above (us, eu, as or cn).');
  }
  console.error('');
  process.exit(1);
} finally {
  await cloud.stop();
}
