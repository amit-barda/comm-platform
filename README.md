# Secure Communication Platform

Self-hosted, container-only communication platform: **Rocket.Chat** for chat,
**Jitsi Meet** for video (gated by **Google OAuth → JWT**), and a full
**observability stack** (Prometheus, Grafana, Loki, Promtail, Node Exporter),
all behind a single **Nginx** reverse proxy with **Certbot**-managed Let's
Encrypt TLS.

Everything — Nginx, Certbot, Jitsi, MongoDB, Rocket.Chat, the OAuth bridge,
and monitoring — runs as containers in **one** `docker-compose.yml`. There
is no host-level Nginx and no separate Jitsi compose project. Rocket.Chat
and Jitsi are independent apps on their own subdomains; the only thing that
ties Jitsi to an identity provider is the `auth-service` container, which is
mounted on the same Jitsi domain under `/oauth/*`.

---

## Table of contents

1. [Architecture](#architecture)
2. [Service URLs](#service-urls)
3. [Domains](#domains)
4. [Ports](#ports)
5. [Networks and exposed ports](#networks-and-exposed-ports)
6. [Repository layout](#repository-layout)
7. [Prerequisites](#prerequisites)
8. [DNS requirements](#dns-requirements)
9. [Deployment steps](#deployment-steps)
10. [Google SSO setup](#google-sso-setup)
11. [SMTP setup](#smtp-setup)
12. [Observability setup](#observability-setup)
13. [Validation commands](#validation-commands)
14. [Day-2 operations](#day-2-operations)
15. [Configuration reference](#configuration-reference)
16. [Credentials](#credentials)
17. [Known limitations](#known-limitations)
18. [Troubleshooting](#troubleshooting)

---

## Architecture

```
                                     Internet
                                        |
                                        v
                            DNS (your registrar / CDN)
                                        |
                                        v
+--------------------------------------------------------------------+
|                        Nginx container                             |
|        only public ingress: 80/tcp + 443/tcp on the host           |
|        - terminates TLS via Let's Encrypt (Certbot)                |
|        - serves /.well-known/acme-challenge from /var/www/certbot  |
+----+-------------------+-----------------+-----------------+-------------+
     |                   |                 |                 |
     | proxy net         | proxy net       | proxy net       | proxy net
     v                   v                 v                 v
+----------+    +-----------------+   +--------------+   +-------------+
| rocket-  |    |   jitsi-web     |   | auth-service |   |   grafana   |
|  chat    |    | (frontend HTML) |<--| Google OAuth |   |             |
+----+-----+    +--------+--------+   |  -> JWT      |   +------+------+
     |                   |            +--------------+          |
     | chat_backend      | video_backend                        | monitoring
     | (internal)        |  (Jitsi internal mesh)               |
     v                   v                                      v
+----------+    +-----------------+                  +-----------------+
| mongodb  |    | jitsi-prosody   |                  | prometheus      |
| (private)|    | jitsi-jicofo    |                  | loki / promtail |
+----------+    | jitsi-jvb (UDP  |                  | node-exporter   |
                | 10000 -> host)  |                  +-----------------+
                +-----------------+

Auth flow on a video room visit:

  Browser -> https://video.think-deploy.com/<room>
          -> jitsi-web has no JWT, TOKEN_AUTH_URL kicks in
          -> https://video.think-deploy.com/oauth/google?room=<room>
             (nginx routes /oauth/* to auth-service)
          -> Google consent screen
          -> https://video.think-deploy.com/oauth/google/callback
             (auth-service signs JWT, redirects)
          -> https://video.think-deploy.com/<room>?jwt=<token>
             (Prosody validates JWT, admits the user)

                       Certbot containers
        - certbot          (one-shot, default `certbot` entrypoint;
                           used for initial issuance and ad-hoc commands)
        - certbot-renewer  (long-running loop, `certbot renew` every 12h)
        Both share /etc/letsencrypt and /var/www/certbot with nginx.
```

Key principles:

- **Single entrypoint.** Only the `nginx` container publishes host ports
  (`80/tcp`, `443/tcp`), plus `10000/udp` on `jitsi-jvb` for media. Everything
  else is reachable only through the internal Docker networks.
- **Independent apps.** Rocket.Chat and Jitsi do **not** integrate with
  each other. Each has its own subdomain, its own private backend network,
  and its own auth model: Rocket.Chat handles its own login (e.g. native
  Google OAuth via the admin UI), while Jitsi requires a JWT signed by the
  `auth-service` (Google OAuth → JWT bridge mounted under `/oauth/` on the
  Jitsi domain).
- **Private MongoDB.** `mongodb` is on the `chat_backend` network, which is
  declared `internal: true`. It cannot reach the internet and cannot be
  reached from the host.
- **Internal monitoring.** Prometheus, Loki, Promtail and Node Exporter are
  exposed only on the `monitoring` network. Grafana is the only observability
  service published through Nginx.
- **Container-native TLS.** Nginx ships with a startup hook that seeds a
  short-lived self-signed cert per domain on first boot, so `nginx` can
  serve port 80 immediately. Certbot then replaces the placeholders with
  real Let's Encrypt certificates (see deployment step 3 below — the
  placeholder lineage must be wiped once before first issuance).

---

## Service URLs

| Service        | Public URL                                       | Internal address      |
|----------------|--------------------------------------------------|-----------------------|
| Rocket.Chat    | `https://chat.think-deploy.com`                  | `rocketchat:3000`     |
| Jitsi Meet     | `https://video.think-deploy.com`                 | `jitsi-web:80`        |
| Auth bridge    | `https://video.think-deploy.com/oauth/*`         | `auth-service:3001`   |
| Grafana        | `https://grafana.think-deploy.com`               | `grafana:3000`        |
| Prometheus     | (internal only)                                  | `prometheus:9090`     |
| Loki           | (internal only)                                  | `loki:3100`           |
| MongoDB        | (internal only, no host port)                    | `mongodb:27017`       |

---

## Domains

| Domain                         | Routed to          | Purpose                            |
|--------------------------------|--------------------|------------------------------------|
| `chat.think-deploy.com`        | `rocketchat`       | Rocket.Chat web UI and API         |
| `video.think-deploy.com`       | `jitsi-web`        | Jitsi Meet web UI                  |
| `video.think-deploy.com/oauth` | `auth-service`     | Google OAuth -> Jitsi JWT bridge   |
| `grafana.think-deploy.com`     | `grafana`          | Grafana dashboards                 |

---

## Ports

| Host port       | Container/service | Why exposed publicly |
|-----------------|-------------------|----------------------|
| `80/tcp`        | `nginx`           | ACME challenge + HTTP->HTTPS redirect |
| `443/tcp`       | `nginx`           | TLS reverse proxy for all public apps |
| `10000/udp`     | `jitsi-jvb`       | Jitsi WebRTC media path |

No other host ports are exposed.

---

## Networks and exposed ports

Four Docker networks segment traffic by role:

| Network          | Purpose                                                                    | `internal` |
|------------------|----------------------------------------------------------------------------|-----------|
| `proxy`          | Nginx ↔ public-facing services (rocketchat, jitsi-web, grafana).           | no        |
| `chat_backend`   | Rocket.Chat ↔ MongoDB. Declared `internal: true`.                          | **yes**   |
| `video_backend`  | Jitsi internal mesh: prosody, jicofo, jvb, web.                            | no        |
| `monitoring`     | Prometheus, Loki, Promtail, Node Exporter, Grafana, scrape targets.        | no        |

Public host ports — the entire stack:

| Container   | Host binding   | Purpose                                   |
|-------------|----------------|-------------------------------------------|
| `nginx`     | `0.0.0.0:80`   | HTTP (redirect + ACME challenges)         |
| `nginx`     | `0.0.0.0:443`  | HTTPS for all three subdomains            |
| `jitsi-jvb` | `0.0.0.0:10000/udp` | Jitsi media (RTP/RTCP via ICE)       |

No other container publishes a host port.

---

## Repository layout

```
comm-platform/
├── README.md
├── .env.example
├── .gitignore
├── docker-compose.yml
├── auth-service/                  # Google OAuth -> JWT bridge for Jitsi
│   ├── Dockerfile
│   ├── package.json
│   └── app.js                     # routes /oauth/healthz, /oauth/google, /oauth/google/callback
├── nginx/
│   ├── Dockerfile
│   ├── init-certs.sh              # seeds dummy TLS certs on first boot
│   └── conf.d/
│       ├── 00-defaults.conf       # http{} defaults: TLS profile, WS map, ACME
│       ├── chat.conf              # chat.think-deploy.com  -> rocketchat
│       ├── video.conf             # video.think-deploy.com -> jitsi-web (+ /oauth/* -> auth-service)
│       └── grafana.conf           # grafana.think-deploy.com -> grafana
├── monitoring/
│   ├── prometheus.yml
│   ├── loki-config.yml
│   └── promtail-config.yml
└── certbot/                       # created at runtime; gitignored
    ├── conf/                      # /etc/letsencrypt
    └── www/                       # /var/www/certbot (ACME webroot)
```

---

## Prerequisites

- Linux host (Ubuntu 22.04 / 24.04 or comparable).
- Docker Engine + Compose v2 plugin (`docker compose version`).
- Public IPv4 with these inbound rules in your firewall / security group:
  - **TCP `80`** and **TCP `443`** (Nginx)
  - **UDP `10000`** (Jitsi JVB media)
- DNS records pointing to that public IP (see below).

---

## DNS requirements

Three `A` records (and `AAAA` if you have IPv6) pointing to the host's public
IPv4:

```
chat.think-deploy.com     A   <public IPv4>
video.think-deploy.com    A   <public IPv4>
grafana.think-deploy.com  A   <public IPv4>
```

Make sure the records resolve to the **real** public IP and not a CGNAT /
proxy / Tailscale address — Certbot's HTTP-01 challenge requires direct
inbound reachability on port 80.

---

## Deployment steps

### 1. Configure secrets

```bash
git clone https://github.com/amit-barda/comm-platform.git
cd comm-platform

cp .env.example .env
${EDITOR:-nano} .env
```

Required values to set:

- `LETSENCRYPT_EMAIL`
- `GRAFANA_ADMIN_PASSWORD`
- `JVB_ADVERTISE_IPS` (the host's public IPv4)
- `JICOFO_AUTH_PASSWORD`, `JICOFO_COMPONENT_SECRET`, `JVB_AUTH_PASSWORD`
  (generate with `openssl rand -hex 16` each)
- `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a Google Cloud
  **Web application** OAuth client. The client's **Authorized redirect URI**
  must be set to `https://video.think-deploy.com/oauth/google/callback`.
- `JWT_SECRET` (generate with `openssl rand -hex 48`). This is the
  symmetric HMAC key used to sign and verify the Jitsi JWT — it must be
  identical for `auth-service`, `jitsi-web`, and `jitsi-prosody` (Compose
  injects the same `${JWT_SECRET}` into all three).

### 2. Bring up the stack

```bash
docker compose up -d
```

On the very first boot the `nginx` container generates short-lived
self-signed certificates so it can serve port 80 immediately. Browsers will
show a TLS warning until you complete step 3.

### 3. Issue real Let's Encrypt certificates

The `nginx` container seeds short-lived self-signed placeholder certs on
first boot so it can serve port 80 immediately. Before requesting real
certs, **delete the placeholder hierarchy** so Certbot can create a fresh
lineage per domain (Certbot refuses to write into a pre-existing
`live/<domain>` directory):

```bash
sudo rm -rf certbot/conf/{live,archive,renewal}
```

Issue one independent certificate per domain:

```bash
source .env
for d in chat.think-deploy.com video.think-deploy.com grafana.think-deploy.com; do
  docker compose run --rm certbot certonly \
    --webroot -w /var/www/certbot \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos --non-interactive --no-eff-email \
    -d "$d"
done
```

Reload Nginx so it picks up the freshly-issued certs:

```bash
docker compose exec nginx nginx -s reload
```

The long-running `certbot-renewer` service runs `certbot renew --webroot`
every 12 hours from now on; nothing else is required for renewal. The
short-lived `certbot` service exists only for ad-hoc commands (it is
gated behind a Compose `profiles: [tools]` entry, so `up -d` does not
start it).

### 4. Verify

```bash
docker compose ps
docker compose logs -f nginx

curl -I https://chat.think-deploy.com
curl -I https://video.think-deploy.com
curl -I https://grafana.think-deploy.com
```

Each should return `HTTP/2 200` (or `301`/`302` for the app's landing
page).

---

## Google SSO setup

### Rocket.Chat (organization Google accounts)

Rocket.Chat authentication is independent from Jitsi.

1. In Google Cloud create an OAuth client (Web application).
2. Add redirect URI:
   - `https://chat.think-deploy.com/_oauth/google?close`
3. In Rocket.Chat Admin UI:
   - **Administration -> OAuth -> Google**: enable and set client id/secret.
   - **Accounts -> Registration**: disable public registration as needed.
   - **Accounts -> Registration -> Restrict to Domain**: set your org domain.
4. Optionally disable password login in Rocket.Chat auth settings if policy
   requires Google-only access.

### Jitsi (standalone Google SSO gate)

Jitsi does not integrate with Rocket.Chat. It uses a separate `auth-service`
for Google OAuth and JWT issuance.

1. In Google Cloud create/update an OAuth client (Web application).
2. Add redirect URI:
   - `https://video.think-deploy.com/oauth/google/callback`
3. In `.env` set:
   - `GOOGLE_CLIENT_ID`
   - `GOOGLE_CLIENT_SECRET`
   - `ALLOWED_GOOGLE_DOMAIN=yourdomain.com`
   - `JWT_SECRET` (shared signing key)
4. Restart Jitsi auth stack:
   - `docker compose up -d --build auth-service jitsi-web jitsi-prosody jitsi-jicofo`

The `auth-service` enforces that Google account emails end with
`@ALLOWED_GOOGLE_DOMAIN`; other accounts receive `403 Forbidden`.

---

## SMTP setup

SMTP is implemented for both Rocket.Chat and Grafana.

Set in `.env`:

- `ROCKETCHAT_MAIL_URL`
- `SMTP_USERNAME`
- `SMTP_PASSWORD`
- `GRAFANA_SMTP_ENABLED=true`
- `SMTP_HOST=smtp.example.com:587`
- `SMTP_FROM_ADDRESS=alerts@yourdomain.com`

Apply:

```bash
docker compose up -d rocketchat grafana
```

Test:

- **Rocket.Chat**: trigger password reset email from login screen.
- **Grafana**: Alerting -> Contact points -> Email -> Test.

---

## Observability setup

The stack ships with Prometheus + Loki + Promtail + Grafana, all in Compose.

- Grafana is auto-provisioned with:
  - `Prometheus` datasource (`http://prometheus:9090`)
  - `Loki` datasource (`http://loki:3100`)
  - dashboard: `Loki — Comm Platform Logs`
- Dashboard URL:
  - `https://grafana.think-deploy.com/d/comm-platform-loki`
- Promtail collects:
  - `/var/log/*.log`
  - Docker container logs with labels (`service`, `container`, `project`)

---

## Validation commands

```bash
docker compose config
docker compose pull
docker compose up -d
docker compose ps
docker compose logs -f nginx
docker compose logs -f rocketchat
docker compose logs -f mongo
docker compose logs -f grafana
```

Service checks:

```bash
curl -I https://chat.think-deploy.com
curl -I https://video.think-deploy.com
curl -I https://grafana.think-deploy.com
```

Note: the Mongo service name in this repository is `mongodb`, so
`docker compose logs -f mongo` will fail; use `docker compose logs -f mongodb`.

---

## Day-2 operations

```bash
# View logs
docker compose logs -f nginx
docker compose logs -f rocketchat
docker compose logs -f jitsi-web jitsi-prosody jitsi-jicofo jitsi-jvb
docker compose logs -f grafana

# Restart a single service
docker compose restart nginx
docker compose restart rocketchat

# Force renewal of TLS (e.g. after changing the domain list)
docker compose run --rm certbot renew --force-renewal
docker compose exec nginx nginx -s reload

# Tail the renewer service
docker compose logs -f certbot-renewer

# Pull newer images and re-deploy
docker compose pull
docker compose up -d

# Stop everything (volumes preserved)
docker compose down

# Stop and DESTROY all data (Mongo, Grafana, Jitsi config, ...)
docker compose down -v
```

---

## Configuration reference

### `.env`

| Variable                          | Used by              | Notes                                                               |
|-----------------------------------|----------------------|---------------------------------------------------------------------|
| `TZ`                              | jitsi-*              | Container time zone, e.g. `UTC`, `Asia/Jerusalem`.                  |
| `LETSENCRYPT_EMAIL`               | certbot              | Used during `certbot certonly`.                                     |
| `ROCKETCHAT_MAIL_URL`             | rocketchat           | Full SMTP URL, e.g. `smtps://user:pass@smtp.example.com:465/`.      |
| `SMTP_USERNAME` / `SMTP_PASSWORD` | rocketchat, grafana  | Passed to `OVERWRITE_SETTING_SMTP_*` and Grafana SMTP envs.         |
| `SMTP_HOST` / `SMTP_FROM_ADDRESS` | grafana              | Required when `GRAFANA_SMTP_ENABLED=true`.                          |
| `GRAFANA_ADMIN_USER/_PASSWORD`    | grafana              | Bootstrap admin account.                                            |
| `JVB_ADVERTISE_IPS`               | jitsi-jvb            | Public IPv4 of the host. Required behind NAT.                       |
| `JICOFO_AUTH_PASSWORD`            | jicofo, prosody      | Internal XMPP shared secret.                                        |
| `JICOFO_COMPONENT_SECRET`         | jicofo, prosody      | Internal XMPP component secret.                                     |
| `JVB_AUTH_PASSWORD`               | jvb, prosody         | Internal XMPP shared secret.                                        |
| `GOOGLE_CLIENT_ID/_SECRET`        | auth-service         | OAuth client for Jitsi Google sign-in.                              |
| `ALLOWED_GOOGLE_DOMAIN`           | auth-service         | Enforces organization-domain-only Jitsi access.                     |
| `JWT_SECRET`                      | auth-service/jitsi   | Shared HMAC key for Jitsi JWT signing/verification.                 |

### Nginx

- Top-level options (TLS profile, WebSocket map, ACME catch-all) live in
  `nginx/conf.d/00-defaults.conf`.
- One vhost file per subdomain in `nginx/conf.d/`. Add a new app by dropping
  in a fourth file with HTTP→HTTPS redirect + `proxy_pass`.
- `nginx/init-certs.sh` runs on every nginx start to seed self-signed
  placeholder certs for any domain whose `live/<domain>/fullchain.pem` is
  missing. To add a new domain, append it to the `DOMAINS` variable in that
  script *and* request a cert via `docker compose run --rm certbot certonly
  ... -d new.example.com`.

### Monitoring

- `monitoring/prometheus.yml` — scrape config.
- `monitoring/loki-config.yml` — Loki single-binary settings.
- `monitoring/promtail-config.yml` — host + Docker log shipping with Docker
  service discovery labels (`service`, `container`, `project`, `logstream`).
- `monitoring/grafana/provisioning/datasources/datasources.yml` — provisioned
  data sources (Loki + Prometheus), no manual UI setup needed.
- `monitoring/grafana/provisioning/dashboards/dashboards.yml` — dashboard
  provisioning provider config.
- `monitoring/grafana/dashboards/loki-overview.json` — prebuilt dashboard
  `Loki — Comm Platform Logs`.

Grafana opens directly with provisioned data sources and a ready log dashboard:

- Dashboard URL: `https://grafana.think-deploy.com/d/comm-platform-loki`
- Service filter labels in LogQL:
  - `{service="nginx"}`
  - `{service="rocketchat"}`
  - `{service=~"jitsi-.*"}`

---

## Credentials

- **Rocket.Chat admin**: created during Rocket.Chat first-run setup wizard.
- **Grafana admin**: from `.env` (`GRAFANA_ADMIN_USER`, `GRAFANA_ADMIN_PASSWORD`).
- **Jitsi access control**: Google OAuth via `auth-service`, restricted by
  `ALLOWED_GOOGLE_DOMAIN`.
- **No secrets in Git**: commit only placeholders in `.env.example`.
- **Do not commit `.env`**: it contains live credentials/secrets.

---

## Known limitations

- Jitsi domain restriction is email-suffix based (`@ALLOWED_GOOGLE_DOMAIN`).
  If you need group-based authorization, add Google Directory / IAM checks.
- First certificate issuance requires clearing placeholder cert directories
  created by `nginx/init-certs.sh`.
- `docker compose logs -f mongo` (assignment wording) does not match this repo's
  service name (`mongodb`); use `docker compose logs -f mongodb`.

---

## Troubleshooting

### Nginx returns `502 Bad Gateway`

A 502 means Nginx received the request but the upstream container did not
respond.

```bash
docker compose ps                                 # is the upstream healthy?
docker compose logs --tail=200 rocketchat         # or jitsi-web / grafana
docker compose logs --tail=100 nginx | grep upstream
docker compose exec nginx wget -qO- http://rocketchat:3000/api/info
```

Common causes:

- The upstream is still starting (Rocket.Chat takes ~1 minute on a cold boot
  while it indexes Mongo).
- The upstream container crashed — check its logs.
- The upstream is on a different network than `nginx`. Every public-facing
  service must be on the `proxy` network alongside `nginx`.

### Certbot challenge fails

```bash
docker compose run --rm certbot certonly \
  --webroot -w /var/www/certbot \
  --email "$LETSENCRYPT_EMAIL" --agree-tos --no-eff-email \
  -d chat.think-deploy.com
```

If you see `Failed authorization procedure` or `Connection refused`:

1. Confirm DNS resolves to the host's public IP:
   `dig +short chat.think-deploy.com`
2. Confirm port 80 is reachable from the public internet (not blocked by a
   security group or upstream firewall).
3. Confirm Nginx is serving the ACME path:
   `curl -I http://chat.think-deploy.com/.well-known/acme-challenge/test`
   should return `404` from Nginx (not `Connection refused`).
4. Confirm the `certbot/www` volume is shared with Nginx — both should mount
   it at `/var/www/certbot`.
5. Check rate limits if you've been retrying often
   (<https://letsencrypt.org/docs/rate-limits/>); use Let's Encrypt's staging
   server while debugging by adding `--staging`.

### Jitsi UDP 10000

Symptoms: rooms join successfully, prejoin shows your camera, but other
participants can't see/hear you (or there's a long delay before media
starts).

```bash
# 1. Container actually publishes the port?
docker compose port jitsi-jvb 10000/udp

# 2. JVB advertises the right public IP?
docker compose exec jitsi-jvb env | grep -iE 'JVB_ADVERTISE|DOCKER_HOST'

# 3. Probe from outside the host (run on a different machine):
nc -u -v <public-ipv4> 10000   # type a few characters; should not refuse

# 4. JVB log — should show "Started ICE Agent" and candidate harvest:
docker compose logs --tail=200 jitsi-jvb | grep -iE 'ice|harvest'
```

Common causes:

- `JVB_ADVERTISE_IPS` not set → JVB advertises an internal Docker IP that
  remote browsers can't reach. Set it to the host's public IPv4 in `.env`
  and restart `jitsi-jvb`.
- Cloud security group / `ufw` does not allow `UDP/10000` inbound.
- A symmetric NAT in front of the host strips the source port. Configure a
  TURN server (out of scope here) or move the host to a network with
  predictable NAT.

### Rocket.Chat can't connect to MongoDB

Symptoms: `rocketchat` keeps restarting, log shows `MongoNetworkError` or
`not master and slaveOk=false`.

```bash
docker compose logs --tail=200 rocketchat
docker compose logs --tail=200 mongodb
docker compose logs mongodb-init
docker compose exec mongodb mongosh --quiet --eval 'rs.status().ok'
```

Common causes:

- The `mongodb-init` one-shot has not finished. It runs `rs.initiate(...)`
  exactly once; until it completes successfully, Rocket.Chat will reject
  any write. Re-run with:
  ```bash
  docker compose up -d --force-recreate mongodb-init
  ```
- The `chat_backend` network is `internal: true`, so Rocket.Chat must be on
  it. Confirm:
  ```bash
  docker inspect rocketchat \
    --format '{{range $k,$_ := .NetworkSettings.Networks}}{{$k}} {{end}}'
  ```
  must include `comm_chat_backend`.
- Volume permissions / corrupt state. As a last resort:
  `docker compose down && docker volume rm comm-platform_mongodb_data`
  (this **erases** the chat database).

### Grafana SMTP alerts don't send

```bash
docker compose exec grafana env | grep ^GF_SMTP_
docker compose logs --tail=200 grafana | grep -i smtp
```

Checklist:

1. `GRAFANA_SMTP_ENABLED=true` in `.env`.
2. `SMTP_HOST` is set as `host:port` (e.g. `smtp.gmail.com:587`); Grafana
   does **not** accept a URL.
3. `SMTP_FROM_ADDRESS` is a real, deliverable address — many providers
   reject mail with arbitrary `From:` headers.
4. `SMTP_USERNAME` / `SMTP_PASSWORD` work for the provider — use an app
   password if 2FA is enabled.
5. After editing `.env`:
   `docker compose up -d grafana`
   so the env vars are re-applied.
6. Test from inside the container:
   ```bash
   docker compose exec grafana grafana-cli admin reset-admin-password test
   # then send a test alert from Alerting -> Contact points -> Test
   ```

### Prometheus targets are DOWN

```bash
docker compose logs --tail=200 prometheus
curl -s http://127.0.0.1:9090/api/v1/targets | jq '.data.activeTargets[] | {scrapeUrl, health, lastError}'
```

Checklist:

1. Target containers are running and healthy (`docker compose ps`).
2. Prometheus config is mounted correctly:
   `docker compose exec prometheus cat /etc/prometheus/prometheus.yml`
3. Service names in `monitoring/prometheus.yml` match compose services.
4. Target is reachable from the `monitoring` network.

### Loki shows no logs

```bash
docker compose logs --tail=200 promtail
docker compose logs --tail=200 loki
curl -s http://127.0.0.1:3100/loki/api/v1/labels
curl -s http://127.0.0.1:3100/loki/api/v1/label/service/values
```

Checklist:

1. `promtail` has Docker socket mounted: `/var/run/docker.sock:/var/run/docker.sock:ro`.
2. Promtail can discover Docker targets (look for `added Docker target` logs).
3. Loki datasource in Grafana points to `http://loki:3100`.
4. Query recent data in Grafana Explore with:
   `{job="docker"}` or `{service="nginx"}`.

---
