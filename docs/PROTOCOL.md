# WeavrNet protocol (v1)

All messages are JSON text frames shaped `{ "type": "...", ... }`.

## Device ↔ relay: `/agent`

The Weavr app connects out to `ws(s)://<relay>/agent`. A connection has to
finish its handshake within 15 s.

### Handshake

| Direction | Message |
|---|---|
| device → relay | `{type:"hello", protocol:1, deviceId, deviceName, locationName?, shortCode, appearance, platform, appVersion, joinKey?}` |
| relay → device | `{type:"challenge", protocol:1, nonce, known}` |
| device → relay | known: `{type:"auth", proof}` where `proof = base64(HMAC-SHA256(key=secret, msg=nonce))` |
|  | new: `{type:"auth", secret}` (≥ 32 chars, chosen by the device and pinned by the relay) |
| relay → device | `{type:"welcome", protocol:1, deviceId, status:"approved"\|"pending", server:{name, requireApproval, joinKeyRequired}}` |

`deviceId` must match `[A-Za-z0-9_-]{8,64}`. A join key is checked only for
devices the relay doesn't already know.

### After `welcome`

| Direction | Message | Notes |
|---|---|---|
| device → relay | `{type:"state", data: PlaybackState}` | Same JSON WeavrLink broadcasts on the LAN |
| device → relay | `{type:"diagnostics", data: StreamDiagnostics}` | |
| device → relay | `{type:"profile", deviceName, locationName?, shortCode, appearance}` | After a rename, location or appearance change |
| device → relay | `{type:"config", data: Config \| null}` | `null` = remote editing is off; the relay drops what it had |
| device → relay | `{type:"config.result", requestId, ok, error?}` | |
| relay → device | `{type:"approved"}` | A pending device was approved |
| relay → device | `{type:"command", data:{command, positionMs?, seconds?, sourceIndex?, volume?}}` | Same commands as WeavrLink: `play pause seek seekForward seekBack nextSource prevSource switchSource refreshStream setVolume stop` |
| relay → device | `{type:"config.update", requestId, patch: Patch}` | |
| relay → device | `{type:"rejected", reason}` then close | |
| relay → device | `{type:"removed"}` then close 4004 | The device should forget its secret for this relay |

A pending device may send state and config, but the relay doesn't forward
them, or accept commands for it, until an admin approves it.

### Close codes

| Code | Meaning | Device should |
|---|---|---|
| 4000 | Replaced by a newer connection with the same device ID | Not reconnect |
| 4001 | HMAC proof didn't match | Stop; needs admin to remove the device |
| 4002 | Protocol error | Back off |
| 4003 | Blocked | Stop until the user acts |
| 4004 | Removed by admin | Forget its secret and stop until the user acts |
| 4005 | Join key missing or wrong | Stop until the user acts |
| 4008 | Handshake timeout | Back off and retry |

Any other close: reconnect with exponential back-off (1 s doubling to 60 s).

### Config (device → relay)

```jsonc
{
  "allowRemoteEdit": true,
  "deviceName": "Living Room",
  "locationName": "Dad's house",                // free-text nickname, may be ""
  "appearance": { "roomName", "iconKey", "iconColor", "bgType", "bgColor1", "bgColor2" },
  "locked": false,                               // active profile locks settings; edits are refused
  "sources": [{ "id", "type", "name", "enabled",
                "url",                             // display URL with credentials masked
                "editable",                        // false for media servers / aggregators
                "xtreamHost", "xtreamUsername", "hasPassword", "lastRefreshed" }],
  "settings": { "showFavouritesMenu", "discoverEnabled", "tmdbEnabled" },
  "secrets":  { "tmdbApiKey": true, "omdbApiKey": false, ... },   // set or not; never the value
  "stats":    { "channels", "movies", "series" }
}
```

### Patch (relay → device)

Every field is optional:

```jsonc
{
  "deviceName": "Kitchen",
  "locationName": "Beach hut",                   // "" clears it
  "appearance": { "iconKey": "kitchen", "bgType": "solid", "bgColor1": "#FFB340" },
  "settings": { "discoverEnabled": false, "tmdbApiKey": "…" },      // "" clears a key
  "sources": {
    "add":    [{ "type": "xtream", "name", "xtreamHost", "xtreamUsername", "xtreamPassword" }],
    "update": [{ "id", "enabled"?, "name"?, "m3uUrl"?, "xtreamHost"?, "xtreamUsername"?, "xtreamPassword"? }],
    "remove": ["<source id>"]
  },
  "refresh": true
}
```

The device rejects anything outside this list.

## WeavrLink tunnel

Devices that list `"link"` in `hello.features` serve their WeavrLink web
app through the relay. `hello` may also carry `localAddress` (the TV's
LAN `ip:port`).

A signed-in admin asks for a session with `{type:"link.open", deviceId}` on
`/ws` and gets `{type:"link", deviceId, url:"/link/<token>/?code=<connect code>"}`.
Tokens expire after 12 h unused, and when the device is blocked or removed or
the admin password changes. Everything under `/link/<token>/` is forwarded to
the TV:

| Direction | Message |
|---|---|
| relay → device | `{type:"http", id, method, path, headers:{content-type?, x-weavr-code?, accept?}, body: base64\|null, base:"/link/<token>"}` |
| device → relay | `{type:"http.res", id, status, headers:{content-type?, cache-control?, content-disposition?}}` |
| device → relay | `{type:"http.data", id, data: base64}` (≤ 192 KB each, any number) |
| device → relay | `{type:"http.end", id}` |
| relay → device | `{type:"ws.open", sid, path}` (browser opened `/link/<token>/<path>`) |
| both ways | `{type:"ws.msg", sid, data: string}` |
| both ways | `{type:"ws.close", sid}` |

The device replays requests against its own companion server on 127.0.0.1,
and rewrites absolute links in HTML responses to sit under `base`.
Responses go out with `Content-Security-Policy: sandbox …; frame-ancestors 'self'`
and `Access-Control-Allow-Origin: *`. The page runs in an opaque origin, and
the token, not a cookie, authorises its requests. The relay answers CORS
preflights itself.

## Heartbeat

The relay sends a protocol ping and an app-level `{type:"ping"}` to each
device every 30 s. A device is dropped only after 150 s with nothing heard
from it, so a TV busy with a large import doesn't flap offline. The Weavr
client reconnects if it hears nothing from the relay for 150 s.

## Browser ↔ relay: `/ws`

Needs a valid session cookie (`weavrnet_session`, HttpOnly, SameSite=Strict)
and a same-origin `Origin` header.

| Direction | Message |
|---|---|
| relay → ui | `{type:"hello", server, devices:[DeviceSummary]}` |
| relay → ui | `{type:"device", device}` / `{type:"device.removed", deviceId}` / `{type:"server", server}` |
| ui → relay | `{type:"subscribe", deviceId}` / `{type:"unsubscribe"}` |
| relay → ui | `{type:"state"\|"diagnostics"\|"config", deviceId, data}` (subscribed device only) |
| ui → relay | `{type:"command", deviceId, command, ...args}` |
| ui → relay | `{type:"config.update", deviceId, requestId, patch}` → `{type:"config.result", deviceId, requestId, ok, error}` |
| ui → relay | `{type:"link.open", deviceId}` → `{type:"link", deviceId, url}` |
| relay → ui | `{type:"notice", deviceId, data:{text, ok}}` (WeavrLink progress messages) |
| ui → relay | `{type:"device.approve"\|"device.block"\|"device.unblock"\|"device.remove", deviceId}` |
| relay → ui | `{type:"error", deviceId, requestId, error}` |

## HTTP API

| Route | Auth | |
|---|---|---|
| `GET /api/health` | – | Liveness check |
| `GET /api/ping` | – | `{app:"weavrnet", version, protocol, server}`, so clients can check an address |
| `GET /api/status` | – | `{setupRequired, authenticated, server}` |
| `POST /api/setup {password}` | – | First run only |
| `POST /api/login {password}` / `POST /api/logout` | – | Throttled to 10 failures per IP per 15 min |
| `GET /api/devices` | session | |
| `GET /api/settings` / `PUT /api/settings {serverName?, requireApproval?, joinKey?}` | session | |
| `POST /api/password {current, next}` | session | Signs out every other session |
