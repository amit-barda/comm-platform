# =============================================================================
# Nginx image — official Alpine base + a startup hook that seeds short-lived
# self-signed certs for every vhost when /etc/letsencrypt/live/<domain> does
# not yet contain real Let's Encrypt material. This keeps nginx able to boot
# on a brand-new host so certbot can then complete an HTTP-01 challenge.
# =============================================================================
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl bash

COPY init-certs.sh /docker-entrypoint.d/00-init-certs.sh
RUN chmod +x /docker-entrypoint.d/00-init-certs.sh
