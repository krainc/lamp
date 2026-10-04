# Phone buttons without an app

A real lamp button on your phone — Control Center, Lock Screen, home screen, or
the Action Button — using only the Shortcuts app on iOS and a free app on
Android. No App Store, no developer account, no $99/year.

Get everyone's values first:

```bash
npm run shortcuts -- https://your-app-url
```

That prints one block per person. **Send each block only to its owner.** The
token in it is that person's credential; anyone holding it can drive their lamp.

---

## iOS

Needs iOS 17 or later. Control Center placement needs iOS 18.

### The toggle button

1. Open **Shortcuts** → **+** (new shortcut).
2. Add action → search **Get Contents of URL**.
3. Paste your URL: `https://your-app-url/api/toggle`
4. Tap **Show More** on that action:
   - **Method** → `POST`
   - **Headers** → **+** → Key `Authorization`, Value `Bearer your-token-here`
5. Tap the shortcut's name at the top → rename it to **Lamp**, pick an icon and
   colour.
6. Done.

### Put it where you'll actually use it

- **Control Center** — swipe down from the top-right → **+** (top left) → **Add
  a Control** → scroll to **Shortcuts** → **Shortcut** → choose **Lamp**.
- **Lock Screen** — long-press the Lock Screen → **Customise** → tap one of the
  two bottom controls → **Shortcuts** → **Lamp**.
- **Action Button** (iPhone 15 Pro and later) — Settings → **Action Button** →
  scroll to **Shortcut** → choose **Lamp**.
- **Home Screen** — in Shortcuts, long-press the shortcut → **Share** → **Add to
  Home Screen**.
- **Siri** — just say the shortcut's name. Naming it "Lamp" means "Hey Siri,
  Lamp".

### A status button

Same recipe, but:

- URL `https://your-app-url/api/summary`, method **GET**, same `Authorization`
  header.
- Then add a second action: **Show Notification**, and set its content to the
  **Contents of URL** variable.

Running it pops up something like `You ON · Sam off · Rio ON (private)`.

### A private-mode button

Same recipe with:

- URL `https://your-app-url/api/lock`, method **POST**, same header
- **Request Body** → **JSON** → add field `locked`, type **Boolean**, value
  `true` (make a second shortcut with `false` to rejoin, or use the web app)

### Sharing the setup with friends

Don't share the finished shortcut — it contains your token. Send each person
their own block from `npm run shortcuts` and point them at this page. Setup is
about two minutes.

---

## Android

Install **HTTP Shortcuts** (free and open source, on Play Store and F-Droid).

1. **+** → **Import from cURL**.
2. Paste the curl line from your block:

   ```
   curl -X POST 'https://your-app-url/api/toggle' -H 'Authorization: Bearer your-token-here'
   ```

3. Name it **Lamp**, pick an icon.
4. Long-press your home screen → **Widgets** → **HTTP Shortcuts** → drag the
   widget out → choose **Lamp**.

For the status button, import the `GET .../api/summary` line instead and set
the response handling to **Show in a toast** (or a dialog).

Tasker works too if you already use it — same request, same header.

---

## Why no state on the button

A Shortcut or HTTP Shortcut is a button, not a toggle: it fires a request and
can't display whether the lamp is currently on. That's the one real thing a
native app would add, via WidgetKit on iOS and Glance on Android — both of which
have to be written natively per platform, whatever framework the app itself
uses.

The status shortcut above covers most of the gap. If it starts to grate, that's
the signal it's worth building the app.

---

## Troubleshooting

**401 Unauthorized.** The `Authorization` header is wrong. It must be the word
`Bearer`, one space, then the token — no quotes, no trailing space. Re-run
`npm run shortcuts` and copy it again.

**It works on Wi-Fi but not on cellular.** The server isn't reachable from the
public internet. Check the host's firewall allows 443.

**Nothing happens and there's no error.** Shortcuts swallows failures by
default. Add a **Show Notification** action after the request with the
**Contents of URL** variable to see what came back.

**The certificate is rejected.** If you're on a bare IP with a 6-day Let's
Encrypt certificate, confirm it renewed: `docker compose logs caddy | tail`.
