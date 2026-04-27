# Jitsi Meet — Integration Notes

> This directory hosts the **official `docker-jitsi-meet` stack** (vendored
> from <https://github.com/jitsi/docker-jitsi-meet>) and is **deliberately
> kept separate** from the root `docker-compose.yml`. The Jitsi compose stack
> is large, fast-moving, and tightly coupled internally; merging it into the
> main stack risks breaking video. We treat it as an **independent unit** and
> wire it to the rest of the platform via host Nginx and the Auth Service.

## Why a separate stack?

- **Upstream complexity.** Jitsi spans `web`, `prosody`, `jicofo`, `jvb`
  (and optional `jibri`, `jigasi`, `etherpad`, `whiteboard`, …), each with
  its own config volume, healthcheck, and network constraints.
- **Versioning.** We pin to an upstream release (`stable-9909` here) and
  re-pull from upstream when needed without touching the rest of the stack.
- **Operational isolation.** A bad upgrade or restart of Jitsi never affects
  Rocket.Chat, the Auth Service, or the monitoring stack.
- **Networking.** Jitsi requires `UDP/10000` for media (JVB). It is far
  simpler to keep its `host`-style port handling in its own compose project.

## How it connects to the rest of the platform

```
                           https://video.think-deploy.com
                                       |
                                       v
                         +---------------------------+
                         |  Host Nginx (on the VM)   |    <- TLS termination + WS
                         |  vhost: video.*.conf      |
                         +-------------+-------------+
                                       |
                                       v http://127.0.0.1:8000
                         +---------------------------+
                         |   jitsi-web (container)   |
                         +---------------------------+
                                       ^
                                       | JWT in URL ?jwt=<token>
                                       |
        https://auth.think-deploy.com/auth/google/callback
                                       ^
                                       |
                         +---------------------------+
                         |  auth-service (root stack)|
                         |  Google OAuth -> JWT      |
                         +---------------------------+
```

1. Browser hits `https://video.think-deploy.com/<room>` (host Nginx, TLS).
2. Nginx proxies to `http://127.0.0.1:8000` → `jitsi-web` container.
3. Jitsi requires a JWT (`ENABLE_AUTH=1`, `AUTH_TYPE=jwt`). When `TOKEN_AUTH_URL`
   is set, Jitsi auto-redirects unauthenticated users to that URL with `{room}`
   substituted.
4. The user is sent to `https://auth.think-deploy.com/auth/google?room=<room>`,
   completes Google OAuth, and the **Auth Service** signs a JWT using
   `JWT_SECRET`. The room name is round-tripped through the OAuth `state`.
5. The browser is redirected back to `https://video.think-deploy.com/<room>?jwt=<token>`.
   Prosody verifies the token using `JWT_APP_SECRET` (which **must equal**
   `JWT_SECRET` in the Auth Service).

The host Nginx vhost lives at `../nginx/video.think-deploy.com.conf` —
**copy/symlink it into `/etc/nginx/sites-available/`** on the VM. **Make sure
the symlink in `sites-enabled/` ends in `.conf`** — see issue #11 in the root
README.

## Files in this directory

- `docker-compose.yml`  — upstream Jitsi compose (do not edit blindly).
- `env.example`         — full upstream variable reference.
- `.env.example`        — **our** trimmed example with the keys we actually
                          set in this deployment. Copy to `.env`.
- `gen-passwords.sh`    — upstream helper to generate Prosody/Jicofo/JVB
                          internal component passwords.
- `web/`, `prosody/`, `jicofo/`, `jvb/`, …  — upstream image build contexts.

## Setup

```bash
cd jitsi
cp .env.example .env
./gen-passwords.sh                    # populates JICOFO_*_PASSWORD, JVB_AUTH_PASSWORD, ...
# edit .env — set PUBLIC_URL, JWT_APP_SECRET (== JWT_SECRET in root .env),
# JVB_ADVERTISE_IPS, TOKEN_AUTH_URL, ...
mkdir -p ~/.jitsi-meet-cfg/{web,transcripts,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri}
docker compose up -d
```

## Critical environment variables

| Variable                  | Notes                                                              |
|---------------------------|--------------------------------------------------------------------|
| `PUBLIC_URL`              | Must equal `https://video.think-deploy.com` (host Nginx vhost).    |
| `HTTP_PORT`               | `8000` — host Nginx proxies to this port on `127.0.0.1`.           |
| `ENABLE_AUTH`/`AUTH_TYPE` | `1` / `jwt` — required so only authenticated JWTs can start rooms. |
| `JWT_APP_ID`              | `thinkdeploy` — must match the JWT `aud` and `iss` claims.         |
| `JWT_APP_SECRET`          | **Must equal** `JWT_SECRET` in the root `.env` (HMAC key).         |
| `JWT_ACCEPTED_ISSUERS`    | `thinkdeploy`.                                                     |
| `JWT_ACCEPTED_AUDIENCES`  | `thinkdeploy`.                                                     |
| `TOKEN_AUTH_URL`          | `https://auth.think-deploy.com/auth/google?room={room}` — auto-redirect. |
| `JVB_ADVERTISE_IPS`       | Public IPv4 of the VM (NAT). UDP/10000 must be open.               |

> The `JWT_SUB` claim signed by the Auth Service must equal the **internal
> XMPP domain** (`meet.jitsi`), not the public URL. See issue #14 in the
> root README.

## DNS / firewall

- DNS `A` record: `video.think-deploy.com` → public IP of this VM.
- TCP `80`, `443` open (host Nginx).
- **UDP `10000`** open (JVB media). Without this, calls connect but have no
  audio/video.
- The host Nginx vhost terminates TLS via Let's Encrypt; we do **not** use
  Jitsi's built-in `ENABLE_LETSENCRYPT`.

## Why no native Google OAuth?

`docker-jitsi-meet` does not ship a "Login with Google" button — its
authentication options are JWT, LDAP, internal accounts, etc. The Auth
Service in this repo (`/auth-service`) bridges Google OAuth to a Jitsi-
compatible JWT, which is the standard pattern for organizational SSO with
self-hosted Jitsi.

## Operations

```bash
# logs
docker compose logs -f web prosody jicofo jvb

# restart after a config change
docker compose down && docker compose up -d

# upgrade Jitsi (stable-XXXX)
git -C .. pull           # if you track upstream
docker compose pull
docker compose up -d
```
