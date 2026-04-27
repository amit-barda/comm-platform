#!/bin/sh
# =============================================================================
# init-certs.sh
# -----------------------------------------------------------------------------
# Runs as part of the nginx image's /docker-entrypoint.d/ on every container
# start. For every domain we proxy, ensure that
#   /etc/letsencrypt/live/<domain>/{fullchain,privkey,chain}.pem
# exists. If it does not, generate a 1-day self-signed placeholder so nginx
# boots and can serve /.well-known/acme-challenge for the first certbot run.
# =============================================================================

set -eu

DOMAINS="chat.think-deploy.com video.think-deploy.com grafana.think-deploy.com"

mkdir -p /var/www/certbot

for domain in $DOMAINS; do
  live="/etc/letsencrypt/live/${domain}"
  fullchain="${live}/fullchain.pem"
  privkey="${live}/privkey.pem"
  chain="${live}/chain.pem"

  if [ -s "$fullchain" ] && [ -s "$privkey" ]; then
    echo "[init-certs] Reusing existing certificate for ${domain}"
    continue
  fi

  echo "[init-certs] Seeding self-signed placeholder for ${domain}"
  mkdir -p "$live"
  openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout "$privkey" \
    -out "$fullchain" \
    -subj "/CN=${domain}" >/dev/null 2>&1
  cp "$fullchain" "$chain"
done
