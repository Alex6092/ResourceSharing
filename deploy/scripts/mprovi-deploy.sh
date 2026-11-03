#!/usr/bin/env bash
# Install root:root 0755 at /usr/local/sbin/mprovi-deploy, never run from runner workspace.
set -Eeuo pipefail
umask 027
[[ $EUID == 0 && $# == 2 && $1 =~ ^[0-9a-f]{40}$ && $2 =~ ^[0-9]{1,20}$ ]] || { echo 'Révision Git ou exécution CI invalide.' >&2; exit 1; }
revision=$1
backup_policy=required
if [[ -e /etc/mprovifilesharing/backup-policy ]]; then
    backup_policy="$(cat /etc/mprovifilesharing/backup-policy)"
fi
[[ "$backup_policy" == required || "$backup_policy" == disabled ]] || { echo 'Politique de sauvegarde invalide.' >&2; exit 1; }
exec 9>/var/lib/mprovi-deploy/deploy.lock
flock -w 600 9
base=/opt/mprovifilesharing
release="$base/releases/$revision"
if [[ -f /var/lib/mprovi-deploy/current-revision && "$(cat /var/lib/mprovi-deploy/current-revision)" == "$revision" ]] \
    && curl -fsS --max-time 3 http://127.0.0.1:3000/health/ready > /dev/null && systemctl is-active --quiet mprovi-worker; then
    echo "Livraison $revision déjà active et saine."; exit 0
fi
[[ ! -e "$release" && ! -L "$release" ]] || { echo 'Cette révision existe déjà ; déploiement refusé.' >&2; exit 1; }
verified="$(mktemp -d /var/lib/mprovi-deploy/verified.XXXXXXXX)"
trap 'rm -rf -- "$verified"' EXIT
python3 /usr/local/lib/mprovifilesharing/fetch-validated-release.py "$revision" "$2" "$verified"
install -d -o root -g mprovi-read -m 0750 "$release"
python3 /usr/local/lib/mprovifilesharing/extract-release.py "$verified" "$release" "$revision"
chown -R mprovi-build:mprovi-build "$release"
# npm scripts disabled; this account cannot read app.env or access storage/DB.
runuser -u mprovi-build -- env PATH="$base/node/bin:/usr/bin:/bin" npm --prefix "$release" ci --omit=dev --ignore-scripts --no-audit --no-fund
chown -R root:mprovi-read "$release"
chmod -R g-w,o-rwx "$release"
find "$release/apps/web/dist" -type d -exec chmod 0755 {} +
find "$release/apps/web/dist" -type f -exec chmod 0644 {} +
previous="$(readlink -f "$base/current" || true)"
if [[ -n "$previous" && -d "$previous" ]]; then
    if [[ "$backup_policy" == required ]]; then
        systemctl start mprovi-backup
    else
        echo 'Sauvegarde automatique désactivée par la configuration root de cette VM.'
    fi
fi
rollback() {
    trap - ERR
    if [[ -n "$previous" && "$previous" == "$base/releases/"* && -d "$previous" ]]; then
        ln -s "$previous" "$base/.previous-link"
        mv -Tf "$base/.previous-link" "$base/current"
        systemctl restart mprovi-api mprovi-worker || true
    fi
    echo 'Échec du déploiement ; version applicative précédente réactivée si disponible. Examiner les migrations avant reprise.' >&2
    exit 1
}
trap rollback ERR
systemctl stop mprovi-worker mprovi-api
ln -s "$release" "$base/.next-link"
mv -Tf "$base/.next-link" "$base/current"
systemctl start mprovi-migrate
systemctl start mprovi-api mprovi-worker
ready=0
for attempt in $(seq 1 40); do
    if curl -fsS --max-time 3 http://127.0.0.1:3000/health/ready > /dev/null && systemctl is-active --quiet mprovi-api && systemctl is-active --quiet mprovi-worker; then ready=1; break; fi
    sleep 1
done
[[ "$ready" == 1 ]]
printf '%s\n' "$revision" > /var/lib/mprovi-deploy/current-revision
echo "Livraison $revision active."
