const $ = (id) => document.getElementById(id);

const el = {
  glow: $('glow'),
  conn: $('conn'),
  lampBtn: $('lampBtn'),
  lampState: $('lampState'),
  lampHint: $('lampHint'),
  lockBtn: $('lockBtn'),
  lockIcon: $('lockIcon'),
  lockTitle: $('lockTitle'),
  lockSub: $('lockSub'),
  virtualBtn: $('virtualBtn'),
  friends: $('friends'),
  events: $('events'),
  whoami: $('whoami'),
  signout: $('signout'),
  toast: $('toast'),
};

let state = null;
let busy = false;
let toastTimer = null;

// --- rendering ---------------------------------------------------------------

function render() {
  if (!state) return;
  const me = state.lamps.find((l) => l.userId === state.you);
  const others = state.lamps.filter((l) => l.userId !== state.you);

  el.glow.classList.toggle('lit', Boolean(me?.on));

  if (me) {
    el.lampBtn.setAttribute('aria-pressed', String(me.on));
    el.lampState.textContent = me.on ? 'On' : 'Off';
    el.lampBtn.disabled = busy || !me.online;

    if (!me.online) {
      el.lampHint.textContent = me.error ? me.error : 'Your plug is offline';
    } else if (me.locked) {
      el.lampHint.textContent = me.on ? 'Tap to turn off' : 'Tap to turn on';
    } else {
      el.lampHint.textContent = me.on
        ? 'Tap to turn off — everyone unlocked goes off too'
        : 'Tap to turn on — everyone unlocked comes on too';
    }

    const locked = me.locked;
    el.lockBtn.setAttribute('aria-pressed', String(locked));
    el.lockIcon.textContent = locked ? '🔒' : '🔓';
    el.lockTitle.textContent = locked ? 'Private' : 'Synced';
    el.lockSub.textContent = locked
      ? state.lockBehavior === 'muted'
        ? 'Friends can’t change your lamp, but yours still moves theirs'
        : 'Just a normal lamp — nobody else can touch it'
      : 'Your lamp follows the group, and the group follows yours';

    el.virtualBtn.hidden = me.adapter !== 'virtual';
    el.whoami.textContent = `Signed in as ${me.name}`;
  }

  el.friends.replaceChildren(...others.map(friendRow));
  el.events.replaceChildren(...state.events.map(eventRow));
}

function friendRow(lamp) {
  const li = document.createElement('li');
  li.className = `friend${lamp.on ? ' on' : ''}${lamp.online ? '' : ' offline'}`;

  const pip = document.createElement('span');
  pip.className = 'pip';

  const body = document.createElement('div');
  body.className = 'friend-body';

  const name = document.createElement('div');
  name.className = 'friend-name';
  name.append(document.createTextNode(lamp.name));
  if (lamp.locked) name.append(badge('locked'));
  if (lamp.muted) name.append(badge('flapping', true));
  if (!lamp.online) name.append(badge('offline', true));

  const meta = document.createElement('div');
  meta.className = 'friend-meta';
  meta.textContent = metaLine(lamp);

  body.append(name, meta);
  li.append(pip, body);
  return li;
}

function metaLine(lamp) {
  if (!lamp.online) return lamp.error || 'not reachable';
  const when = lamp.lastChangeAt ? ` · ${ago(lamp.lastChangeAt)}` : '';
  const by = lamp.lastChangeBy === 'sync' ? ' by sync' : '';
  return `${lamp.on ? 'On' : 'Off'}${by}${when}`;
}

function badge(text, warn = false) {
  const span = document.createElement('span');
  span.className = warn ? 'badge warn' : 'badge';
  span.textContent = text;
  return span;
}

const VERBS = {
  on: 'turned on',
  off: 'turned off',
  locked: 'went private',
  unlocked: 'went synced',
  online: 'came online',
  offline: 'went offline',
  'flap-guard': 'was muted for flapping',
};

function eventRow(event) {
  const li = document.createElement('li');
  const who = state.lamps.find((l) => l.userId === event.userId);

  const text = document.createElement('span');
  const strong = document.createElement('span');
  strong.className = 'who';
  strong.textContent = who ? (who.userId === state.you ? 'You' : who.name) : event.lampId;
  text.append(strong, document.createTextNode(` ${VERBS[event.kind] || event.kind}`));
  if (event.detail === 'app' || event.detail === 'local') {
    text.append(document.createTextNode(event.detail === 'local' ? ' (at the plug)' : ''));
  }
  if (event.detail === 'self') text.append(document.createTextNode(' (synced)'));

  const time = document.createElement('time');
  time.dateTime = new Date(event.at).toISOString();
  time.textContent = ago(event.at);

  li.append(text, time);
  return li;
}

function ago(ts) {
  const secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (secs < 10) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

// Keep the relative timestamps honest without re-fetching anything.
setInterval(() => {
  if (state) render();
}, 20_000);

// --- actions -----------------------------------------------------------------

async function post(url, body) {
  busy = true;
  render();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    if (res.status === 401) {
      location.reload();
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
    if (data.lamps) state = data;
    return data;
  } catch (err) {
    toast(err.message);
    return null;
  } finally {
    busy = false;
    render();
  }
}

el.lampBtn.addEventListener('click', () => {
  const me = state?.lamps.find((l) => l.userId === state.you);
  if (!me || busy) return;
  post('/api/lamp', { on: !me.on });
});

el.lockBtn.addEventListener('click', () => {
  const me = state?.lamps.find((l) => l.userId === state.you);
  if (!me || busy) return;
  post('/api/lock', { locked: !me.locked });
});

el.virtualBtn.addEventListener('click', () => post('/api/virtual-button'));

el.signout.addEventListener('click', async () => {
  await post('/api/signout');
  location.href = '/';
});

function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4200);
}

// --- live connection ---------------------------------------------------------

let ws = null;
let backoff = 1000;

function setConn(status, label) {
  el.conn.className = `conn ${status}`;
  el.conn.querySelector('.label').textContent = label;
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/ws`);

  ws.onopen = () => {
    backoff = 1000;
    setConn('live', 'live');
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'state') {
        state = msg.state;
        render();
      }
    } catch {
      /* ignore malformed frames */
    }
  };

  ws.onclose = () => {
    setConn('down', 'reconnecting');
    setTimeout(connect, backoff);
    backoff = Math.min(backoff * 1.8, 20_000);
  };

  ws.onerror = () => ws.close();
}

// Phones aggressively kill sockets when the screen locks. Re-check on wake.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!ws || ws.readyState === WebSocket.CLOSED) connect();
  fetch('/api/state')
    .then((r) => (r.ok ? r.json() : null))
    .then((s) => {
      if (s) {
        state = s;
        render();
      }
    })
    .catch(() => {});
});

fetch('/api/state')
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error('unauthorised'))))
  .then((s) => {
    state = s;
    render();
    connect();
  })
  .catch(() => location.reload());
