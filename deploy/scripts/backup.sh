#!/usr/bin/env bash
# Executed as mprovi; app.env and backup.env supplied by systemd, never sourced.
set -Eeuo pipefail
umask 077
[[ "$(id -un)" == mprovi ]]
: "${RESTIC_REPOSITORY:?}" "${RESTIC_PASSWORD_FILE:?}" "${DATABASE_URL:?}" "${STORAGE_ROOT:?}"
base=/opt/mprovifilesharing/current
node=/opt/mprovifilesharing/node/bin/node
work="$(mktemp -d /var/lib/mprovi/backup.XXXXXXXX)"
lease=
cleanup() {
    trap - EXIT
    if [[ -n "$lease" ]]; then "$node" "$base/packages/core/src/cli.ts" backup-end "$lease" || true; fi
    [[ "$work" == /var/lib/mprovi/backup.* && -d "$work" ]] && rm -rf -- "$work"
}
trap cleanup EXIT
cd "$base"
lease="$("$node" packages/core/src/cli.ts backup-begin)"
[[ "$lease" =~ ^[a-f0-9-]{36}$ ]]
# The lease prevents all physical purges while the snapshot is assembled.
# Newly published immutable objects may be extra, never missing for the dump.
pg_dump --format=custom --file="$work/catalogue.dump" "$DATABASE_URL"
cp --preserve=mode /etc/mprovifilesharing/app.env "$work/app.env"
printf '%s\n' "$(readlink -f "$base")" > "$work/release-path"
# Finish before the 24h lease expires. Restic repository must be off this VM.
timeout --signal=TERM --kill-after=60 23h restic backup --tag mprovifilesharing --host mprovi \
    "$work" "$STORAGE_ROOT/objects" "$STORAGE_ROOT/.mprovi-volume"
restic check
echo 'Sauvegarde chiffrée terminée et structure du dépôt vérifiée.'
