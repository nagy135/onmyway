# On My Way

A small, mobile-friendly live map for meeting your people. Start a meeting with your name, share its link, and see everyone’s latest position. Tap a person to open walking directions in Google Maps or Apple Maps.

## Run locally

Use Node.js 24 or newer:

```sh
npm ci
npm run dev
```

Open **http://localhost:5174**. Vite proxies `/api` to the Node server on port 3001. The SQLite database is created automatically at `data/onmyway.sqlite`. Port 5174 avoids the common default Vite port; override it with `WEB_PORT=5175 npm run dev` if needed.

Your browser asks for location access when you enter a meeting. For a second participant, open the invite in another browser, a private window, or on another device. Tabs in the same browser share the same participant identity for a meeting.

## Docker Compose

```sh
docker compose up -d --build --wait
```

Open **http://localhost:3001**. One container serves both the compiled frontend and API. SQLite lives in the persistent `meeting-data` Docker volume; it does not need a separate database container. The app runs as an unprivileged user and includes a health check and restart policy.

```sh
docker compose logs -f app
docker compose down
```

Stopping or rebuilding preserves the volume. `docker compose down -v` deletes meeting data.

## Configuration

Copy `.env.example` to `.env` if needed. Docker Compose and the Node server read `.env`. Environment variables override the file.

| Variable | Default | Purpose |
| --- | --- | --- |
| `APP_PORT` | `3001` | Docker host port |
| `APP_BIND` | `127.0.0.1` | Docker bind address; put a reverse proxy in front for public access |
| `PORT` | `3001` | API port for a direct Node run |
| `DATABASE_PATH` | `./data/onmyway.sqlite` | SQLite path for a direct Node run; Compose sets `/app/data/onmyway.sqlite` |
| `PUBLIC_URL` | unset | Exact public origin, such as `https://omw.infiniter.tech`; validates request origins and enables secure cookies |
| `TRUST_PROXY` | `0` | Set to `1` when exactly one trusted reverse proxy fronts the app |
| `MAP_TILE_URL` | OpenStreetMap standard raster tiles | XYZ tile URL with `{z}`, `{x}`, and `{y}` placeholders |
| `MAP_ATTRIBUTION` | OpenStreetMap attribution | Required attribution HTML for the chosen tile provider |
| `MAP_MAX_ZOOM` | `19` | Tile provider’s maximum zoom |

The browser uses Leaflet, with no API key required for the default OpenStreetMap tiles. Tile URLs and attribution can be changed at runtime without rebuilding. For a larger public service, choose a tile provider suitable for the expected traffic; the default community tile service has a [usage policy and no availability guarantee](https://operations.osmfoundation.org/policies/tiles/). Attribution stays visible on every map.

## Production deployment

Browser geolocation requires **HTTPS**, except on localhost. Opening the app at a phone’s plain HTTP LAN address will not enable location. Keep the page visible while meeting: mobile operating systems may suspend location and networking in background tabs or on locked screens.

For nixpi, the checkout is `/home/infiniter/services/onmyway`, the public origin is `https://omw.infiniter.tech`, and the container binds to `127.0.0.1:13007`. Its untracked `.env` contains:

```dotenv
APP_PORT=13007
APP_BIND=127.0.0.1
PUBLIC_URL=https://omw.infiniter.tech
TRUST_PROXY=1
```

Source is transferred through Git:

```sh
git push origin main
ssh infiniter@nixpi.tail6650cb.ts.net
cd ~/services/onmyway
git pull --ff-only origin main
docker compose up -d --build --wait
```

Nginx and dynamic DNS are managed in the `nagy135/nix-server` repository, in `hosts/nixpi/nginx.nix` and `hosts/nixpi/default.nix`. The HTTPS vhost proxies to port 13007. It disables response buffering and compression for the event stream and forwards the public host, protocol, and client IP. Let’s Encrypt handles TLS; the existing Websupport DDNS service maintains the `omw` A record.

For another host, use an equivalent proxy configuration:

```nginx
location / {
    proxy_pass http://127.0.0.1:13007;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_buffering off;
    proxy_read_timeout 90s;
    gzip off;
}
```

## Behavior and privacy

- Meetings expire after 24 hours and support up to 12 participants.
- The device’s position is sent about every four seconds, and server-sent events immediately distribute changes to meeting members. Stationary devices are periodically asked for a fresh fix.
- Cookies restore your membership on refresh. They are HttpOnly, scoped to a meeting’s API path, and secure on HTTPS. The database stores hashes of member credentials.
- An invite link allows someone to join; it does not expose participant names or positions until they join. Treat it as a private capability and only share it with people you trust.
- Only the latest position is stored; there is no movement history. Pause clears that position, and leave deletes the participant. Pausing is remembered for the current browser tab across refreshes.
- Participants show as away after 15 seconds without a heartbeat. Locations disappear after two minutes without a fresh fix or heartbeat. Expired sessions and stale positions are cleaned up every minute.
- The map displays straight-line distance, not a walking route. External maps apps calculate navigation.
- There are no analytics, ads, or account passwords. The selected tile provider receives tile requests; opening directions sends the selected destination to the maps provider.

SQLite and event subscriptions are designed for **one server instance**. Do not horizontally scale this container without moving event delivery and persistence to shared infrastructure.

## Checks

```sh
npm test
npm run build
docker compose config
```

Tests cover session creation and membership, authorization, request origins, position validation, pause/leave behavior, expiry and capacity, live SSE delivery, SQLite persistence, stale fixes, distance calculations, and directions URLs.

## API

| Endpoint | Purpose |
| --- | --- |
| `GET /api/health` | Database-backed health check |
| `GET /api/config` | Map provider settings |
| `POST /api/sessions` | Create a meeting with `{ name }` |
| `GET /api/sessions/:id` | Get a meeting snapshot; locations require membership |
| `POST /api/sessions/:id/join` | Join with `{ name }` |
| `PATCH /api/sessions/:id/me` | Update your name, sharing state, latest fix, or heartbeat |
| `DELETE /api/sessions/:id/me` | Leave and clear your credential |
| `GET /api/sessions/:id/events` | Cookie-authenticated server-sent events |

Position payloads contain `latitude`, `longitude`, `accuracy` in meters, and `timestamp` in Unix milliseconds. Mutations require same-origin requests and JSON bodies (except DELETE). Locations and credentials are never put in invite URLs.
