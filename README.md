# Disaster SOS and Rescue Coordination System Using AWS

**Author:** Somesh

A two-part emergency system for disasters where mobile networks fail:

1. **MeshGuard SOS** (victim app): an installable, offline-first web app. A person can send an SOS
   (typed, panic button, or automatic fall detection) with their GPS location. With no internet, the SOS
   hops phone-to-phone over a WebRTC mesh. As soon as **any** phone in the mesh gets internet, it uploads
   every SOS it is carrying to the cloud.
2. **Rescue Control** (rescuer dashboard): a live map and priority queue running on **AWS EC2**. Rescuers
   see new SOS calls instantly, assign teams, and update status ("Team en route", "Rescued"). The
   status flows back to the victim's phone in real time.

## Architecture

```
  Victim phones (PWA)                                AWS Cloud (single EC2 instance)
 ┌──────────────┐  WebRTC   ┌──────────────┐        ┌──────────────────────────────────────────┐
 │ Phone A      │◄────────►│ Phone B      │ HTTPS  │  Caddy  (TLS, Let's Encrypt, :443)        │
 │ no signal    │  mesh     │ has signal   ├───────►│    │                                      │
 │ SOS queued   │  relay    │ = gateway    │  WSS   │    ▼                                      │
 └──────────────┘           └──────────────┘◄───────┤  Node.js server (systemd, :8080 local)   │
                                                    │   • REST API  /api/sos, /api/teams       │
  Rescuers (browser)                                │   • WebSocket /ws  (live push)           │
 ┌──────────────────────┐   HTTPS + WSS             │   • serves PWA + dashboard               │
 │ Rescue Control map   │◄─────────────────────────►│    │                                      │
 │ assign / update      │                           │    ▼                                      │
 └──────────────────────┘                           │  SQLite (EBS volume) + daily backups      │
                                                    └──────────────────────────────────────────┘
```

**AWS service used: Amazon EC2.** One instance hosts the whole system: the HTTPS endpoint, the API,
real-time WebSockets, the database (on the instance's EBS volume) and both web apps. Related EC2
features used: security groups (firewall), an Elastic IP (fixed address), EBS storage, and instance
metadata (the setup script finds its own public IP).

### How an SOS travels

| Step | Where | What happens |
|------|-------|--------------|
| 1 | Victim phone | SOS saved to IndexedDB first, so it survives a closed app or a dead network |
| 2 | Mesh | Broadcast to connected peers; each peer stores and re-broadcasts it (max 5 hops, duplicates dropped) |
| 3 | Any online phone | `CloudSyncService` uploads every unsynced SOS it holds (`POST /api/sos`), its own and relayed ones |
| 4 | EC2 | Server deduplicates by SOS id, computes priority, stores it, logs a timeline event |
| 5 | EC2 → dashboard | WebSocket push: toast + sound, pin on the map, queue re-sorted by priority |
| 6 | Dashboard → EC2 → phone | Rescuer assigns team / changes status; victim's phone gets the update over WebSocket (15 s polling fallback) |

**Priority:** panic button or critical/severe fall → *Critical*; other automatic fall → *High*; typed SOS → *Normal*.

## Project layout

```
client/                 React + TypeScript (Vite), two pages from one build
  src/                  victim PWA: SOS form, panic button, fall detection, P2P mesh
    services/SyncService.ts   mesh → cloud gateway + live rescue status
  src/dashboard/        rescuer dashboard: Leaflet map, queue, case detail, teams
server/                 Node.js (Express + ws), SQLite via built-in node:sqlite
  src/server.js         REST API, WebSocket, static hosting
  src/db.js             schema, priority rules, queries
  src/seed.js           creates sample rescue teams
deploy/                 EC2 setup script, systemd unit, Caddy config, update script
```

## Deploying on AWS EC2

1. **Launch an instance** (EC2 console → Launch instance)
   - AMI: **Ubuntu Server 24.04 LTS**, type **t2.micro / t3.micro** (free tier), 8–16 GB gp3 storage
   - Key pair: create one and download the `.pem`
   - **Security group** inbound rules: SSH 22 (My IP only), HTTP 80 (anywhere), HTTPS 443 (anywhere)
2. **Allocate an Elastic IP** and associate it with the instance, so the address survives restarts.
3. **Connect and install:**
   ```bash
   ssh -i your-key.pem ubuntu@<elastic-ip>
   git clone <your-repo-url> disaster-sos
   cd disaster-sos
   sudo DASHBOARD_KEY='pick-a-strong-passcode' bash deploy/setup-ec2.sh
   ```
   The script prints the URLs, e.g. `https://3-110-5-2.sslip.io/` (victim app) and `/dashboard` (rescuers).
   [sslip.io](https://sslip.io) maps that name to your IP, so you get a real HTTPS certificate without buying
   a domain. HTTPS matters: phones only allow GPS, camera, motion sensors and app install on secure sites.
4. **Updates:** `bash deploy/update.sh` on the instance.
5. **Logs:** `journalctl -u disaster-sos -f`

Cost: free-tier eligible. Stop the instance when not demoing; release the Elastic IP when done, since an
unattached Elastic IP is billed.

## Running locally

Requires Node.js 22.13+ (24 recommended).

```bash
cd server && npm install && npm run seed && npm start      # http://localhost:8080
cd client && npm install && npm run build                  # server then serves the built apps
```

For frontend development with hot reload, run `npm run dev` in `client/` (proxies `/api` and `/ws` to the server).
Local dashboard passcode: `rescue-dev-key` (set `DASHBOARD_KEY` to change it).

## Demo script

1. Open the dashboard on a laptop (`/dashboard`) and the victim app on a phone.
2. On the phone send an SOS. It appears on the dashboard map within a second, with a sound alert.
3. Assign a team and press **Team en route**: the phone shows "Team en route · <team>" without refreshing.
4. **Mesh relay:** pair two phones (Settings → Generate Link / Scan Peer). Turn one phone to airplane mode
   with Wi-Fi off and send a panic SOS. It reaches the other phone over the mesh, which uploads it. On the
   dashboard it shows the relay icon and "relayed by … after 1 hop(s)" in the timeline.
5. Mark **Rescued**: the team becomes available again and *Avg time to rescue* updates.

## API

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | – | Health check |
| POST | `/api/sos` | – | Phone uploads `{deviceId, messages[]}`; returns rescue status per id |
| GET | `/api/sos/status?ids=a,b` | – | Victim polls status of their own SOS ids |
| GET | `/api/sos[?status=]` | rescuer | Full queue |
| GET | `/api/sos/:id` | rescuer | Case detail + timeline |
| PATCH | `/api/sos/:id` | rescuer | `{status?, teamId?, note?}` |
| GET/POST | `/api/teams` | rescuer | List / create teams |
| PATCH/DELETE | `/api/teams/:id` | rescuer | Update / remove a team |
| GET | `/api/stats` | rescuer | Dashboard counters |
| WS | `/ws[?key=]` | optional | Live events; rescuers get full records, phones only status changes |

Rescuer endpoints need the `x-dashboard-key` header. Victims' phones can only submit SOS and read the status
of ids they already know (random UUIDs); they can never list other people's locations.

## Security notes

- TLS everywhere through Caddy; the Node server listens on `127.0.0.1` only, so port 8080 is not exposed.
- Security group allows just 22 (restricted to your IP), 80 and 443.
- systemd hardening: the service runs as a normal user and can write only to its data folder.
- Input validation and size limits on every endpoint; parameterised SQL throughout.

## Scaling beyond one instance (future work)

The single-instance design is deliberate for this project. To scale: put instances in an Auto Scaling group
behind an Application Load Balancer, move SQLite to Amazon RDS, and fan out WebSocket events through Redis or
SNS. The API and client would not need to change.
