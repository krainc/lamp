#!/usr/bin/env node
/**
 * The make-or-break test for this whole project.
 *
 *   npm run ewelink:watch
 *
 * Signs in, opens the realtime WebSocket, and prints every event eWeLink sends.
 * Then you walk over and press the physical button on the plug.
 *
 * Why this matters more than anything else here: the entire design assumes that
 * pressing the button on one plug produces a cloud event we can react to. If the
 * S40 doesn't surface button presses — only app-originated changes — then lamps
 * can only be driven from the app, and the "turn your lamp on and everyone
 * else's comes on" behaviour cannot work with this hardware. Find that out now,
 * inside the return window, not after building a phone app.
 *
 * Pass --toggle <deviceId> to also send a command and watch the echo come back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { EwelinkCloud } from '../src/ewelink.js';

const args = process.argv.slice(2);
const toggleIndex = args.indexOf('--toggle');
const toggleId = toggleIndex >= 0 ? args[toggleIndex + 1] : null;

const file = process.env.CONFIG_PATH || path.resolve('config.json');
if (!fs.existsSync(file)) {
  console.error(`\nNo config at ${file}. Run \`npm run gen-config\` first.\n`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!config.ewelink) {
  console.error('\nNo "ewelink" block in config.json. See README.md.\n');
  process.exit(1);
}

const cloud = new EwelinkCloud(config.ewelink);
const started = Date.now();
let events = 0;
let sawSwitchChange = false;

const stamp = () => `+${((Date.now() - started) / 1000).toFixed(1)}s`.padStart(8);

cloud.on('device', (event) => {
  events++;
  const device = cloud.known(event.deviceId);
  const name = device?.name || event.deviceId;

  if (event.on === undefined) {
    console.log(`${stamp()}  ${name}  reachability: ${event.online ? 'online' : 'OFFLINE'}`);
    return;
  }

  sawSwitchChange = true;
  console.log(
    `${stamp()}  ${name}  switch -> ${event.on ? 'ON ' : 'OFF'}   (deviceId ${event.deviceId})`,
  );
});

cloud.on('ready', () => {
  console.log(`${stamp()}  websocket ready\n`);
  console.log('─'.repeat(64));
  console.log('  Now go press the physical button on the plug.');
  console.log('  A line should appear here within a second or two.');
  console.log('');
  console.log('  Also worth trying: toggle it from the eWeLink phone app, and');
  console.log('  pull the plug out of the wall and push it back in.');
  console.log('─'.repeat(64));
  console.log('');

  if (toggleId) {
    setTimeout(async () => {
      const device = cloud.known(toggleId);
      const next = device?.params?.switch !== 'on';
      console.log(`${stamp()}  sending Switch -> ${next ? 'ON' : 'OFF'} to ${toggleId}\n`);
      try {
        await cloud.setSwitch(toggleId, next);
      } catch (err) {
        console.error(`${stamp()}  command failed: ${err.message}`);
      }
    }, 1500);
  }
});

try {
  console.log('\nConnecting to eWeLink...\n');
  await cloud.start();

  const devices = [...cloud.devices.values()];
  console.log(`Devices on this account (${devices.length}):`);
  for (const d of devices) {
    console.log(
      `  ${d.name}  —  ${d.deviceId}  —  ${d.online ? 'online' : 'OFFLINE'}` +
        `${d.params?.switch ? `, currently ${d.params.switch}` : ''}`,
    );
  }
  console.log('');
} catch (err) {
  console.error(`\nCould not connect: ${err.message}\n`);
  console.error('Run `npm run ewelink` first — it explains credential problems in detail.\n');
  process.exit(1);
}

function verdict() {
  console.log('\n');
  console.log('─'.repeat(64));
  if (sawSwitchChange) {
    console.log('  PASS — switch changes arrive over the websocket.');
    console.log('  If at least one of those came from the physical button, the');
    console.log('  whole design works on this hardware. Carry on.');
  } else if (events > 0) {
    console.log('  INCONCLUSIVE — events arrived, but no switch state changes.');
    console.log('  Try again and make sure you actually toggle the relay.');
  } else {
    console.log('  NO EVENTS — nothing arrived at all.');
    console.log('  Check the plug is online above. If it is online and pressing');
    console.log('  the button still produces nothing here, this hardware cannot');
    console.log('  do what the project needs — return it while you still can.');
  }
  console.log('─'.repeat(64));
  console.log('');
}

process.on('SIGINT', async () => {
  verdict();
  await cloud.stop();
  process.exit(sawSwitchChange ? 0 : 1);
});

console.log('(watching — press Ctrl-C when done)\n');
