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

Run WeavrNet behind a reverse proxy that terminates TLS. WeavrNet notices
when requests come through a proxy on a private network (such as Traefik or
Caddy on the same Docker host) and reads the real client address and HTTPS
status from its `X-Forwarded-*` headers (and `CF-Connecting-IP` behind
Cloudflare). Example with [Caddy](https://caddyserver.com):

```caddyfile
weavrnet.example.com {
    reverse_proxy weavrnet:7780
}
```

Caddy and Traefik proxy WebSockets automatically. With nginx, forward the
`Upgrade` and `Connection` headers for `/agent`, `/ws` and `/link/`.

### Traefik + Authelia

TVs can't sign in to Authelia, and WeavrLink pages run in a sandbox that
doesn't carry Authelia's cookie. So `/agent` and `/link/` must **not** go
through the Authelia middleware. They're protected by the device handshake
and by private, expiring `/link/<token>/` URLs handed out only to signed-in admins. Use two routers:

```yaml
labels:
  - traefik.enable=true
  - traefik.http.services.weavrnet.loadbalancer.server.port=7780
  # Web app, behind Authelia
  - traefik.http.routers.weavrnet.rule=Host(`weavrnet.example.com`)
  - traefik.http.routers.weavrnet.middlewares=authelia@docker
  # TVs, WeavrLink tunnel and public probes, without Authelia
  - traefik.http.routers.weavrnet-open.rule=Host(`weavrnet.example.com`) && (Path(`/agent`) || PathPrefix(`/link/`) || Path(`/api/ping`) || Path(`/api/health`))
  - traefik.http.routers.weavrnet-open.priority=100
```

(Add your usual `entrypoints` / `tls.certresolver` labels to both routers.)

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
| `TRUST_PROXY` | auto | Trust `X-Forwarded-*` headers. Unset: only from private addresses (a proxy on your network). `true` / `false` to force. |
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

### WeavrLink, from anywhere

Opening a device shows **that TV's own WeavrLink**, carried over the
WeavrNet connection. Every WeavrLink screen works: Live TV, Media, Library,
the remote, search, the guide and the full **Settings**. That covers adding and
editing every kind of source, Request server, Home Lists, Sport Hub, Backup &
transfer, General, Media and the rest.

Adding a source from here behaves exactly as on the LAN. The TV shows its
loading dialog, and WeavrNet shows the "Adding source…" progress and the
result ("… added — 1,204 movies, 87 series").

The ⓘ button in the header has the WeavrNet side: the location nickname,
device details (the address it connects from and its home-network address),
and Approve, Block, Unblock or Remove.

WeavrLink pages are served from `/link/<token>/` in a sandbox (an opaque
origin). Whatever a TV sends can't read your WeavrNet login or call the
admin API.

TVs on an older Weavr build get a basic remote (now playing, controls,
sources, diagnostics, a few settings) and a prompt to update.

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
