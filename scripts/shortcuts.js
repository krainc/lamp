#!/usr/bin/env node
/**
 * Prints the per-person values needed to set up a phone button — an iOS
 * Shortcut or an Android HTTP Shortcut.
 *
 *   npm run shortcuts -- https://lamps.example.com
 *
 * Each person gets different values because the token *is* their identity.
 * Send each block to its owner privately; anyone holding it can drive that
 * person's lamp.
 *
 * Setup steps are in SHORTCUTS.md.
 */
import fs from 'node:fs';
import path from 'node:path';

const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error('\nUsage: npm run shortcuts -- https://your-app-url\n');
  process.exit(1);
}
if (!/^https:\/\//.test(base)) {
  if (/^http:\/\/(localhost|127\.0\.0\.1)/.test(base)) {
    console.error('\nNote: a localhost URL only works on the machine running the server.\n');
  } else {
    console.error('\nRefusing to print these over plain http — the token would travel in the clear.\n');
    process.exit(1);
  }
}

const file = process.env.CONFIG_PATH || path.resolve('config.json');
if (!fs.existsSync(file)) {
  console.error(`\nNo config at ${file}. Run \`npm run gen-config\` first.\n`);
  process.exit(1);
}

const config = JSON.parse(fs.readFileSync(file, 'utf8'));

console.log(`
Phone button setup — one block per person. Send each privately.
Step-by-step instructions are in SHORTCUTS.md.
`);

for (const user of config.users) {
  const auth = `Bearer ${user.token}`;
  console.log('─'.repeat(68));
  console.log(`  ${user.name}`);
  console.log('─'.repeat(68));
  console.log('');
  console.log('  iOS — Shortcuts app, "Get Contents of URL" action:');
  console.log('');
  console.log(`    URL     ${base}/api/toggle`);
  console.log('    Method  POST');
  console.log('    Headers Authorization');
  console.log(`            ${auth}`);
  console.log('');
  console.log('  Android — HTTP Shortcuts, "Import from cURL":');
  console.log('');
  console.log(`    curl -X POST '${base}/api/toggle' -H 'Authorization: ${auth}'`);
  console.log('');
  console.log('  Status button (shows everyone\'s lamps in a notification):');
  console.log('');
  console.log(`    GET ${base}/api/summary`);
  console.log(`    with the same Authorization header`);
  console.log('');
}

console.log('─'.repeat(68));
console.log(`
Other endpoints, same Authorization header:

  POST ${base}/api/toggle          flip your lamp
  POST ${base}/api/lamp            body {"on": true} / {"on": false}
  POST ${base}/api/lock            body {"locked": true} = private
  GET  ${base}/api/summary         one-line status, plain text
  GET  ${base}/api/state           full state, JSON
`);
