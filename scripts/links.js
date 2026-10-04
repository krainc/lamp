#!/usr/bin/env node
/**
 * Reprints everyone's personal invite link against a given base URL.
 *
 * The URL is not stored in config.json — only the tokens are — so this can be
 * re-run any time the app moves, without touching anyone's credentials.
 *
 *   npm run links -- https://lamplink-oak-street.fly.dev
 */
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error('Usage: npm run links -- https://your-app-url\n');
  process.exit(1);
}
if (!/^https?:\/\//.test(base)) {
  console.error(`"${base}" needs to start with https://\n`);
  process.exit(1);
}
if (base.startsWith('http://') && !base.includes('localhost') && !base.includes('127.0.0.1')) {
  console.error('Refusing to print links over plain http — the token would travel in the clear.\n');
  process.exit(1);
}

const file = process.env.CONFIG_PATH || path.resolve('config.json');
if (!fs.existsSync(file)) {
  console.error(`No config at ${file}. Run \`npm run gen-config\` first.\n`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const width = Math.max(...config.users.map((u) => u.name.length));

console.log('\nSend each person exactly one of these, privately — the link is the credential:\n');
for (const user of config.users) {
  console.log(`  ${user.name.padEnd(width)}  ${base}/?t=${user.token}`);
}
console.log('\nOn a phone: open the link, then Share -> Add to Home Screen.\n');
