#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ -e .env ]];then echo '.env already exists; keeping all secrets. Edit it with nano .env when enabling DNS.';exit 0;fi
umask 077
read -r -p 'Hostname for public HTTPS [pos.example.com]: ' host
host=${host:-pos.example.com}
[[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || { echo 'Enter a hostname without https:// or a path.';exit 1; }
read -r -p 'Email for HTTPS certificate notices [optional for local use]: ' email
[[ -z "$email" || "$email" =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]] || { echo 'A valid email is required.';exit 1; }
read -r -p 'Local demo username [demo]: ' user
user=${user:-demo}
[[ "$user" =~ ^[a-zA-Z0-9_-]+$ ]] || { echo 'Use letters, numbers, underscore or hyphen.';exit 1; }
read -r -s -p 'Demo password (at least 14 characters): ' password;printf '\n'
[[ ${#password} -ge 14 ]] || { echo 'Use at least 14 characters.';exit 1; }
read -r -s -p 'Repeat password: ' repeated;printf '\n'
[[ "$password" == "$repeated" ]] || { echo 'Passwords do not match.';exit 1; }
# Plaintext is sent through stdin, never a command argument or a repository file.
hash=$(printf '%s\n' "$password" | docker run --rm -i caddy:2.10.2-alpine caddy hash-password)
unset password repeated
[[ "$hash" == '$2'* ]] || { echo 'Caddy did not return a bcrypt hash.';exit 1; }
owner=$(openssl rand -hex 32)
app=$(openssl rand -hex 32)
{
 printf 'POSTGRES_PASSWORD=%s\nPOS_APP_PASSWORD=%s\n' "$owner" "$app"
 printf "BASIC_AUTH_USER=%s\nBASIC_AUTH_HASH='%s'\n" "$user" "$hash"
 printf 'DEPLOY_MODE=tunnel\nSITE_HOST=%s\nACME_EMAIL=%s\nCACHE_MODE=ttl-fenced\nCACHE_TTL_SECONDS=10\n' "$host" "$email"
} > .env
echo 'Created private .env. Credentials stayed in this terminal. Next: bash scripts/deploy.sh'
