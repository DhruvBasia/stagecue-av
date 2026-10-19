# StageCue relay

A small WebSocket relay that gives the StageCue crew remote a **permanent internet address**. Crew phones can then reach the AV laptop from any Wi-Fi or mobile data, and QR codes printed for the crew keep working from show to show.

```
AV laptop ──wss──▶  relay  ◀──wss── crew phones (any network / 4G / 5G)
```

Both sides connect **out** to the relay, so it works even when the laptop runs on mobile data behind carrier NAT. The relay is a plain pipe:

- **It decides nothing.** Every phone's link token is forwarded to the laptop, and the laptop accepts or refuses it.
- **Rooms are protected.** The first laptop to connect claims a room with its secret. Another laptop with a different secret is refused (HTTP 403).
- **Phones stay informed.** If the laptop disconnects, phones are told "AV laptop offline" (close code 1013), and the crew page retries by itself.

You don't need this if you use the built-in **Cloudflare tunnel** option. That option needs no server, but its address changes every time StageCue starts.

## Run it

Requires Node 18+.

```bash
cd relay
npm install
npm start
```

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | Listening port; most hosts set this for you. |
| `RELAY_HOST_KEY` | *(empty)* | **Recommended.** Laptops must send this key to open a room, which stops strangers from using your relay. Put the same key in StageCue → Settings → Connection → *Host key*. |

Health check: `GET /healthz` → `ok`.

## Deploy (pick one)

The relay **must be served over HTTPS** (`wss://`). Phone browsers and mobile networks are far more reliable with TLS, and all the hosts below provide it automatically.

- **Render**: New → Web Service → point it at this `relay` folder (or upload it). Build command `npm install`, start command `npm start`. Add `RELAY_HOST_KEY` under Environment.
- **Railway / Fly.io**: deploy the folder; the included `Dockerfile` works as-is (`fly launch` detects it). Set `RELAY_HOST_KEY` as a secret.
- **Any VPS**: `docker build -t stagecue-relay . && docker run -d -p 8080:8080 -e RELAY_HOST_KEY=… stagecue-relay`. Put it behind Caddy or nginx for HTTPS. Caddy, for example: `relay.example.com { reverse_proxy localhost:8080 }`.

Free tiers that sleep when idle are fine. Open the relay URL once before the show to wake it.

## Use it in StageCue

1. Go to Settings → Crew remote → **Connection** → *Internet* → **My relay server**.
2. Paste the relay URL (e.g. `https://stagecue-relay.onrender.com`), plus the host key if you set one.
3. Wait for the chip to show **ONLINE**. The *any network* QR codes now point to `https://your-relay/r/<room>/?t=…`.

The room id and secret are generated once per laptop and kept, so the links stay the same until you press *Regenerate links*.

## Limits

Each relay allows 200 rooms, 60 phones per room and 64 KB per message, with a 15-second heartbeat. Crew pages are supplied by the laptop when it connects; the relay itself serves only a small "laptop offline" page.
