# WeavrNet

**WeavrLink, but over the internet.** WeavrNet is a small self-hosted relay
(one Docker container) that lets you control your Weavr TVs from anywhere: on
a phone, tablet or desktop browser, with the same now-playing card, controls,
source switching and diagnostics as the WeavrLink companion page on your LAN.
An admin can also edit a device's room name, look, sources and settings
remotely.

```
 Phone / desktop browser            Your server                 Living-room TV
┌──────────────────────┐   wss   ┌───────────────┐   wss    ┌──────────────────┐
│ WeavrNet web app     │ ──────► │   WeavrNet    │ ◄─────── │ Weavr            │
│ (sign in as admin)   │  /ws    │   (Docker)    │  /agent  │ (dials out, so no│
└──────────────────────┘         └───────────────┘          │ port forwarding) │
                                                            └──────────────────┘
```

The TV always dials **out** to WeavrNet, so the TV's network needs no port
forwarding. Only the WeavrNet server has to be reachable from the internet.

## Quick start (Docker)

The image is published to GitHub Container Registry for amd64 and arm64:
`ghcr.io/bishop-actual/weavrnet:latest`. Save
[`docker-compose.yml`](docker-compose.yml) on your server and run:

```bash
docker compose up -d
```

To update later: `docker compose pull && docker compose up -d`.

Open `http://<server>:7780` and choose an admin password. That's it.

Then on each TV: **Weavr → Settings → WeavrLink**, open the **WeavrNet — remote
access** drop-down, enter your server's address (e.g. `weavrnet.example.com` or
`203.0.113.5:7780`) and press **Save & Turn On**. The **Remote access** switch
stays greyed out until an address is saved, and turns on when you save one.
Optionally tap the ✎ pencil to give the TV a **location nickname** such as
“Dad's house”. The device appears in the web app as soon as its handshake
completes.

## Putting it on the internet (HTTPS)

Run WeavrNet behind a reverse proxy that terminates TLS, and set
`TRUST_PROXY=true` so it sees real client IPs and marks cookies `Secure`.
Example with [Caddy](https://caddyserver.com):

```caddyfile
weavrnet.example.com {
    reverse_proxy weavrnet:7780
}
```

Caddy proxies WebSockets automatically. With nginx, forward the `Upgrade` and
`Connection` headers for `/agent` and `/ws`.

In Weavr, a bare domain such as `weavrnet.example.com` connects over TLS
(`wss://`). An IP or `host:port` (other than 443) connects without TLS
(`ws://`). You can also type a full URL (`https://…`, `http://…`), including a
sub-path if WeavrNet is served under one.

You can also serve TLS directly by setting `TLS_CERT` and `TLS_KEY` to PEM
file paths mounted into the container.

> Plain `ws://` over the open internet sends playback state and admin cookies
> unencrypted. Use HTTPS for anything beyond your own LAN or VPN.

## Configuration

All configuration is optional. Settings marked *UI* can also be changed in the
web app under ⚙ **Server settings**. When an environment variable is set, it
wins and the UI field is locked.

| Variable | Default | |
|---|---|---|
| `PORT` | `7780` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `DATA_DIR` | `/data` | Where `weavrnet.json` is stored (the `weavrnet-data` volume). Back this up. |
| `TRUST_PROXY` | `false` | Trust `X-Forwarded-For/Proto/Host` from a reverse proxy |
| `TLS_CERT`, `TLS_KEY` | – | Serve HTTPS directly |
| `WEAVRNET_NAME` | `WeavrNet` | *UI.* Server name shown in the app and on TVs |
| `WEAVRNET_ADMIN_PASSWORD` | – | Admin password. If unset, you choose one on first visit. Setting it also **resets a forgotten password** on the next restart. |
| `WEAVRNET_REQUIRE_APPROVAL` | `false` | *UI.* New devices wait under “Waiting for approval” until an admin approves them |
| `WEAVRNET_JOIN_KEY` | – | *UI.* New devices must enter this key in Weavr to register. Devices that already registered aren't affected. |
| `WEAVRNET_SESSION_DAYS` | `30` | How long a browser stays signed in |

### Who can add a device?

By default a device is added as a client as soon as its handshake completes,
so anyone who knows your server address could add a TV. They can't see or
control *your* devices (that needs the admin password), but they would show
up in your list. On a public server, turn on **Require approval**, set a
**Join key**, or both.

## Using the web app

* **Phones:** a device list (like WeavrLink's discovery screen). Tap a device
  to open its dashboard. Add it to your home screen for an app-like,
  full-screen experience.
* **Desktop:** the device list stays on the left and the dashboard on the right.
* **Locations:** devices with a location nickname are grouped under it
  (📍 Dad's house, 📍 Beach hut…), with an online count per location. The
  nickname can be edited on the TV or with the ✎ pencil in the Settings tab.

Each device dashboard has:

| Tab | What it does |
|---|---|
| **Sources** | Lists the stream's sources and switches between them, like WeavrLink |
| **Diagnostics** | Buffer health, bitrate, resolution, codec, reconnects, failover history, stream URL |
| **Remote** | Stop, refresh, ±30 s, volume |
| **Settings** | Remote editing: location nickname, room name, icon and background; add, edit, enable or remove M3U and Xtream sources; general toggles; metadata API keys |
| **Device** | Status, platform and version, plus Approve, Block, Unblock and Remove |

### WeavrLink, from anywhere

On TVs running a Weavr build with WeavrNet's WeavrLink support, opening a
device shows **that TV's own WeavrLink**, carried over the WeavrNet
connection. That includes every screen and the full Settings: all source
types, Request server, Home Lists, Sport Hub, Backup & transfer, General,
Media and the rest. Adding a source behaves exactly as on the LAN: the TV
shows its loading dialog and WeavrNet shows the progress and result.

The ⓘ button in the header has the WeavrNet side: location nickname, device
details, and approve / block / remove. Older Weavr builds get the basic
remote described above.

WeavrLink pages are served from private, expiring `/link/<token>/` URLs in a
sandbox (an opaque origin), so whatever a TV sends can't read your WeavrNet
login or call the admin API. **If you put Authelia (or any login proxy) in
front of WeavrNet, exclude `/agent` and `/link/` from it.** TVs can't log in
to it, and the sandboxed WeavrLink page doesn't carry its cookie.

### Privacy controls on the TV

In Weavr's WeavrNet card:

* **Main switch (default on):** turn it off and the TV disconnects from the
  relay immediately. The address is kept, so turning it back on reconnects.
* **Allow remote settings changes (default on):** when off, the relay only gets
  playback state and can only send playback commands. The TV withdraws its
  sources and settings from the relay, and edits are refused.
* **Secrets stay on the TV.** Xtream passwords and API keys are never sent to
  WeavrNet. The admin sees only whether each one is set, and can overwrite it.

### Removing and blocking

* **Remove:** WeavrNet forgets the device. The TV shows “Removed by the WeavrNet
  admin” and stops reconnecting until someone on the TV taps **Reconnect** or
  toggles WeavrNet off and on. It then registers as a new device.
* **Block:** the device is disconnected and refused from then on, until it is
  unblocked.

## Troubleshooting

The web page tells you what's wrong instead of guessing:

| Message | Meaning |
|---|---|
| *WeavrNet didn't answer — your proxy replied instead (HTTP 404/502/504)…* | Traefik (or Authelia, Cloudflare…) answered, not WeavrNet. Usually the container is restarting, which takes a few seconds. The page keeps retrying by itself. If it never clears, check the container is running (`docker ps`) and that your proxy sends this hostname to it. |
| *Two WeavrNet servers are answering at this address* | Two containers share the same Traefik labels (often an old one left running after a change), so sign-ins and devices are split between them. Remove the extra one: `docker ps -a \| grep -i weavrnet`. |
| *Your proxy redirected this request instead of passing it to WeavrNet* | A login middleware (e.g. Authelia) sits in front of WeavrNet's API. Remove it from WeavrNet's router, or at least exclude `/api`, `/ws`, `/agent` and `/link`. |
| *An older WeavrNet container answered this request* | Two WeavrNet containers share this address; remove the old one. |
| *Incorrect password* | WeavrNet itself rejected it. Use **Forgot password?** on the sign-in page: it writes a one-time code to the container log (`docker logs --tail 5 weavrnet`), and you enter it with a new password. If the message mentions `WEAVRNET_ADMIN_PASSWORD`, that compose value decides the password on every start — check it (write any `$` as `$$`) or remove it. |

The image has no Docker `HEALTHCHECK` on purpose. Traefik won't route to a
container until its health check passes, which made WeavrNet unreachable
for up to a minute after every update. If you want one anyway, use
`GET /api/health`.

## How the handshake works

1. The TV opens a WebSocket to `/agent` and sends `hello` with its stable
   device ID, room name and appearance (plus the join key, if one is set).
2. WeavrNet answers with a random `challenge` nonce and says whether it already
   knows this device.
3. **New device:** the TV replies with a random secret. WeavrNet pins that
   secret and registers the device (approved, or pending if approval is
   required). **Known device:** the TV replies with `HMAC-SHA256(secret, nonce)`,
   so the secret never crosses the wire again.
4. WeavrNet replies `welcome`, and from then on relays state and commands.

Each relay address gets its own secret on the TV, so one server can never
impersonate a device to another. The full message reference is in
[docs/PROTOCOL.md](docs/PROTOCOL.md).

## Development

The relay's tests run in CI (`npm test` inside the repo). Day-to-day use only
needs Docker.

## License

MIT
