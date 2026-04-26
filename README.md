# Collaboration Platform Deployment

## Overview

This project deploys an open-source collaboration stack on an Ubuntu cloud VM: **Rocket.Chat** for team chat and **Jitsi Meet** for video, both exposed on HTTPS under dedicated subdomains. **Authentication** is implemented using **Google OAuth 2.0** and a small **Node.js** service that issues **JWTs** for Jitsi, together with **Nginx** as a reverse proxy and **Let’s Encrypt (Certbot)** for TLS certificates. Everything runs on **Docker** and **Docker Compose**, split by component directories, with secrets in `.env` files that are **not** committed to Git.

## Assignment requirements

- Rocket.Chat at `chat.think-deploy.com` (or equivalent)
- Jitsi Meet at `video.think-deploy.com` (or equivalent)
- Organizational access control via **Google SSO / OAuth2**
- Optional: **SMTP** for alerts and password recovery
- Optional: **Observability** with Grafana and Loki (this repo also includes Prometheus and Promtail)

## Implementation status

| Requirement | Status | Notes |
|-------------|--------|--------|
| Rocket.Chat (chat) | Completed | `rocketchat/docker-compose.yml` — MongoDB + Rocket.Chat, `ROOT_URL` → `https://chat.think-deploy.com` |
| Jitsi Meet (video) | Completed | `jitsi/docker-compose.yml` — docker-jitsi-meet stack, JWT auth |
| Google OAuth / SSO | Completed (video) / Partial (chat) | **Video:** `auth/` service (Passport Google) issues JWTs for Jitsi. **Chat:** no OAuth config in Git; complete OAuth / domain restriction via Rocket.Chat admin UI |
| SMTP integration | Not implemented / Skipped | No SMTP configured for Rocket.Chat or other services |
| Grafana, Loki, monitoring | Completed | `monitoring/docker-compose.yml` — Loki, Promtail, Grafana, Prometheus, Node Exporter. Nginx for Grafana: `grafana.think-deploy.com` |

**Short summary:** Rocket.Chat, Jitsi, the Google+JWT auth service, Nginx, TLS, and Docker are wired as in this repository. SMTP is not implemented. The observability stack (Grafana/Loki/…) is present in the repo and can be deployed per environment.

## System architecture

- **OS:** Ubuntu on a cloud VM.
- **Containers:** Docker Engine and Docker Compose for Rocket.Chat + MongoDB, Jitsi (web, prosody, jicofo, jvb, …), the `auth` Node.js service, and optionally the `monitoring` stack.
- **Nginx:** HTTPS reverse proxy; each subdomain forwards to the correct local port on `127.0.0.1`.
- **Let’s Encrypt / Certbot:** TLS certificates for `chat`, `video`, `auth`, `grafana` as needed.
- **Rocket.Chat + MongoDB:** Chat application and database.
- **Jitsi Meet:** WebRTC conferencing with **JWT** auth (validated against `JWT_APP_SECRET` in Jitsi’s `.env`).
- **Auth service (Node.js):** Google OAuth without sessions; after login a JWT is signed (same secret and claim shape Jitsi expects) and the browser is redirected into the video flow.
- **Google:** OAuth 2.0 identity provider.

### ASCII diagram (as deployed)

```
                    Internet
                        |
                        v
              DNS (e.g. Cloudflare)
                        |
                        v
            Nginx (Reverse Proxy) + TLS 443
                        |
     +------------------+--------------------+------------------+
     |                  |                    |                  |
     v                  v                    v                  v
chat.think-deploy.com  video...        auth...          grafana...
     |                  |                    |                  |
     v                  v                    v                  v
 Rocket.Chat:3000   Jitsi web:8000   Node auth:3001   Grafana:3002
 (Docker)            (Docker)         (Docker)         (Docker)
  |                    |                    |
 MongoDB                |                    +-------> Google OAuth
 (Docker)                \
                           +--> (JWT verified in Prosody/Jitsi)
```

**Note:** Additional Jitsi services (JVB, Prosody, Jicofo, etc.) run in Docker but are omitted from the diagram for clarity.

## Service URLs

- **Rocket.Chat:** [https://chat.think-deploy.com](https://chat.think-deploy.com)
- **Jitsi Meet:** [https://video.think-deploy.com](https://video.think-deploy.com)
- **Auth service (when enabled):** [https://auth.think-deploy.com](https://auth.think-deploy.com)
- **Grafana (optional, when enabled):** [https://grafana.think-deploy.com](https://grafana.think-deploy.com)

## Project components

- **Rocket.Chat:** Chat server; depends on MongoDB with a replica set (see `rocketchat/docker-compose.yml`). `ROOT_URL` points at the public HTTPS URL.
- **Jitsi Meet:** docker-jitsi-meet deployment; `AUTH_TYPE=jwt` and `ENABLE_AUTH=1` so JWTs signed by `auth` are accepted (`.env` must match).
- **Nginx:** Example vhosts under `nginx/sites-available/`. On the server: symlink into `sites-enabled`, `nginx -t`, reload.
- **Certbot / Let’s Encrypt:** Issue certs per subdomain; Nginx references `fullchain.pem` / `privkey.pem` under `/etc/letsencrypt/live/<name>/`.
- **Google OAuth:** Web application in Google Cloud; redirect URI: `https://auth.think-deploy.com/auth/google/callback`. Client ID and secret live in **environment variables only**.
- **Docker Compose:** Each stack has its own `docker-compose.yml`; there is no single mega-compose file—easier to operate and upgrade piece by piece.
- **`.env.example` files:** At repo root, `auth/app/`, `monitoring/`, and `jitsi/.env.production.example` (plus upstream `jitsi/env.example`) — **placeholders only**, no real secrets.

## Installation and deployment steps

1. **Install dependencies (example — Ubuntu):**
   ```bash
   sudo apt update
   sudo apt install -y docker.io docker-compose-plugin nginx certbot python3-certbot-nginx git
   sudo usermod -aG docker "$USER"   # log out and back in
   ```
2. **Clone the repository (after it is on GitHub):**
   ```bash
   git clone <YOUR_REPO_URL>
   cd comm-platform
   ```
3. **Copy environment files:**
   - `cp auth/app/.env.example auth/app/.env`
   - `cp jitsi/.env.production.example jitsi/.env` (edit further using `jitsi/env.example` as reference)
   - `cp monitoring/.env.example monitoring/.env` (if using Grafana)
   - `cp rocketchat/.env.example rocketchat/.env` (if needed)
4. **Fill in `.env` values:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `JWT_SECRET` (**same value** as `JWT_APP_SECRET` in Jitsi), domains, Jitsi `PUBLIC_URL`, etc.
5. **Start services (from each directory, in order):**
   ```bash
   cd rocketchat && docker compose up -d
   cd ../jitsi && docker compose up -d
   cd ../auth/app && docker compose up -d
   cd ../monitoring && docker compose up -d   # optional
   ```
6. **Nginx:** Copy or adapt `nginx/sites-available/*.conf` into `/etc/nginx/sites-available/`, enable symlinks in `sites-enabled`, `sudo nginx -t`, `sudo systemctl reload nginx`.
7. **TLS:** e.g. `sudo certbot --nginx -d chat.think-deploy.com -d video.think-deploy.com -d auth.think-deploy.com` (add `grafana` if used).
8. **Browser validation:** Open `https://chat…` and `https://video…` after stacks are up; test OAuth at `https://auth…/auth/google`.

**Important (Jitsi):** Allow TCP 80/443, **UDP 10000** for media, and SSH in the security group / firewall. Set `JVB_ADVERTISE_IPS` to the public IP when behind NAT.

## Google OAuth / SSO

- Create an OAuth **Web application** in Google Cloud Console.
- Configure an exact **Redirect URI:** `https://auth.think-deploy.com/auth/google/callback` — any mismatch causes `redirect_uri_mismatch`.
- Store `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `auth/app/.env` (never in Git).
- Flow: user hits `/auth/google` → Google → callback → service signs JWT → redirect to Jitsi with the JWT.
- **Do not** commit OAuth client secrets, JWT signing keys, or admin passwords.

Typical placeholders:

```env
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
JWT_SECRET=
ALLOWED_DOMAIN=
```

(`ALLOWED_DOMAIN` is a suggested future extension for email-domain filtering; current `auth/app/app.js` relies on Google app settings and policy.)

## Challenges encountered

1. **Docker Compose availability**  
   **Problem:** Some hosts lack the `docker compose` plugin or run an old version.  
   **Solution:** Install `docker-compose-plugin` from Docker’s packages, or use a standalone `docker-compose` binary if required by policy. Verify with `docker compose version`.

2. **Nginx and HTTPS for multiple subdomains**  
   **Problem:** Each backend listens on a different localhost port; browsers should only see port 443 with SNI.  
   **Solution:** One `server` block per `server_name`, `proxy_pass` to the matching `127.0.0.1:PORT`, Certbot-managed SSL blocks.

3. **Google OAuth callback mismatch**  
   **Problem:** Login fails if the redirect URL in Google Cloud does not exactly match the server path.  
   **Solution:** Set redirect to `https://auth.think-deploy.com/auth/google/callback` and keep `callbackURL` in code aligned (see `auth/app/app.js`).

4. **Jitsi authentication complexity**  
   **Problem:** Jitsi does not ship with “click Google and you’re in” like a SaaS product; org auth is usually JWT, LDAP, etc.  
   **Solution:** External Node service performs Google OAuth, signs a JWT matching `JWT_APP_ID` / `JWT_APP_SECRET` / issuers / audiences in Prosody; Jitsi validates it. Users follow an entry/redirect flow (e.g. `/test?jwt=...` in this implementation).

5. **Environment variables and secrets**  
   **Problem:** Leaking keys into Git compromises the whole auth story.  
   **Solution:** Local `.env`, `.env.example` templates, and `.gitignore` rules for secrets and keys.

6. **Firewall and networking**  
   **Problem:** Video breaks without UDP or with wrong advertised IP.  
   **Solution:** Open UDP 10000; set `JVB_ADVERTISE_IPS` to the public IP on cloud/NAT setups.

7. **DNS**  
   **Problem:** Let’s Encrypt and Google redirects need A/AAAA records pointing at the server before validation.  
   **Solution:** Create records for `chat`, `video`, `auth` (and `grafana` if used).

## Security

- Secrets live in `.env` only; those files are **not** in the repository.
- **HTTPS** is enabled for all public entrypoints.
- **No** Rocket.Chat / Grafana admin credentials are stored in Git.
- **OAuth** and JWT appear in the repo only as empty examples (`*.example`).
- **`.gitignore`** covers `node_modules`, logs, `.pem`, `letsencrypt/`, and similar.

## Credentials

**No** admin credentials or passwords are committed. If a third party needs access for review, share credentials over a private channel — **not** on GitHub.

## Not implemented

- **SMTP** (alerts, password reset, etc.) — **not** configured; document when/if you add it in production.
- **Rocket.Chat org-only restriction** — not encoded as Git-tracked config; prefer OAuth/SAML or Google workspace policy in admin UI.
- **`auth` service:** no `ALLOWED_DOMAIN` filtering in the current code (possible future enhancement).

## Validation commands

```bash
docker ps
docker compose ps
sudo nginx -t
systemctl status nginx
curl -I https://chat.think-deploy.com
curl -I https://video.think-deploy.com
curl -I https://auth.think-deploy.com
```

As needed:

```bash
journalctl -u nginx -e
docker logs <container_name>
```

## Directory layout

```
comm-platform/
├── .env.example                 # Pointers to per-stack .env.example files
├── .gitignore
├── README.md
├── nginx/
│   └── sites-available/         # Example vhosts (chat, video, auth, grafana)
├── rocketchat/
│   ├── docker-compose.yml       # MongoDB + Rocket.Chat
│   ├── .env.example
│   └── ...                      # Additional upstream / compose files
├── jitsi/
│   ├── docker-compose.yml
│   ├── env.example
│   ├── .env.production.example
│   └── ...                      # docker-jitsi-meet upstream tree
├── auth/
│   ├── app/
│   │   ├── app.js               # Google OAuth + JWT for Jitsi
│   │   ├── Dockerfile
│   │   ├── docker-compose.yml
│   │   └── .env.example
│   └── node_modules/            # Not in Git (local dev outside Docker)
└── monitoring/
    ├── docker-compose.yml
    ├── prometheus/
    ├── loki/
    ├── promtail/
    └── .env.example
```

## Summary

This repository demonstrates a **production-style** deployment of open-source collaboration tools: Rocket.Chat, Jitsi Meet, secure **HTTPS** exposure, **Google OAuth** plus **JWT** for video identity, **Nginx** reverse proxy, **Let’s Encrypt** automation, and **Docker Compose** + **environment-based** configuration—without committing secrets, consistent with modern DevOps practice.
