# Lamplink

Shared lamps for friends in separate homes. When your lamp is **synced**, turning
it on turns on everyone else's; when it's **private**, it's just a lamp.

With SONOFF plugs (the S40), which reach the server through eWeLink's cloud:

```
   Kevin's home          eWeLink cloud           Sam's home
  ┌───────────┐       ┌──────────────┐        ┌───────────┐
  │ lamp      │       │              │        │      lamp │
  │  └ plug ──┼──────►│              │◄───────┼── plug ┘  │
  └───────────┘       └──────┬───────┘        └───────────┘
                             │ wss (outbound)
                    ┌────────┴─────────┐
                    │  Lamplink        │      ┌───────────┐
                    │  ├ sync engine   │◄─────┤ phones    │
                    │  └ web app       │HTTPS └───────────┘
                    └──────────────────┘
```

With Shelly or Tasmota plugs, they connect straight to Lamplink's own MQTT
broker instead, cutting the vendor out entirely.

Either way the plugs dial *out*, so nobody port-forwards anything, and the
phones are just a web page — no app store.

## Try it right now, with no hardware

```bash
npm install
npm run gen-config          # answer the prompts; pick the "virtual" adapter
export COOKIE_SECRET=$(openssl rand -hex 32)
export INSECURE_COOKIES=1
npm start
```

`gen-config` prints one personal link per person. Open two of them in two
different browser profiles (or one normal window and one private window) and
watch them drive each other. "Simulate a press on the plug" stands in for the
physical button.

The URL `gen-config` asks for is only used to print those links — it is never
stored. Reprint them any time, against any URL:

```bash
npm run links -- https://your-app.fly.dev
```

## How the sync actually behaves

Every unlocked lamp shares one piece of truth: `groupState`. A change only
propagates when it *disagrees* with that truth.

| What happens | What the group does |
|---|---|
| You tap your lamp on (synced) | Every synced, online, currently-off lamp turns on |
| You tap it off (synced) | Every synced, online, currently-on lamp turns off |
| You press the button on your plug | Same as tapping — the plug reports it and it fans out |
| You're **private**, you tap your lamp | Nothing else moves. It's a normal lamp. |
| Someone else changes theirs, you're **private** | Your lamp doesn't move |
| You go from private → synced | Nothing moves yet; you rejoin on the next change |
| Your plug loses Wi-Fi | It's skipped, and rejoins on the next change after it returns |
| Your plug reboots | Its restored state is recorded but never fans out |

That last row matters more than it looks. Without it, a plug rebooting at 3am
announces "I'm off" and turns off four bedrooms.

### Two knobs worth knowing about

In `config.json`:

- **`lockBehavior`** — `"private"` (default) means a locked lamp neither sends
  nor receives; it is completely disconnected from the group. `"muted"` means it
  ignores everyone else but its own changes still push out. Pick `"private"` if
  "locked" means *leave me alone*; pick `"muted"` if it means *don't touch my
  lamp, but I still want to wave at people*.
- **`adoptGroupStateOnUnlock`** — `false` (default) means unlocking changes
  nothing until the next event. `true` means your lamp immediately jumps to
  whatever the group is doing. `false` avoids a lamp snapping on the moment you
  unlock, which is startling at night.

### Why it can't loop forever

The obvious failure mode: A turns on → B follows → B's plug reports "I'm on" →
that looks like a change → A gets told to turn on → forever.

Three independent things stop it, so no single bug reopens the hole:

1. **`groupState` comparison.** A change is only fanned out when it disagrees
   with the group's current state. After a fan-out, every report agrees with it,
   so nothing propagates. This alone is sufficient.
2. **Source tagging.** Shelly tells us *why* the relay moved (`"button"`,
   `"MQTT"`, `"init"`). Echoes of our own commands arrive tagged and are dropped
   before they reach the fan-out logic at all.
3. **Idempotence.** A lamp already in the target state is never commanded, so a
   redundant report can't produce a command.

`test/hub.test.js` has a test for each, plus the reboot case, the flapping-plug
case, and every combination of lock behaviour.

### The flap guard

A plug with a dying relay or a bad Wi-Fi link can toggle repeatedly. Four homes
getting strobe-lighted at 2am is a genuinely bad outcome, so a lamp that reports
more than 8 changes in 10 seconds stops driving the group for a minute. It keeps
working for its owner, and the UI marks it `flapping`.

## Hardware

The adapter layer is in `src/adapters/`. Pick one per lamp with
`lamp.adapter` — mixing brands within one group is fine.

| Adapter | Status | Transport | Notes |
|---|---|---|---|
| `sonoff-ewelink` | ✅ works | eWeLink cloud | **For the SONOFF S40.** See below. |
| `shelly-mqtt` | ✅ works | our own MQTT | Cleanest option if you ever buy more plugs. No vendor cloud. |
| `tasmota-mqtt` | ✅ works | our own MQTT | For cheap plugs you're willing to reflash. |
| `virtual` | ✅ works | none | Software lamp. Test and demo with this. |
| `kasa` | 📄 stub | — | TP-Link. Read the file first. |
| `tuya` | 📄 stub | — | Smart Life plugs. |

Note that the smart plug becomes the switch: leave the lamp's own switch
permanently on. (We deliberately did *not* use power monitoring to detect the
lamp's own switch — it needs per-lamp calibration, misfires, and can't turn a
lamp on whose own switch is off.)

### SONOFF S40 — what to know

The S40 works, but it is a cloud-only device, and that is not a choice we made:

- **It cannot be reflashed.** The S40 runs a **BL602** chip (not the ESP8266/
  ESP32 in most Sonoff gear), and neither Tasmota nor ESPHome supports BL602.
  It's listed as unsupported by Tasmota. There is no firmware path.
- **Its LAN/DIY mode doesn't help.** Sonoff's local REST API only answers to
  clients on the same Wi-Fi. Your server is not on your friend's Wi-Fi, so it
  can't reach the plug that way — only a box in each home could.

That leaves eWeLink's cloud as the only route into a plug sitting in someone
else's house. What this costs you:

- **A dependency.** If eWeLink's servers are down, lamps stop syncing. They
  still work as normal lamps.
- **Latency.** Roughly 1–2 seconds, versus near-instant for a local MQTT plug.
- **Setup.** A free developer app at [dev.ewelink.cc](https://dev.ewelink.cc),
  which takes 1–2 working days to be approved.

What it buys you, which is not nothing: the plugs reach the server from any home
network with zero configuration, and **the server needs no inbound ports at
all** — it dials out to eWeLink. That makes hosting simpler than the MQTT path.

### Setting up the S40s

1. **Register a developer app.** At [dev.ewelink.cc](https://dev.ewelink.cc),
   sign up as an Individual Developer. Approval arrives by email in 1–2 working
   days. Then Console → Create → note the **App ID** and **App Secret**. The
   free tier allows 50,000 requests/month, which is far more than four lamps
   will ever use (the realtime connection is a WebSocket, not polled requests).

2. **Make one eWeLink account for the group.** A fresh account used only for
   these lamps — not anybody's personal one. Everyone will share its password,
   so don't reuse one.

3. **Each friend pairs their own plug.** They install the eWeLink app, sign in
   to the group account, and pair their S40 onto their own Wi-Fi. Rename each
   plug to the person's name while you're in there.

4. **Find the device ids:**

   ```bash
   npm run ewelink
   ```

   This signs in, lists every plug with its device id and current state, and
   prints the exact JSON to paste into `config.json`. Run it first whenever
   something isn't working — it turns a dead lamp into a specific error.

5. **Fill in `config.json`:**

   ```jsonc
   {
     "ewelink": {
       "appId": "...",        // from dev.ewelink.cc
       "appSecret": "...",
       "account": "lamps@example.com",
       "password": "...",
       "areaCode": "+1",
       "region": "us"         // us, eu, as or cn
     },
     "users": [
       {
         "id": "kevin", "name": "Kevin", "token": "...",
         "lamp": {
           "id": "kevin-lamp",
           "adapter": "sonoff-ewelink",
           "options": { "deviceId": "10021f9a2b" }
         }
       }
     ]
   }
   ```

One wrinkle worth knowing: eWeLink invalidates the server's session whenever
someone signs into the group account on a phone. Lamplink handles this — it
notices the rejected token and signs in again automatically — so opening the app
causes a blip, not an outage.

### Adding a Shelly plug

1. Plug it in, join its `shelly...` Wi-Fi hotspot, give it the home Wi-Fi.
2. In its web UI, note the device id (e.g. `shellyplugusg4-a0b1c2d3e4f5`).
3. **Settings → MQTT:**
   - Server: `your-app.fly.dev:8883`
   - Enable TLS, verify with the built-in CA
   - Username: the lamp id from `config.json` (e.g. `kevin-lamp`)
   - Password: that lamp's `options.mqttPassword`
   - ✅ Enable *RPC over MQTT* and *RPC status notifications*
4. Put the device id in `options.topicPrefix`, redeploy, and the lamp shows up
   online within seconds.

Each plug gets its own username, password, and topic scope, so one friend's
compromised plug cannot command anyone else's lamp.

### Adding new hardware

Implement `LampAdapter` (see `src/adapters/base.js`) and register it in
`src/adapters/index.js`. The contract is small: call `report()` when the device
says something, implement `set(on)`. Read the comments about the `source` field
before you start — getting it wrong is how you end up with a plug reboot
toggling everybody's house.

## Deploying

See [DEPLOY.md](DEPLOY.md).

On your own Ubuntu VM — the simplest option if you have one — everything is in
`deploy/`: Lamplink behind Caddy, which handles HTTPS automatically, even for a
bare IP address.

```bash
rsync -av --exclude node_modules --exclude .git --exclude config.json ./ ubuntu@YOUR-VM:~/lamplink/
```

```bash
scp config.json ubuntu@YOUR-VM:~/lamplink/deploy/config.json
```

```bash
ssh ubuntu@YOUR-VM 'cd ~/lamplink/deploy && ./setup.sh'
```

Re-running `setup.sh` is also how you deploy updates.

Note that **Vercel, Netlify, and other serverless platforms cannot run this** —
Lamplink holds a connection open continuously, and serverless functions don't
stay alive between requests. DEPLOY.md lists what does work and why.

## Configuration reference

```jsonc
{
  "lockBehavior": "private",          // or "muted"
  "adoptGroupStateOnUnlock": false,
  "flapGuard": { "maxChanges": 8, "windowMs": 10000, "cooldownMs": 60000 },
  "users": [
    {
      "id": "kevin",                  // lowercase, a-z0-9-
      "name": "Kevin",                // shown in the UI
      "token": "24+ random chars",    // their login link is /?t=<token>
      "lamp": {
        "id": "kevin-lamp",           // also the plug's MQTT username
        "adapter": "shelly-mqtt",
        "options": { /* per-adapter, see the adapter file */ }
      }
    }
  ]
}
```

## API

Everything except `GET /?t=…` needs the session cookie.

| Route | Does |
|---|---|
| `GET /?t=TOKEN` | Exchange an invite token for a cookie, then redirect |
| `GET /api/state` | Full snapshot from your point of view |
| `POST /api/lamp` `{on}` | Set your own lamp |
| `POST /api/lock` `{locked}` | Go private or synced |
| `POST /api/virtual-button` | Simulate a plug button press (virtual lamps only) |
| `POST /api/signout` | Clear the cookie |
| `WS /ws` | Pushes `{type:"state", state}` on every change |
| `GET /healthz` | Liveness |

## Security notes, honestly stated

- **The invite link is the whole credential.** Anyone holding it can drive that
  person's lamp. Send them one to one, not to a group chat. To revoke someone,
  change their `token` and redeploy.
- `config.json` holds every secret. It's gitignored; keep it that way. In
  production it lives in `LAMPLINK_CONFIG` as a Fly secret.
- Plug passwords cross the internet inside TLS. If you uncomment the plaintext
  1883 listener in `fly.toml`, they don't.
- Worst case if the server is compromised: someone toggles your lamps. There's
  no camera, no mic, no payment method, and no route from here onto your home
  network — the plugs connect outward and accept nothing inbound.

## Tests

```bash
npm test
```

41 tests, no hardware required, about two seconds:

- `test/hub.test.js` — the sync semantics: fan-out, both lock modes, unlock
  rejoin, loop prevention, plug reboots, offline plugs, the flap guard, and
  what the browsers actually receive.
- `test/shelly-integration.test.js` — two pretend Shelly plugs connecting to
  the real embedded broker over real MQTT sockets. A button press on one is
  asserted to produce exactly one `Switch.Set` RPC on the other. Set
  `MQTT_TRACE=1` to see the connection lifecycle.
- `test/broker.test.js` — topic-filter matching, credentials, and the ACL that
  keeps one friend's plug away from another's topics.
- `test/auth.test.js` — cookie signing, tampering, expiry, token lookup.

## Known limits

- **One machine only.** The sync state lives in memory (persisted to disk).
  Two machines would each keep their own copy and fight. `fly scale count 1`.
- **Don't let the machine sleep.** Fly's auto-stop is off in `fly.toml` for a
  reason: a sleeping machine drops every MQTT connection and no HTTP request
  arrives to wake it.
- **No history beyond the last 40 events.** By design; this isn't a data
  product.
