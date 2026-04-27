# Secure Communication Platform

An open-source, organization-grade communication platform: **Rocket.Chat**
for chat, **Jitsi Meet** for video, a dedicated **Auth Service** that
exchanges **Google OAuth for a JWT** that Jitsi accepts, and a full
**observability stack** (Prometheus / Grafana / Loki / Promtail / Node
Exporter). Everything is wired together as a single root-level Docker
Compose project, with **host-installed Nginx** terminating TLS for every
sub-domain.

> The repository is laid out **production-style**: services are defined in
> one Compose file, secrets live only in `.env` (never committed to Git),
> and self-contained third-party stacks (Jitsi) are kept under their own
> directory with their own README.

---

## Table of contents

1. [Architecture](#architecture)
2. [Service URLs](#service-urls)
3. [Deployment steps](#deployment-steps)
4. [DNS requirements](#dns-requirements)
5. [Docker Compose layout](#docker-compose-layout)
6. [Why Nginx is outside Docker](#why-nginx-is-outside-docker)
7. [Why Jitsi is kept as a separate official stack](#why-jitsi-is-kept-as-a-separate-official-stack)
8. [Google OAuth for Rocket.Chat](#google-oauth-for-rocketchat)
9. [Google OAuth → JWT for Jitsi](#google-oauth--jwt-for-jitsi)
10. [SMTP integration](#smtp-integration)
11. [Observability (Grafana / Prometheus / Loki)](#observability-grafana--prometheus--loki)
12. [Issues encountered and how they were resolved](#issues-encountered-and-how-they-were-resolved)

---

## Architecture

```
                              Internet
                                 |
                                 v
                       DNS (Cloudflare / registrar)
                                 |
                                 v
                Host Nginx + TLS (Let's Encrypt)
                ────────────────────────────────
                  only 443/tcp is public
                                 |
   ┌───────────────┬─────────────┴─────────────┬──────────────────┐
   v               v                           v                  v
chat.*          video.*                     auth.*             grafana.*
   |               |                           |                  |
127.0.0.1:3000  127.0.0.1:8000             127.0.0.1:3001     127.0.0.1:3002
   |               |                           |                  |
Rocket.Chat   docker-jitsi-meet           auth-service        Grafana
(root         (separate stack             (Google OAuth →     (root compose)
 compose)      under ./jitsi)              JWT for Jitsi)
   |
MongoDB (rs0)   <─── private "backend" network (not exposed to host)
   |
Prometheus / Loki / Promtail / Node Exporter / Grafana ── "monitoring" network
```

**Principles:**

- Every application port is bound to `127.0.0.1` only; the host Nginx is
  the **only** thing that talks to `0.0.0.0:443` and proxies traffic in
  via TLS.
- Three Docker networks:
  - `frontend` — services reached by the host Nginx (Rocket.Chat, Auth
    Service, Grafana).
  - `backend` — `internal: true` (Mongo ↔ Rocket.Chat); unreachable from
    the host network namespace.
  - `monitoring` — Prometheus / Loki / Promtail / Grafana plus the
    services they scrape.
- Jitsi runs as a **separate** Docker Compose project under `./jitsi/`
  (see `jitsi/README.md`). It is intentionally **not** part of the root
  `docker-compose.yml`.

---

## Service URLs

| Service        | Public URL                              | Internal host port  |
|----------------|-----------------------------------------|---------------------|
| Rocket.Chat    | `https://chat.think-deploy.com`         | `127.0.0.1:3000`    |
| Jitsi Meet     | `https://video.think-deploy.com`        | `127.0.0.1:8000`    |
| Auth Service   | `https://auth.think-deploy.com`         | `127.0.0.1:3001`    |
| Grafana        | `https://grafana.think-deploy.com`      | `127.0.0.1:3002`    |
| Prometheus     | (internal only)                         | `127.0.0.1:9090`    |
| Loki           | (internal only)                         | `127.0.0.1:3100`    |
| Node Exporter  | (internal only)                         | `127.0.0.1:9100`    |

---

## Deployment steps

### Prerequisites

- Ubuntu 22.04 / 24.04 (or comparable Linux distro).
- Docker Engine + Compose v2 plugin (`docker compose version`).
- Nginx **on the host** (`sudo apt install nginx`).
- `certbot` + `python3-certbot-nginx` for Let's Encrypt.
- Firewall: TCP `80`, `443` open, and **UDP `10000`** open (for Jitsi
  JVB media).

### Fresh install

```bash
git clone https://github.com/amit-barda/comm-platform.git
cd comm-platform

cp .env.example .env
${EDITOR:-nano} .env             # GOOGLE_*, JWT_SECRET, GRAFANA_ADMIN_PASSWORD, ...

cd jitsi
cp .env.example .env
./gen-passwords.sh
${EDITOR:-nano} .env             # PUBLIC_URL, JWT_APP_SECRET (= JWT_SECRET from root),
                                  # JVB_ADVERTISE_IPS, TOKEN_AUTH_URL
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}
cd ..

docker compose up -d --build

docker compose -f jitsi/docker-compose.yml --env-file jitsi/.env up -d

sudo cp nginx/*.conf /etc/nginx/sites-available/
for d in chat video auth grafana; do
  sudo ln -sf /etc/nginx/sites-available/${d}.think-deploy.com.conf \
              /etc/nginx/sites-enabled/${d}.think-deploy.com.conf
done
# IMPORTANT: remove any legacy non-.conf symlinks (see issue #11):
sudo rm -f /etc/nginx/sites-enabled/{auth,chat,grafana,video}.think-deploy.com
sudo nginx -t && sudo systemctl reload nginx

sudo certbot --nginx \
  -d chat.think-deploy.com \
  -d video.think-deploy.com \
  -d auth.think-deploy.com \
  -d grafana.think-deploy.com
```

### Sanity checks

```bash
docker compose ps
curl -fsS http://127.0.0.1:3001/healthz
curl -I   https://chat.think-deploy.com
curl -I   https://video.think-deploy.com
curl -I   https://auth.think-deploy.com
```

---

## DNS requirements

`A` records (and `AAAA` if you have IPv6) pointing to the VM's **public**
IPv4: `chat`, `video`, `auth`, `grafana` — all under
`*.think-deploy.com`.

> Common gotcha: Cloudflare returned an internal `100.x.x.x` (CGNAT /
> Tailscale) instead of the actual public IP, leading to Cloudflare
> `502 Bad Gateway`. See issue #1.

---

## Docker Compose layout

The repository contains **two** Compose stacks:

1. **`./docker-compose.yml`** (root) — the entire platform except Jitsi:
   `mongodb`, `mongodb-init-replica`, `rocketchat`, `auth-service`,
   `prometheus`, `node-exporter`, `loki`, `promtail`, `grafana`.
2. **`./jitsi/docker-compose.yml`** — the upstream `docker-jitsi-meet`
   stack, deliberately untouched (see `jitsi/README.md`).

**Networks:**

| Network      | Purpose                                                                | `internal` |
|--------------|------------------------------------------------------------------------|-----------|
| `frontend`   | Rocket.Chat, Auth Service, Grafana — proxied by host Nginx.            | no        |
| `backend`    | MongoDB ↔ Rocket.Chat. No outbound or host access.                     | **yes**   |
| `monitoring` | Prometheus / Loki / Promtail / Node Exporter / Grafana + scrape targets.| no       |

**Healthchecks** are defined for MongoDB (`mongosh ping`), Rocket.Chat
(`/api/info` via `wget`), Auth Service (`/healthz`), Prometheus
(`/-/healthy`), Loki (`/ready`), and Grafana (`/api/health`).

**Restart policy:** `unless-stopped` for every long-running service;
`"no"` for the replica-set init container.

**Port bindings** (host → container) — **all on `127.0.0.1` only:**

```
127.0.0.1:3000 -> rocketchat:3000
127.0.0.1:3001 -> auth-service:3001
127.0.0.1:3002 -> grafana:3000
127.0.0.1:9090 -> prometheus:9090
127.0.0.1:9100 -> node-exporter:9100
127.0.0.1:3100 -> loki:3100
```

MongoDB is **not** mapped to any host port; it is reachable only on the
`internal` `backend` network.

**Volume preservation:** the root `docker-compose.yml` pins explicit
`name:` entries on volumes (`rocketchat_mongodb_data`,
`monitoring_grafana_data`, `monitoring_prometheus_data`,
`monitoring_loki_data`) so the new compose project takes over the
volumes created by the previous per-folder stacks without losing data.

---

## Why Nginx is outside Docker

- Let's Encrypt certificates already live on the host under
  `/etc/letsencrypt/`, and `certbot --nginx` renews them automatically.
- One less network hop. Host Nginx talks to containers via
  `127.0.0.1:<port>`, with trivial WebSocket / HTTP/2 support.
- Native systemd integration (`systemctl reload nginx`,
  `journalctl -u nginx`).
- The configs are versioned in this repo under `./nginx/*.conf` and are
  meant to be copied into `/etc/nginx/sites-available/` during install.

---

## Why Jitsi is kept as a separate official stack

`docker-jitsi-meet` is the official Compose stack and includes every
component the project supports. It changes often with each upstream
release, relies on subtle `cont-init.d` ordering, requires UDP/10000 +
`JVB_ADVERTISE_IPS`, and is hard to merge into a different Compose file
without losing the ability to upgrade cleanly. It therefore stays under
`./jitsi/` as a self-contained unit and integrates with the rest of the
platform in two places only:

1. **Host Nginx** proxies `https://video.think-deploy.com` to
   `http://127.0.0.1:8000` (`jitsi-web`).
2. **`auth-service`** signs JWTs with the same value Prosody is configured
   to verify as `JWT_APP_SECRET`.

---

## Google OAuth for Rocket.Chat

1. In the
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials)
   create an **OAuth Client ID** of type **Web application**.
2. **Authorized redirect URIs:**
   `https://chat.think-deploy.com/_oauth/google?close`
3. In Rocket.Chat: **Admin → OAuth → Google → Enable + Custom OAuth** and
   paste the `Client ID` / `Client Secret`.
4. Optional: restrict to a single domain via **Accounts → Registration →
   Restrict to Domain** or via Google Workspace policy.

---

## Google OAuth → JWT for Jitsi

`docker-jitsi-meet` does not offer a "Login with Google" button. The
`auth-service` in this repo is a small Express + Passport service that
performs Google OAuth and signs a JWT that Prosody verifies.

**Flow:**

```
Browser ──> https://video.think-deploy.com/<room>
            (no JWT — TOKEN_AUTH_URL kicks in)
        ──> https://auth.think-deploy.com/auth/google?room=<room>
        ──> accounts.google.com (consent)
        ──> https://auth.think-deploy.com/auth/google/callback?state=<base64({room})>
            auth-service decodes `state`, signs JWT (HS256, sub=meet.jitsi)
        ──> https://video.think-deploy.com/<room>?jwt=<token>
            Prosody validates HMAC and admits the user
```

Critical settings:

| Where | Setting | Value |
|-------|---------|-------|
| `.env` (root)         | `JWT_SECRET`              | `openssl rand -hex 48` (97 chars) |
| `.env` (root)         | `GOOGLE_CLIENT_ID/SECRET` | from Google Cloud OAuth Web app   |
| `auth-service/app.js` | `JWT_SUB` default         | `meet.jitsi` (Jitsi internal XMPP domain — do **not** set to the public URL) |
| `jitsi/.env`          | `JWT_APP_SECRET`          | **same value** as `JWT_SECRET`    |
| `jitsi/.env`          | `TOKEN_AUTH_URL`          | `https://auth.think-deploy.com/auth/google?room={room}` |

The Google Cloud OAuth client must list both redirect URIs (if you reuse
one client for chat + video):

- `https://auth.think-deploy.com/auth/google/callback`
- `https://chat.think-deploy.com/_oauth/google?close`

---

## SMTP integration

SMTP is used by Rocket.Chat (password reset, email 2FA, invitations) and
optionally by Grafana (alert notifications). Variables in `.env`:

```env
SMTP_USERNAME=
SMTP_PASSWORD=

# Rocket.Chat — full mail URL (preferred)
ROCKETCHAT_MAIL_URL=smtps://USER:PASS@smtp.example.com:465/

# Grafana (optional)
GRAFANA_SMTP_ENABLED=true
SMTP_HOST=smtp.example.com:587
SMTP_FROM_ADDRESS=alerts@think-deploy.com
```

Rocket.Chat's `OVERWRITE_SETTING_SMTP_*` env vars are wired through the
compose file so the values apply on container restart.

---

## Observability (Grafana / Prometheus / Loki)

| Service        | Role                                                            | Internal port |
|----------------|-----------------------------------------------------------------|---------------|
| Prometheus     | Time-series metrics (15-day retention).                         | `9090`        |
| Node Exporter  | Host metrics (CPU/RAM/disk/net) — `pid: host`, `/:/host:ro`.    | `9100`        |
| Loki           | Log aggregator, filesystem-backed.                              | `3100`        |
| Promtail       | Tails `/var/log/*.log` and Docker container logs into Loki.     | `9080`        |
| Grafana        | UI; admin via `GF_SECURITY_ADMIN_USER` / `..._PASSWORD`.         | `3000`        |

Grafana data sources (configure on first login):

- Prometheus: `http://prometheus:9090`
- Loki: `http://loki:3100`

---

## Issues encountered and how they were resolved

### 1. DNS pointed at an internal `100.x.x.x` address instead of the public IP
Cloudflare returned a `100.x.x.x` (CGNAT / Tailscale) record. Certbot
HTTP-01 failed; browser saw `502 Bad Gateway`. Fixed by setting the
correct public IPv4 (`curl -s https://api.ipify.org`) in the `A` record
and temporarily disabling "Proxied" while issuing the certificate.

### 2. Cloudflare `502 Bad Gateway`
Caused by bad DNS, Nginx not running, Rocket.Chat crashing because of
MongoDB, or port 443 blocked by the cloud security group. Diagnosed via
`systemctl status nginx`, `nginx -t`, `ss -tlnp`, `docker compose ps`,
and SG rules.

### 3. Rocket.Chat started before MongoDB was ready
`MongoNetworkError` / `not master and slaveOk=false`. Compose v1
`depends_on` only orders start, not readiness; MongoDB also needs
`rs.initiate(...)`. Fixed by adding a one-shot `mongodb-init-replica`
service (`restart: "no"`) and Compose v2 conditions:
```yaml
depends_on:
  mongodb: { condition: service_healthy }
  mongodb-init-replica: { condition: service_completed_successfully }
```

### 4. Compose used `compose.yml` instead of `docker-compose.yml`
The repo had a stale `compose.yml.bak` and several upstream
`compose.*.yml` files in `rocketchat/`. Compose v2 picks `compose.yml`
ahead of `docker-compose.yml`. Fixed by removing the upstream
`rocketchat/` tree, deleting `compose.yml.bak`, and adding the
`compose.yml.bak` pattern to `.gitignore`.

### 5. MongoDB 6 was unsupported — upgraded to MongoDB 7
With `mongo:6.0`, Rocket.Chat 8.x logged `Mongo version not supported`.
Fixed by bumping to `mongo:7.0` while keeping `wiredTiger` storage
engine. The named volume made the in-place upgrade safe.

### 6. Google OAuth — `redirect_uri_mismatch`
The `callbackURL` in `auth-service/app.js` must match the **Authorized
redirect URIs** entry in Google Cloud Console **byte for byte**. Fixed
by externalising it as `${PUBLIC_BASE_URL}/auth/google/callback`.

### 7. Email-based 2FA required SMTP
Without `MAIL_URL` / `SMTP_*`, Rocket.Chat couldn't send 2FA mails.
Fixed by adding `ROCKETCHAT_MAIL_URL`, `SMTP_USERNAME`, `SMTP_PASSWORD`
to `.env` and wiring them through `OVERWRITE_SETTING_SMTP_*` in the
compose file.

### 8. Jitsi has no native Google OAuth in Docker
`docker-jitsi-meet` supports only `internal`, `jwt`, `ldap`, `matrix`.
Fixed by building `auth-service` (Node + Passport) which performs Google
OAuth and signs a JWT with the same `JWT_APP_SECRET` Jitsi expects.

### 9. Auth Service — OAuth callback and scope fixes
Initial scope was `['profile']` only — fixed to
`['profile', 'email']` so `req.user.emails[0].value` is populated.
`callbackURL` was hard-coded to HTTPS — fixed to use `PUBLIC_BASE_URL`.

### 10. Secrets were exposed in screenshots — they must be rotated
`JWT_SECRET`, `GOOGLE_CLIENT_SECRET`, and Grafana admin password leaked
in screenshots during development. Rotate every leaked secret
(`openssl rand -hex 48` for JWT, new Google OAuth client, new Grafana
password), audit `git log -p -- '*.env*'`, and add a `gitleaks`
pre-commit hook.

### 11. Duplicate Nginx site symlinks shadowed the new vhost
**Symptom:** after deploying refactored `nginx/*.conf`, Jitsi still
flashed "You have been disconnected. Reconnecting…" and `nginx -T`
warned `conflicting server name "video.think-deploy.com" on
0.0.0.0:443, ignored` for **all four** sub-domains.

**Root cause:** the original `certbot --nginx` had created
`/etc/nginx/sites-enabled/video.think-deploy.com` (no `.conf`
extension). When the refactored `video.think-deploy.com.conf` was
symlinked next to it, both files were loaded; Nginx keeps the first
server block for a duplicate `server_name`, and alphabetical order made
the **older, broken** vhost win.

**Fix:** remove the legacy symlinks (without `.conf`):
```bash
sudo rm /etc/nginx/sites-enabled/{auth,chat,grafana,video}.think-deploy.com
sudo nginx -t && sudo systemctl reload nginx
```

### 12. Nginx vhost for Jitsi was missing WebSocket headers
**Symptom:** Jitsi prejoin loaded with the user's name + avatar from
the JWT, but every ~24s the page flashed "You have been disconnected".
Inside `jitsi-prosody-1`: only `Client connected` followed immediately
by `Client disconnected: connection closed`.

**Root cause:** the original vhost had `proxy_pass` only — without
`Connection: $connection_upgrade` / `Upgrade: $http_upgrade`. Jitsi
requires a real WebSocket upgrade on three paths: `/xmpp-websocket`
(Strophe XMPP), `/colibri-ws/...` (browser ↔ JVB bridge channel), and
`/http-bind` (BOSH fallback).

**Fix:** `nginx/video.think-deploy.com.conf` now defines
`map $http_upgrade $connection_upgrade { default upgrade; '' close; }`
plus explicit `location` blocks for those three paths with `Upgrade` /
`Connection` forwarding, `tcp_nodelay on`, and a 900-second read/send
timeout. Verified live:
```bash
curl -I -H "Connection: Upgrade" -H "Upgrade: websocket" \
     -H "Sec-WebSocket-Version: 13" -H "Sec-WebSocket-Key: dGVzdA==" \
     https://video.think-deploy.com/xmpp-websocket
# -> HTTP/1.1 101 Switching Protocols
```

### 13. `JWT_APP_SECRET` in `jitsi/.env` was a 10-char placeholder
**Symptom:** every JWT signed by `auth-service` was silently rejected
by Prosody.

**Root cause:** root `.env` had `JWT_SECRET` length **97**, but
`jitsi/.env` still held a leftover `JWT_APP_SECRET=<10-char placeholder>`
from the original setup. Detected by:
```bash
docker exec auth-service    printenv JWT_SECRET    | wc -c   # 98
docker exec jitsi-prosody-1 printenv JWT_APP_SECRET | wc -c  # 11  ← bug
```

**Fix:** synchronised the two values (keeping the 97-char value as the
source of truth in the root `.env`) and recreated `prosody`, `jicofo`,
and `web` so Prosody re-rendered `app_secret` in
`/config/conf.d/jitsi-meet.cfg.lua`.

### 14. JWT `sub` claim was `video.think-deploy.com`, not `meet.jitsi`
**Symptom:** even after issue #13, Jitsi popped a "Authentication
required — User / Password" dialog right after entering a room.

**Root cause:** `auth-service/app.js` defaulted
`JWT_SUB="video.think-deploy.com"`. In single-tenant docker-jitsi-meet
the `sub` claim is mapped to `session.jitsi_meet_domain` (see
`/prosody-plugins/token/util.lib.lua:322`), which Prosody checks
against the **internal** XMPP domain `meet.jitsi`. The mismatch made
Prosody fall back to `internal_plain`, producing the user/password
popup.

**Fix:** `const JWT_SUB = process.env.JWT_SUB || 'meet.jitsi';` in
`auth-service/app.js`. Verified by Prosody logging
`Authenticated as <uuid>@meet.jitsi` on the next sign-in.

### 15. No auto-redirect from `video.*/<room>` to the OAuth bridge
**Symptom:** users had to know to start at `auth.think-deploy.com`
manually. Hitting `https://video.think-deploy.com/<room>` directly
always ended at the user/password popup. Worse, `auth-service` hardcoded
the redirect target to `/test?jwt=...`, so everyone landed in a single
shared "test" room.

**Fix (two parts):**

1. `TOKEN_AUTH_URL` added to `jitsi/.env`:
   ```env
   TOKEN_AUTH_URL=https://auth.think-deploy.com/auth/google?room={room}
   ```
   docker-jitsi-meet renders this into `config.tokenAuthUrl`. When
   `ENABLE_AUTH=1` and the user lacks a JWT, jitsi-meet web replaces
   `{room}` with the URL room name and redirects automatically.
2. Room round-trip in `auth-service/app.js`: `/auth/google` packs the
   `room` query parameter into the OAuth `state` field (Google echoes
   it back); `/auth/google/callback` decodes it and redirects to
   `https://video.think-deploy.com/<room>?jwt=<token>`.

### 16. Rocket.Chat container marked `unhealthy` — image lacks `curl`
**Symptom:** `docker compose ps` showed `rocketchat … (unhealthy)`.
`docker inspect rocketchat` revealed
`exec: "curl": executable file not found in $PATH`.

**Root cause:** `rocketchat/rocket.chat:8.0.1` ships with `wget` and
`node` only.

**Fix:** the healthcheck in `docker-compose.yml` now uses `wget`:
```yaml
healthcheck:
  test: ["CMD-SHELL", "wget -qO- http://127.0.0.1:3000/api/info >/dev/null || exit 1"]
```

---

## Repository layout

```
secure-communication-platform/
├── README.md                # this file
├── .env.example             # placeholders for every variable
├── .gitignore
├── docker-compose.yml       # the main stack
├── auth-service/
│   ├── Dockerfile
│   ├── package.json
│   └── app.js               # Google OAuth -> JWT (with `state`-based room round-trip)
├── monitoring/
│   ├── prometheus.yml
│   ├── loki-config.yml
│   └── promtail-config.yml
├── nginx/                   # example host-Nginx vhosts (documentation)
│   ├── chat.think-deploy.com.conf
│   ├── video.think-deploy.com.conf  # WebSocket upgrade configured
│   ├── grafana.think-deploy.com.conf
│   └── auth.think-deploy.com.conf
└── jitsi/                   # docker-jitsi-meet upstream (separate stack)
    ├── README.md
    ├── .env.example
    ├── docker-compose.yml   # upstream — do not edit
    ├── env.example          # upstream — full reference
    └── ...                  # web/, prosody/, jicofo/, jvb/, ...
```

---

## Quick-start commands

```bash
cp .env.example .env
${EDITOR:-nano} .env

docker compose up -d --build

sudo cp nginx/*.conf /etc/nginx/sites-available/
for d in chat video auth grafana; do
  sudo ln -sf /etc/nginx/sites-available/${d}.think-deploy.com.conf \
              /etc/nginx/sites-enabled/${d}.think-deploy.com.conf
done
sudo rm -f /etc/nginx/sites-enabled/{auth,chat,grafana,video}.think-deploy.com
sudo nginx -t && sudo systemctl reload nginx

docker compose -f jitsi/docker-compose.yml --env-file jitsi/.env up -d
```
