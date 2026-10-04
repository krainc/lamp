# Deploying Lamplink

Total time: about fifteen minutes. Cost on Fly.io: **~$2.20/month** — a
shared-cpu-1x 256MB machine at $2.02 plus a 1GB volume at $0.15. Fly retired its
permanent free tier in 2024; new accounts get $5 of trial credit, so the first
couple of months are effectively covered, but a card is required up front.

## What this app needs from a host

1. **A process that stays running.** Lamplink holds an open connection — to
   eWeLink's cloud for Sonoff plugs, or from the plugs themselves for Shelly and
   Tasmota. Nothing wakes a sleeping server when a lamp gets switched on; an
   idle lamp is not an HTTP request.
2. **A raw TCP port — only for Shelly/Tasmota plugs.** Those connect *to* our
   MQTT broker, which needs a reachable port.

   **If every lamp is `sonoff-ewelink`, you don't need this.** Lamplink dials
   out to eWeLink over HTTPS and WSS and accepts no inbound device connections
   at all, so any host that can run a persistent process with an HTTPS endpoint
   will do. That widens the options considerably — see the table below.

**Vercel and Netlify cannot host this.** They run serverless functions: each
invocation is short-lived, nothing persists between requests, and there is no
way to hold an MQTT connection or keep a WebSocket server alive. This isn't a
configuration problem — the execution model is wrong for the job. Their static
hosting can't help either, since the sync logic has to live *somewhere* central.
The same goes for Cloudflare Pages Functions, Deno Deploy, and Lambda.

**Render's free tier can't either** — free web services spin down after 15
minutes of inactivity, which drops every plug. Its paid tier works, but it
doesn't expose raw TCP ports, so MQTT needs the WebSocket transport.

Hosts that do work:

| Host | Cost | Sonoff-only | With Shelly/Tasmota |
|---|---|---|---|
| **Your own VM** | you already have it | ✅ Best | ✅ Best — any port you like |
| Fly.io | ~$2.20/mo | ✅ | ✅ Fixed MQTT port 8883 |
| Railway | ~$5/mo | ✅ | ⚠️ Random TCP port, changes on recreate |
| Render | $7/mo | ✅ Paid tier only | ❌ No raw TCP ports |
| Oracle / GCP free tier | $0 | ✅ | ✅ |

**If you already have a VM, use it** — no recurring platform cost, no vendor
quirks, and ports are yours to choose if you ever add Shelly plugs. Jump to
[Option A](#option-a-your-own-vm-ubuntu). Otherwise [Option B](#option-b-flyio)
covers Fly.

If you're running Sonoff lamps only, `fly.toml`'s `[[services]]` block (which
exposes the MQTT port) can be deleted — nothing will connect to it.

---

# Option A: your own VM (Ubuntu)

Everything is in `deploy/`: a Compose file running Lamplink behind
[Caddy](https://caddyserver.com), which obtains and renews the HTTPS
certificate by itself. One script does the whole setup and doubles as the
upgrade path.

## A1. Decide how people will reach it

HTTPS is not optional here — the invite links carry login tokens, and the
session cookie is `Secure`. Two ways to get it:

- **A hostname** (recommended) — any domain, ~$12/year, with an `A` record
  pointing at the VM. Caddy gets a normal 90-day certificate automatically.
  Worth it mainly because bookmarks survive: if the VM's IP ever changes, a
  hostname keeps everyone's saved link working.
- **The bare IP** — works today with no domain at all. Let's Encrypt began
  issuing IP address certificates in 2025, and they went generally available in
  January 2026. The setup script detects an IP address and requests one
  automatically. The only catch is they're 6-day certificates (a Let's Encrypt
  requirement for IPs), so Caddy renews them roughly weekly — fine for an
  always-on server, but it does mean the box must stay up and reachable on port
  80.

Don't use `sslip.io`/`nip.io` for this. They work when they work, but they
share one Let's Encrypt rate limit across everyone using them and it has been
exhausted before — including in February 2026.

## A2. Open the firewall

Ports **80** and **443** need to be reachable from the internet. On most cloud
VMs that means a security-group or firewall rule in the provider's console, not
just `ufw` on the box. Port 80 is required even though the site is HTTPS-only —
that's how the certificate gets issued and renewed.

## A3. Copy the project up

From your laptop, in the repo:

```bash
rsync -av --exclude node_modules --exclude .git --exclude config.json ./ ubuntu@YOUR-VM:~/lamplink/
```

## A4. Put the filled-in config in place

Generate it locally (`npm run gen-config`), fill in the `ewelink` block and the
device ids, then:

```bash
scp config.json ubuntu@YOUR-VM:~/lamplink/deploy/config.json
```

It stays out of git and out of the Docker image; it's bind-mounted read-only at
runtime, so a bug in the app can't rewrite your credentials.

## A5. Run the setup script

```bash
ssh ubuntu@YOUR-VM 'cd ~/lamplink/deploy && ./setup.sh'
```

It installs Docker if missing, asks for the address, generates a
`COOKIE_SECRET`, writes the right Caddy config for a hostname vs an IP, opens
`ufw` if it's active, builds, starts, and waits for the health check. Re-running
it is safe and is how you deploy updates.

## A6. Hand out the links

```bash
npm run links -- https://YOUR-ADDRESS
```

## Running it

```bash
cd ~/lamplink/deploy && docker compose logs -f lamplink
```

| Task | Command (in `~/lamplink/deploy`) |
|---|---|
| Logs | `docker compose logs -f lamplink` |
| Certificate trouble | `docker compose logs -f caddy` |
| Restart | `docker compose restart lamplink` |
| Change the roster | edit `config.json`, then `docker compose restart lamplink` |
| Update the code | `git pull` (or re-`rsync`), then `./setup.sh` |
| Stop | `docker compose down` (volumes, and so state, survive) |

Both containers are `restart: unless-stopped` and Docker is enabled at boot, so
the VM rebooting brings everything back on its own.

## VM troubleshooting

**The site doesn't load and Caddy logs mention ACME.** Port 80 isn't reachable
from the internet. Check the provider's firewall, not just `ufw`:

```bash
curl -sS -o /dev/null -w '%{http_code}\n' http://YOUR-ADDRESS/
```

**Certificate errors on a bare IP.** The 6-day IP certificate needs a recent
Caddy. Force the current image:

```bash
cd ~/lamplink/deploy && docker compose pull caddy && docker compose up -d
```

**`permission denied` talking to Docker.** Add yourself to the group, then open
a new session:

```bash
sudo usermod -aG docker $USER && newgrp docker
```

**Everyone got signed out after a redeploy.** `COOKIE_SECRET` changed.
`deploy/.env` holds it — keep that file, and don't regenerate it casually.

---

# Option B: Fly.io

## 1. Install and log in

```bash
brew install flyctl
```

```bash
fly auth signup
```

## 2. Create the app

From the `lamplink/` directory:

```bash
fly launch --no-deploy --copy-config --name lamplink-YOUR-SUFFIX
```

Pick a suffix your friends will recognise — the name becomes your hostname,
`https://lamplink-YOUR-SUFFIX.fly.dev`. Say **no** to Postgres, Redis, and
anything else it offers.

Then set `app = "lamplink-YOUR-SUFFIX"` at the top of `fly.toml` and pick a
`primary_region` near most of the group (`fly platform regions` lists them).

## 3. Create the volume for saved state

```bash
fly volumes create lamplink_data --size 1 --region sjc --yes
```

Use the same region as `primary_region`. This is what makes lock settings and the
activity feed survive a redeploy.

## 4. Make the config

```bash
npm run gen-config
```

It asks who's in the group, which adapter, and your app URL — then writes
`config.json` and prints one personal link per person plus a `COOKIE_SECRET`.

The URL is only used to print those links; it is never stored. If you skipped it
(or the app moves later), reprint them any time against the real URL:

```bash
npm run links -- https://lamplink-YOUR-SUFFIX.fly.dev
```

If you're starting with real Shelly plugs, edit each lamp's
`options.topicPrefix` to the plug's actual device id first. If you don't have
plugs yet, pick `virtual` and come back later.

## 5. Set the secrets

```bash
fly secrets set COOKIE_SECRET="$(openssl rand -hex 32)" LAMPLINK_CONFIG="$(cat config.json)"
```

Both live only in Fly from here on. `config.json` stays on your laptop, out of
git. Whenever you change the roster, re-run just the `LAMPLINK_CONFIG` half.

## 6. Deploy

```bash
fly deploy
```

```bash
fly logs
```

You should see `lamplink up on :8080 with N lamps`, then one line per lamp.

## 7. Check it

```bash
curl https://lamplink-YOUR-SUFFIX.fly.dev/healthz
```

Then open your own personal link. On a phone, use **Share → Add to Home Screen**
and it behaves like an app.

## 8a. Point the plugs at it — SONOFF (eWeLink)

Nothing to configure on the plugs themselves; they talk to eWeLink, and
Lamplink talks to eWeLink. Just confirm the account is wired up:

```bash
npm run ewelink
```

Every plug should list as `online`. Then check the deployed app sees them:

```bash
fly logs
```

Look for `signed in to eWeLink`, `found N device(s)`, and `websocket ready`.

If a lamp shows `offline` in the UI, the web page now tells you why — a bad
credential, a device id that isn't on the account, or eWeLink being unreachable.

## 8b. Point the plugs at it — Shelly

For each Shelly plug, in its web UI under **Settings → MQTT**:

| Field | Value |
|---|---|
| Enable MQTT | on |
| Server | `lamplink-YOUR-SUFFIX.fly.dev:8883` |
| TLS | on — "verify server certificate" using the built-in CA bundle |
| Client ID | leave as the device default |
| Username | that lamp's `id` from `config.json`, e.g. `kevin-lamp` |
| Password | that lamp's `options.mqttPassword` |
| RPC over MQTT | ✅ enabled |
| RPC status notifications | ✅ enabled |

Save, let the plug reboot, and watch:

```bash
fly logs
```

`device authenticated: kevin-lamp` means you're done. The lamp turns from
`offline` to live in the web UI within a few seconds.

Send each friend their personal link **individually** — a link posted in the
group chat gives everyone control of that person's lamp.

## Making changes later

```bash
fly secrets set LAMPLINK_CONFIG="$(cat config.json)"
```

Setting a secret restarts the app on its own; you only need `fly deploy` again
when you've changed the code.

---

## Troubleshooting — SONOFF / eWeLink

Start here, always — it reports the specific failure:

```bash
npm run ewelink
```

**`error 403`** — the App ID or App Secret is wrong, or the developer app isn't
approved yet. Approval takes 1–2 working days; check your email.

**`error 401` or `10001`** — wrong account email or password. These are the
eWeLink *app* credentials, not your dev.ewelink.cc login — they're often
different accounts.

**`error 10004`** — the account lives in a different region. Lamplink retries
automatically against the right one and logs which; set `region` in
`config.json` to match so it stops happening.

**Signed in, but no devices listed.** The plugs aren't paired to that account.
Each friend needs to sign into the *group* eWeLink account in the phone app and
pair their plug there.

**A device is listed but the lamp shows `not found on the eWeLink account`.**
The `deviceId` in `config.json` has a typo. Copy it from `npm run ewelink`.

**Lamps work, then stop for a minute, then recover.** Normal. eWeLink drops the
server's session when someone opens the phone app on the group account.
Lamplink signs back in on its own; `fly logs` will show
`access token rejected; signing in again`.

**Everything is online but switching is slow.** eWeLink's cloud round trip is
1–2 seconds. That's the hardware's ceiling, not Lamplink's.

## Troubleshooting — Shelly / Tasmota

**A lamp shows `offline` and the logs say nothing.** The plug isn't reaching the
broker. Check the port is `8883`, not `1883`, and that TLS is enabled — Fly only
listens for TLS on 8883. From your laptop:

```bash
nc -zv lamplink-YOUR-SUFFIX.fly.dev 8883
```

**Logs say `rejected connection ... (username="kevin-lamp")`.** Password
mismatch. The plug's MQTT password must equal `options.mqttPassword` exactly.
Retype it in the plug's UI — trailing spaces from copy-paste are the usual
culprit.

**The plug connects, but pressing its button does nothing.** *RPC status
notifications* isn't enabled on the device. Without it the plug never tells us
the relay moved. Turn it on in Settings → MQTT.

**Everything works, then breaks after a quiet hour.** Something re-enabled
machine auto-stop. Confirm both `[http_service]` and `[[services]]` still have
`auto_stop_machines = false`, and:

```bash
fly status
```

should show one machine `started`, not `stopped`.

**Two machines are running and the lamps fight each other.**

```bash
fly scale count 1
```

The sync state is in memory; two copies means two opinions.

**Everyone got signed out.** `COOKIE_SECRET` changed. Set it back, or resend the
personal links.

**A lamp shows `flapping`.** The flap guard tripped — that plug reported more
than 8 changes in 10 seconds and has been benched for a minute so it can't
strobe everyone. If it keeps happening, suspect the plug's Wi-Fi or its relay,
not the software.

## If you'd rather use Railway

With Sonoff plugs this is a perfectly good choice — the MQTT port that made
Railway awkward isn't needed at all.

```bash
npm i -g @railway/cli && railway login
```

```bash
railway init && railway up
```

Then in the Railway dashboard:

- **Variables** → add `COOKIE_SECRET` and `LAMPLINK_CONFIG` (paste the whole
  `config.json` as the value).
- **Settings → Networking** → Generate Domain. That's your app URL; feed it to
  `npm run links -- https://...`.
- **Settings → Volumes** → add one mounted at `/data`, and set
  `STATE_PATH=/data/state.json`. Without it you lose lock settings and the
  activity feed on every deploy.

Only add a TCP Proxy if you later buy Shelly or Tasmota plugs — and note the
external port it assigns is random and changes if the service is recreated,
which means re-entering it on every plug.
