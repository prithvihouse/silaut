# Deploy Silaut v2 on EC2

The [Silaut demo](https://silaut.com/cashier) uses an Ubuntu EC2 instance with Docker Compose, PostgreSQL, Redis, and Caddy. The instructions below use placeholders for your instance, domain, SSH key, and demo login.

## Prepare a new instance

1. Launch an x86-64 Ubuntu 24.04 instance with enough RAM and disk for the app, PostgreSQL, and an image build. The demo was deployed on a `t3.small` with a 30 GiB root volume.
2. Allow inbound TCP 22 from your own public IPv4 address as a `/32` source. Keep the private key and a verified host key on your Mac. Open TCP 80 and 443 when enabling public HTTPS. The database, cache, and Express ports stay on the internal Compose network.
3. Build a source archive from a committed checkout. In a Mac Bash session, configure SSH for your own instance and upload the archive.

```bash
git archive --format=zip --prefix=silaut/ --output=silaut-v2-rc.zip HEAD
archive="$PWD/silaut-v2-rc.zip"
remote=ubuntu@YOUR_EC2_DNS_OR_IP
ssh_args=(
  -i "$HOME/.ssh/YOUR_EC2_KEY"
  -o IdentitiesOnly=yes
  -o StrictHostKeyChecking=yes
)
scp "${ssh_args[@]}" "$archive" "$remote:silaut-v2-rc.zip"
ssh "${ssh_args[@]}" "$remote"
```

On EC2, install `unzip` if needed. The first block installs Docker. Reconnect after installing it so your session has Docker group membership.

```bash
umask 077
mkdir -p "$HOME/apps"
unzip -tq "$HOME/silaut-v2-rc.zip"
unzip -q "$HOME/silaut-v2-rc.zip" -d "$HOME/apps"
cd "$HOME/apps/silaut"
bash scripts/install-docker-ubuntu.sh
```

In a new SSH session:

```bash
cd "$HOME/apps/silaut"
bash scripts/configure.sh
bash scripts/deploy.sh
```

Enter your own demo password in Terminal. The generated `.env` stays on the server with owner-only permissions. From the Mac, open the tunnel and visit [the tunneled Cashier](http://127.0.0.1:8080/cashier).

```bash
ssh "${ssh_args[@]}" -N -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:8080:127.0.0.1:8080 "$remote"
```

## Enable and verify public HTTPS

Point the domain's DNS record at your instance's public address. On EC2, set `SITE_HOST` to your domain, `ACME_EMAIL` to your certificate contact, and `DEPLOY_MODE=public` in `.env`. Then rerun `bash scripts/deploy.sh`. Caddy obtains and renews the certificate.

From the Mac, substitute your own domain and username:

```bash
domain=YOUR_PUBLIC_DOMAIN
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' "http://$domain/cashier"
for route in /cashier /kitchen /inventory /sales /settings /api/stock /api/settings/profile /api/sales/daily /api/shifts; do
  curl -sS -o /dev/null -w "%{http_code} TLS=%{ssl_verify_result} $route\n" "https://$domain$route"
done
curl -fsS --user YOUR_DEMO_USERNAME "https://$domain/api/profile"
```

Expect an HTTP 308 redirect and HTTPS 401 challenges with certificate validation successful. Enter the demo password at the final command's prompt. Sign in through the browser and check the five workspace screens. The shared login grants access to the management APIs. Use demo data on the public site.

## Back up PostgreSQL

On EC2, run this from the live project directory.

```bash
cd "$HOME/apps/silaut"
umask 077
mkdir -p "$HOME/silaut-backups"
chmod 700 "$HOME/silaut-backups"
dump="$HOME/silaut-backups/silaut-demo-$(date -u +%Y%m%dT%H%M%SZ).dump"
bash scripts/compose.sh exec -T postgres pg_dump -U silaut_owner -d silaut_demo -Fc > "$dump"
test -s "$dump"
bash scripts/compose.sh exec -T postgres pg_restore --file=/dev/null < "$dump"
sha256sum "$dump"
```

Keep dumps outside the Git checkout. From the Mac, use the filename printed by the backup command, copy the dump to an owner-only folder, and compare its checksum.

```bash
umask 077
mkdir -p "$HOME/silaut-backups"
chmod 700 "$HOME/silaut-backups"
dump_name=REPLACE_WITH_DUMP_FILENAME
scp "${ssh_args[@]}" "$remote:silaut-backups/$dump_name" "$HOME/silaut-backups/"
chmod 600 "$HOME/silaut-backups/$dump_name"
LC_ALL=C shasum -a 256 "$HOME/silaut-backups/$dump_name"
```

## Rehearse an upgrade from v1

This procedure assumes v1 is live under `~/apps/silaut` in the `silaut-demo` Compose project. Prefer a disposable instance for experiments. On a shared instance, check disk and memory first and keep the rehearsal in tunnel mode throughout.

On the Mac, reuse the `archive`, `remote`, and `ssh_args` variables from setup. The rehearsal uses a disposable login.

```bash
umask 077
run_id=r$(date -u +%Y%m%dt%H%M%Sz)
local_run=$(mktemp -d /tmp/silaut-rehearsal.XXXXXX)
remote_run="silaut-rehearsals/$run_id"
{
  printf 'silaut-rehearsal\n'
  openssl rand -hex 20
} > "$local_run/login"
hash=$(tail -n 1 "$local_run/login" | htpasswd -nBi silaut-rehearsal)
hash=${hash#*:}
{
  printf 'POSTGRES_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf 'POS_APP_PASSWORD=%s\n' "$(openssl rand -hex 24)"
  printf "BASIC_AUTH_USER=silaut-rehearsal\nBASIC_AUTH_HASH='%s'\n" "$hash"
  printf 'DEPLOY_MODE=tunnel\nSITE_HOST=pos.example.com\nCACHE_MODE=ttl-fenced\n'
} > "$local_run/rehearsal.env"
unset hash

ssh "${ssh_args[@]}" "$remote" "bash -s -- $run_id" <<'REMOTE'
set -euo pipefail
run_id=$1
umask 077
df -h /var/lib/docker
free -m
mkdir -p "$HOME/silaut-rehearsals" "$HOME/silaut-backups"
mkdir -m 700 "$HOME/silaut-rehearsals/$run_id"
cd "$HOME/apps/silaut"
dump="$HOME/silaut-backups/silaut-v1-rehearsal-$run_id.dump"
bash scripts/compose.sh exec -T postgres pg_dump -U silaut_owner -d silaut_demo -Fc > "$dump.part"
test -s "$dump.part"
bash scripts/compose.sh exec -T postgres pg_restore --file=/dev/null < "$dump.part"
mv "$dump.part" "$dump"
sha256sum "$dump"
REMOTE

scp "${ssh_args[@]}" "$archive" "$remote:$remote_run/silaut-v2-rc.zip"
scp "${ssh_args[@]}" "$local_run/rehearsal.env" "$remote:$remote_run/rehearsal.env"
rm "$local_run/rehearsal.env"
ssh "${ssh_args[@]}" "$remote" "bash -s -- $run_id" <<'REMOTE'
set -euo pipefail
export SILAUT_DEPLOY_TARGET=rehearsal SILAUT_REHEARSAL_ID=$1
umask 077
cd "$HOME/silaut-rehearsals/$1"
unzip -tq silaut-v2-rc.zip
unzip -q silaut-v2-rc.zip
install -m 600 rehearsal.env silaut/.env
rm rehearsal.env
cd silaut
bash scripts/stage-v2-ec2.sh 2>&1 | tee ../deploy.log
REMOTE
```

The rehearsal restores the v1 dump, builds a native Linux amd64 image, and runs deployment in a separate project, volume, and image tag. It checks ticket and receipt history, existing stock, migration checksums, and the imported catalog. Caddy publishes only EC2 loopback port 18080.

From the same Mac session, forward the port, run the authenticated workflow, and save the passing report alongside the verified image evidence.

```bash
ssh "${ssh_args[@]}" -fNM -S "$local_run/ssh-control" -o ExitOnForwardFailure=yes \
  -L 127.0.0.1:18080:127.0.0.1:18080 "$remote"
image=$(ssh "${ssh_args[@]}" "$remote" "cat $remote_run/silaut/evidence/verified-image.id")
python3 scripts/check-ec2-rehearsal.py "$run_id" "$image" "$local_run/login" "$local_run"
scp "${ssh_args[@]}" "$local_run/workflow-check.json" "$remote:$remote_run/silaut/evidence/"
```

The check rings up the $22.97 mixed-station order, verifies the identical receipt on retry and seven sale movements, and saves `shift.csv`. Any failure should leave v1 public. Use a fresh rehearsal ID to repeat the full workflow. Exit only this tunnel with `ssh "${ssh_args[@]}" -S "$local_run/ssh-control" -O exit "$remote"`.

## Promote the verified image and verify

Run cutover during a maintenance window after the rehearsal passes. It pauses writes, backs up the original database, restores that backup into a fresh production volume, checks history, and promotes the exact rehearsed image. An error during cutover triggers an attempt to restart the original deployment.

```bash
ssh "${ssh_args[@]}" "$remote" \
  "bash silaut-rehearsals/$run_id/silaut/scripts/cutover-v2-ec2.sh $run_id"
```

Copy `silaut-v1-cutover-$run_id.dump` to the Mac using the backup instructions. Check HTTPS, the unauthenticated routes, and the demo login with the public verification commands above. Keep the v1 image, original database volume, and backup until you have verified the live app.

## Roll back to v1

Use the same Mac variables and the rehearsal ID used for cutover.

```bash
ssh "${ssh_args[@]}" "$remote" \
  "bash silaut-rehearsals/$run_id/silaut/scripts/rollback-v1-ec2.sh $run_id"
```

This restores the saved v1 source, image, and original PostgreSQL volume. Check the HTTP redirect, certificate, and login again. The rollback retains the v2 volume for reviewing changes recorded after cutover.
