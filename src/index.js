import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, lampsOf } from './config.js';
import { Store } from './state.js';
import { Hub } from './hub.js';
import { Broker } from './broker.js';
import { EwelinkCloud } from './ewelink.js';
import { createAdapter, EWELINK_ADAPTERS } from './adapters/index.js';
import { makeAuth } from './auth.js';
import { createServer } from './server.js';
import { logger } from './log.js';

const log = logger('boot');
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const HTTP_PORT = Number(process.env.PORT || 8080);
const MQTT_PORT = Number(process.env.MQTT_PORT || 1883);

async function main() {
  const config = loadConfig();
  const lamps = lampsOf(config);

  const store = new Store({
    filePath: process.env.STATE_PATH || path.resolve('data/state.json'),
    lampIds: lamps.map((l) => l.id),
  });

  const hub = new Hub({ config, store });
  const broker = new Broker();
  const adapters = new Map();

  // Sonoff plugs all share one sign-in and one WebSocket to eWeLink's cloud,
  // so it is built once here and handed to every adapter that needs it.
  let ewelink = null;
  if (lamps.some((l) => EWELINK_ADAPTERS.has(l.adapter))) {
    if (!config.ewelink) {
      throw new Error('a lamp uses the sonoff-ewelink adapter but config.ewelink is missing');
    }
    ewelink = new EwelinkCloud(config.ewelink);
    try {
      await ewelink.start();
    } catch (err) {
      // Keep serving: the UI should load and say what's wrong rather than the
      // whole app refusing to boot because eWeLink is having a bad morning.
      log.error(`could not reach eWeLink: ${err.message}`);
    }
  }

  // One misconfigured or unreachable lamp must never stop the others from
  // working. A friend who typo'd their plug's password should see their own
  // lamp marked broken in the UI, while everyone else's keeps syncing.
  let mqttLamps = 0;

  for (const lamp of lamps) {
    try {
      const adapter = createAdapter({
        lamp,
        ctx: { broker, ewelink, log: logger('lamp') },
        report: (report) => hub.report(lamp.id, report),
      });
      adapters.set(lamp.id, adapter);
      hub.attachAdapter(lamp.id, adapter);

      // Adapters that speak MQTT hand us the credentials their device will
      // use, so config.json is the only place a plug's password lives.
      const creds = adapter.mqttCredentials?.();
      if (creds) {
        broker.addDevice(creds.username, creds);
        mqttLamps++;
      }

      await adapter.start();
    } catch (err) {
      log.error(`lamp ${lamp.id} is not usable: ${err.message}`);
      hub.report(lamp.id, { online: false, error: err.message });
    }
  }

  if (adapters.size === 0) {
    throw new Error('no lamp could be started — check the adapter options in your config');
  }

  const auth = makeAuth(process.env.COOKIE_SECRET);
  const { server, close: closeHttp } = createServer({ config, hub, auth, adapters, publicDir });

  const needsBroker = mqttLamps > 0;
  if (needsBroker) {
    await broker.listen(MQTT_PORT);
  } else {
    log.info('no MQTT lamps configured; broker not started');
  }

  await new Promise((resolve) => server.listen(HTTP_PORT, resolve));
  log.info(`lamplink up on :${HTTP_PORT} with ${lamps.length} lamps`);
  for (const user of config.users) {
    log.info(`  ${user.name} -> ${user.lamp.id} (${user.lamp.adapter})`);
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`${signal} received, shutting down`);
    store.flush();
    await closeHttp().catch(() => {});
    for (const adapter of adapters.values()) await adapter.stop().catch(() => {});
    if (ewelink) await ewelink.stop().catch(() => {});
    if (needsBroker) await broker.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  log.error(err.message);
  if (process.env.LOG_LEVEL === 'debug') console.error(err);
  process.exit(1);
});
