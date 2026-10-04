import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { userByToken } from './config.js';
import { logger } from './log.js';

const log = logger('http');

export function createServer({ config, hub, auth, adapters, publicDir }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);

  app.use(express.json({ limit: '8kb' }));

  const secureCookies = process.env.NODE_ENV === 'production' && process.env.INSECURE_COOKIES !== '1';

  // --- login -----------------------------------------------------------------
  // The invite link is /?t=TOKEN. Swap it for a cookie and immediately redirect
  // so the token stops being in the URL bar, browser history, and referrers.
  app.get('/', (req, res, next) => {
    const token = req.query.t;
    if (!token) return next();

    const user = userByToken(config, String(token));
    if (!user) {
      log.warn('login attempt with an unknown token');
      return res.status(401).sendFile(path.join(publicDir, 'login.html'));
    }
    auth.setCookie(res, user.id, { secure: secureCookies });
    log.info(`${user.id} signed in`);
    return res.redirect(303, '/');
  });

  app.post('/api/signout', (req, res) => {
    auth.clearCookie(res);
    res.json({ ok: true });
  });

  // --- everything below needs a session -------------------------------------
  //
  // Two ways to authenticate, deliberately:
  //   - the signed cookie, for the web page
  //   - `Authorization: Bearer <token>`, using the same personal token as the
  //     invite link, for anything that isn't a browser — an iOS Shortcut, an
  //     Android widget, a native app, curl.
  //
  // One credential per person either way, so revoking someone means changing
  // one token in config.json.
  function requireUser(req, res, next) {
    const bearer = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const user = bearer
      ? userByToken(config, bearer[1].trim())
      : config.users.find((u) => u.id === auth.userFromRequest(req));

    if (!user) {
      return res.status(401).json({ error: 'not signed in' });
    }
    req.user = user;
    next();
  }

  app.get('/api/state', requireUser, (req, res) => {
    res.json(hub.snapshot(req.user.id));
  });

  app.post('/api/lamp', requireUser, async (req, res) => {
    const { on } = req.body || {};
    if (typeof on !== 'boolean') return res.status(400).json({ error: 'body must be {on: boolean}' });
    try {
      await hub.setOwnLamp(req.user.id, on);
      res.json(hub.snapshot(req.user.id));
    } catch (err) {
      log.error(`setOwnLamp failed for ${req.user.id}`, { error: err.message });
      res.status(502).json({ error: err.message });
    }
  });

  // Flip your own lamp without having to know its current state first. A
  // home-screen or Control Center button is one action, not a read then a
  // write, so this is the endpoint those should call.
  app.post('/api/toggle', requireUser, async (req, res) => {
    const lamp = hub.lampForUser(req.user.id);
    const current = hub.snapshot(req.user.id).lamps.find((l) => l.lampId === lamp.id);
    try {
      await hub.setOwnLamp(req.user.id, !current.on);
      res.json(hub.snapshot(req.user.id));
    } catch (err) {
      log.error(`toggle failed for ${req.user.id}`, { error: err.message });
      res.status(502).json({ error: err.message });
    }
  });

  app.post('/api/lock', requireUser, async (req, res) => {
    const { locked } = req.body || {};
    if (typeof locked !== 'boolean') return res.status(400).json({ error: 'body must be {locked: boolean}' });
    try {
      await hub.setLocked(req.user.id, locked);
      res.json(hub.snapshot(req.user.id));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Simulates pressing the physical button on your own plug. Only works for
  // `virtual` lamps, so it's safe to leave enabled — handy for showing friends
  // how the sync feels before the hardware arrives.
  app.post('/api/virtual-button', requireUser, (req, res) => {
    const adapter = adapters.get(req.user.lamp.id);
    if (!adapter?.pressButton) {
      return res.status(400).json({ error: 'your lamp is real hardware — press its actual button' });
    }
    adapter.pressButton();
    res.json({ ok: true });
  });

  // A one-line, human-readable status, for clients that can fetch text but
  // can't render a UI — an iOS Shortcut showing a notification, say. This is
  // what gets you "is anyone else's lamp on?" at a glance without an app.
  app.get('/api/summary', requireUser, (req, res) => {
    const state = hub.snapshot(req.user.id);
    const parts = state.lamps.map((lamp) => {
      const who = lamp.userId === req.user.id ? 'You' : lamp.name;
      if (!lamp.online) return `${who} offline`;
      return `${who} ${lamp.on ? 'ON' : 'off'}${lamp.locked ? ' (private)' : ''}`;
    });
    res.type('text/plain').send(parts.join(' · '));
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, lamps: config.users.length }));

  // --- static ----------------------------------------------------------------
  app.use(
    express.static(publicDir, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  app.get('/', (req, res) => {
    const userId = auth.userFromRequest(req);
    const file = config.users.some((u) => u.id === userId) ? 'index.html' : 'login.html';
    res.sendFile(path.join(publicDir, file));
  });

  app.use((req, res) => res.status(404).json({ error: 'not found' }));

  // --- live updates ----------------------------------------------------------
  const server = http.createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url, 'http://x').pathname !== '/ws') return socket.destroy();

    const userId = auth.userFromRequest(req);
    if (!config.users.some((u) => u.id === userId)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      return socket.destroy();
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = userId;
      ws.send(JSON.stringify({ type: 'state', state: hub.snapshot(userId) }));
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => log.debug(`ws error: ${err.message}`));
  });

  // Drop sockets that have silently died (phone went to sleep, NAT timeout) so
  // the client's reconnect logic gets a chance to run.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);
  heartbeat.unref();

  hub.on('change', () => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(JSON.stringify({ type: 'state', state: hub.snapshot(ws.userId) }));
    }
  });

  return {
    server,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
