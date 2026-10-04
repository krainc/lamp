#!/usr/bin/env bash
#
# Set Lamplink up on a fresh Ubuntu VM. Safe to re-run — it changes only what
# is out of date, so use it for upgrades too.
#
#   ./setup.sh
#
# Expects this repo to be on the VM already, and deploy/config.json to exist.
set -euo pipefail

cd "$(dirname "$0")"
ENV_FILE=".env"

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die() {
  printf '\033[31m%s\033[0m\n' "$*" >&2
  exit 1
}

# --- preflight ---------------------------------------------------------------

[[ -f config.json ]] || die "deploy/config.json is missing.
Generate it on your laptop with \`npm run gen-config\`, fill it in, then copy it here:
  scp config.json ubuntu@YOUR-VM:~/lamplink/deploy/config.json"

if command -v python3 >/dev/null 2>&1; then
  python3 -c 'import json; json.load(open("config.json"))' 2>/dev/null ||
    die "deploy/config.json is not valid JSON."
fi

# --- docker ------------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then
  bold "Installing Docker..."
  sudo apt-get update -qq
  sudo apt-get install -y -qq ca-certificates curl
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" |
    sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  sudo systemctl enable --now docker
  bold "Docker installed."
fi

DOCKER="docker"
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

# --- settings ----------------------------------------------------------------

if [[ -f "$ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  source "$ENV_FILE"
fi

if [[ -z "${SITE_ADDRESS:-}" ]]; then
  echo
  echo "What address will people use to reach Lamplink?"
  echo "  - A hostname you control, e.g. lamps.example.com  (recommended)"
  echo "  - This VM's IP, e.g. $(curl -fsS --max-time 5 ifconfig.me 2>/dev/null || echo 'your.ip.here')"
  echo
  read -rp "  Address: " SITE_ADDRESS
  [[ -n "$SITE_ADDRESS" ]] || die "An address is required."
fi

SITE_ADDRESS="${SITE_ADDRESS#http://}"
SITE_ADDRESS="${SITE_ADDRESS#https://}"
SITE_ADDRESS="${SITE_ADDRESS%%/*}"

if [[ -z "${COOKIE_SECRET:-}" ]]; then
  # /dev/urandom + od rather than openssl: both exist on even a minimal image.
  COOKIE_SECRET="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  bold "Generated a new COOKIE_SECRET."
fi

if [[ -z "${ACME_EMAIL:-}" ]] && [[ ! "$SITE_ADDRESS" =~ ^[0-9.]+$ ]]; then
  read -rp "  Email for certificate expiry notices (optional, Enter to skip): " ACME_EMAIL || true
fi

umask 077
cat >"$ENV_FILE" <<EOF
SITE_ADDRESS=$SITE_ADDRESS
COOKIE_SECRET=$COOKIE_SECRET
ACME_EMAIL=${ACME_EMAIL:-}
LOG_LEVEL=${LOG_LEVEL:-info}
EOF
chmod 600 "$ENV_FILE" config.json

# --- caddy config ------------------------------------------------------------

# A certificate for a bare IP needs Let's Encrypt's "shortlived" profile — it is
# the only one they will issue IP certificates under. Those last six days and
# Caddy renews them automatically, so this is set-and-forget either way.
if [[ "$SITE_ADDRESS" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  bold "Address is a bare IP — requesting an IP certificate (6-day, auto-renewed)."
  warn "A hostname would be sturdier: if this VM's IP ever changes, every"
  warn "bookmarked invite link breaks. A domain costs about \$12/year."
  cat >Caddyfile <<'EOF'
{
	cert_issuer acme {
		profile shortlived
	}
}

{$SITE_ADDRESS} {
	encode zstd gzip
	reverse_proxy lamplink:8080
}
EOF
else
  cat >Caddyfile <<'EOF'
{
	email {$ACME_EMAIL}
}

{$SITE_ADDRESS} {
	encode zstd gzip
	reverse_proxy lamplink:8080
}
EOF
fi

# --- firewall ----------------------------------------------------------------

if command -v ufw >/dev/null 2>&1 && sudo ufw status | grep -q "Status: active"; then
  sudo ufw allow 80/tcp >/dev/null
  sudo ufw allow 443/tcp >/dev/null
  bold "Opened ports 80 and 443 in ufw."
fi

# --- go ----------------------------------------------------------------------

bold "Building and starting..."
$DOCKER compose up -d --build

echo
bold "Waiting for the app to answer..."
for _ in $(seq 1 60); do
  if $DOCKER compose exec -T lamplink node -e \
    'fetch("http://127.0.0.1:8080/healthz").then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))' 2>/dev/null; then
    bold "Lamplink is up."
    break
  fi
  sleep 2
done

SCHEME="https"
echo
echo "   URL:  $SCHEME://$SITE_ADDRESS"
echo
echo "   Certificates can take up to a minute on the first run. If the site"
echo "   doesn't load yet, watch for it:"
echo "     $DOCKER compose logs -f caddy"
echo
echo "   Print everyone's invite links (run on your laptop, in the repo):"
echo "     npm run links -- $SCHEME://$SITE_ADDRESS"
echo
echo "   Logs:     $DOCKER compose logs -f lamplink"
echo "   Restart:  $DOCKER compose restart lamplink"
echo "   Update:   git pull && ./setup.sh"
echo
