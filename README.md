# velixir-xray-node

Run [Xray-core](https://github.com/XTLS/Xray-core) (VLESS + WebSocket, no TLS
in xray itself) on Velixir's free tier. TLS is terminated by the Velixir edge,
so the client connects with `wss://` to `https://<app>.velixir.run`.

Zero dependencies: the Xray binary is downloaded from the official GitHub
release at build time (`postinstall`) and again at startup if it is missing
(the container disk is scratch space, so a runtime download happens on every
cold start). Extraction uses only Node.js built-ins (`https` + `zlib`): the
Velixir container has no `unzip` binary and no `python3`.

## Environment variables (set in the Velixir dashboard, Environment tab)

| Key | Required | Default | Notes |
| --- | --- | --- | --- |
| `UUID` | yes (or one is generated and printed in the logs) | — | VLESS client UUID. Set it as a **secret**. |
| `WS_PATH` | no | `/xray-ws` | WebSocket path, must match the client. |
| `PORT` | no | set by Velixir (8080) | The port the app must listen on. |
| `XRAY_PORT` | no | `10000` | Internal port between Node and xray (localhost only). |

## Deploy

1. Paste this repo URL at <https://velixir.net/new> (or `velixir deploy` from
   this folder with the CLI).
2. Pick the Free plan. The app address will be `https://<slug>.velixir.run`.
3. On the Environment tab set `UUID` (secret) and `WS_PATH` if you want a
   custom path, then redeploy.
4. On Scaling → Runtime, turn on the HTTP health probe (default path
   `/health`): the pod only gets traffic once xray answers, so a broken
   release fails its deploy instead of going live.

## Liveness check

A plain HTTP GET on the WS path returns **400** when xray is alive:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://<app>.velixir.run/xray-ws
# 400 = xray up; anything else = not ready / wrong path
```

`/health` returns 200 only once xray is listening.

## Client subscription

```
vless://<UUID>@<app>.velixir.run:443?encryption=none&security=tls&type=ws&host=<app>.velixir.run&path=%2Fxray-ws#Velixir
```

(Replace `<UUID>`, `<app>` and the `path=` value if you changed `WS_PATH`;
the path must be URL-encoded, e.g. `/xray-ws` → `%2Fxray-ws`.)

## Known limits

- Velixir free apps sleep after 15 minutes without a request; the first
  request after a nap waits for a cold start. A keepalive ping every ~10
  minutes keeps it awake.
- Servers are EU-only; there is no Singapore/Japan region.
- Outbound is capped at 10 Mbit/s; xray's own outbound is the app's
  outbound, so proxied traffic shares that cap.
- Xray-core version pinned in `fetch-xray.js`: `v26.10.21`.
