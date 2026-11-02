#!/usr/bin/env bash
# Root console only. Does not format disks, modify Moodle, or register a runner.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Exécuter depuis la console root.' >&2; exit 1; }
[[ $# == 3 || $# == 4 ]] || { echo 'Usage : install-native.sh domaine certificat.pem cle.pem [origine-Moodle]' >&2; exit 1; }
host=$1; certificate=$2; key=$3
moodle_origin="${4:-https://moodle.tspro.fr}"
[[ "$moodle_origin" =~ ^https://[A-Za-z0-9.-]+(:[0-9]+)?$ ]]
[[ "$host" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]+$ && "$certificate" =~ ^/[a-zA-Z0-9/_.-]+$ && "$key" =~ ^/[a-zA-Z0-9/_.-]+$ ]]
[[ -r "$certificate" && -r "$key" ]]
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
[[ "$(. /etc/os-release; echo "$VERSION_ID")" == 13 ]]
mountpoint -q /srv/ressources || { echo 'Monter préalablement le volume dédié à /srv/ressources (nodev,nosuid,noexec).' >&2; exit 1; }
for flag in nodev nosuid noexec; do findmnt -n -o OPTIONS /srv/ressources | tr ',' '\n' | grep -qx "$flag"; done
if [[ ! -e /opt/mprovifilesharing/node && -x /opt/mprovifilesharing/node-v24.22.2-linux-x64/bin/node ]]; then
    ln -s /opt/mprovifilesharing/node-v24.22.2-linux-x64 /opt/mprovifilesharing/node
fi
[[ -x /opt/mprovifilesharing/node/bin/node ]] || { echo 'Créer /opt/mprovifilesharing/node vers une installation Node 24 vérifiée.' >&2; exit 1; }
[[ "$(/opt/mprovifilesharing/node/bin/node -p 'process.versions.node.split(".")[0]')" == 24 ]]
apt-get update
apt-get install -y apache2 libapache2-mod-xsendfile postgresql-17 postgresql-client-17 curl python3 sudo restic
getent group mprovi-read > /dev/null || groupadd --system mprovi-read
getent group mprovi-private > /dev/null || groupadd --system mprovi-private
id mprovi > /dev/null 2>&1 || useradd --system --gid mprovi-read --groups mprovi-private --home-dir /var/lib/mprovi --create-home --shell /usr/sbin/nologin mprovi
id mprovi-build > /dev/null 2>&1 || useradd --system --gid mprovi-read --home-dir /var/lib/mprovi-build --create-home --shell /usr/sbin/nologin mprovi-build
id gha-mprovi > /dev/null 2>&1 || useradd --system --home-dir /var/lib/gha-mprovi --create-home --shell /bin/bash gha-mprovi
usermod -a -G mprovi-read www-data
install -d -o root -g mprovi-read -m 0755 /opt/mprovifilesharing /opt/mprovifilesharing/releases
install -d -o root -g mprovi-private -m 0750 /etc/mprovifilesharing
install -d -o root -g root -m 0755 /usr/local/lib/mprovifilesharing /var/lib/mprovi-deploy
install -d -o gha-mprovi -g gha-mprovi -m 0700 /var/lib/mprovi-deploy/inbox
chown mprovi:mprovi-read /srv/ressources
chmod 0750 /srv/ressources
if [[ ! -e /etc/mprovifilesharing/app.env ]]; then
    [[ ! -e /srv/ressources/.mprovi-volume && ! -L /srv/ressources/.mprovi-volume ]] || { echo 'Un volume initialisé exige sa configuration restaurée.' >&2; exit 1; }
    install -o root -g mprovi-private -m 0640 "$source_dir/deploy/config/app.env.example" /etc/mprovifilesharing/app.env
    marker="$(/opt/mprovifilesharing/node/bin/node -p 'crypto.randomUUID()')"
    session_secret="$(openssl rand -hex 32)"; shared_secret="$(openssl rand -hex 32)"; catalog_secret="$(openssl rand -hex 32)"
    sed -i -e "s|https://files.example.org|https://$host|" -e "s|https://moodle.example.org|$moodle_origin|" \
        -e "s|REPLACE_WITH_UUID|$marker|" -e "s|^SESSION_SECRET=.*|SESSION_SECRET=$session_secret|" \
        -e "s|^MOODLE_SHARED_SECRET=.*|MOODLE_SHARED_SECRET=$shared_secret|" \
        -e "s|^MOODLE_CATALOG_SECRET=.*|MOODLE_CATALOG_SECRET=$catalog_secret|" /etc/mprovifilesharing/app.env
    unset session_secret shared_secret catalog_secret
fi
marker="$(awk -F= '$1=="STORAGE_MARKER"{print $2}' /etc/mprovifilesharing/app.env)"
[[ "$marker" =~ ^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$ ]]
for area in incoming objects quarantine; do [[ ! -L "/srv/ressources/$area" ]] || { echo 'Lien symbolique de stockage refusé.' >&2; exit 1; }; done
if [[ -e /srv/ressources/.mprovi-volume || -L /srv/ressources/.mprovi-volume ]]; then
    [[ ! -L /srv/ressources/.mprovi-volume && "$(cat /srv/ressources/.mprovi-volume)" == "$marker" ]]
else
    [[ ! -d /srv/ressources/objects || -z "$(find /srv/ressources/objects -mindepth 1 -maxdepth 1 -print -quit)" ]]
    printf '%s\n' "$marker" > /srv/ressources/.mprovi-volume
    chown root:mprovi-read /srv/ressources/.mprovi-volume
    chmod 0644 /srv/ressources/.mprovi-volume
fi
install -d -o mprovi -g mprovi-read -m 0700 /srv/ressources/incoming /srv/ressources/quarantine
install -d -o mprovi -g mprovi-read -m 0750 /srv/ressources/objects
if ! runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_roles WHERE rolname='mprovi'" | grep -qx 1; then
    runuser -u postgres -- createuser --no-superuser --no-createdb --no-createrole mprovi
fi
if ! runuser -u postgres -- psql -Atqc "SELECT 1 FROM pg_database WHERE datname='mprovifilesharing'" | grep -qx 1; then
    runuser -u postgres -- createdb --owner=mprovi mprovifilesharing
fi
for unit in "$source_dir"/deploy/systemd/*; do install -o root -g root -m 0644 "$unit" /etc/systemd/system/; done
install -o root -g root -m 0755 "$source_dir/deploy/scripts/mprovi-deploy.sh" /usr/local/sbin/mprovi-deploy
install -o root -g root -m 0644 "$source_dir/deploy/scripts/extract-release.py" /usr/local/lib/mprovifilesharing/extract-release.py
install -o root -g root -m 0644 "$source_dir/deploy/scripts/fetch-validated-release.py" /usr/local/lib/mprovifilesharing/fetch-validated-release.py
printf '%s\n' 'Alex6092/ResourceSharing' > /etc/mprovifilesharing/github-repository
chmod 0644 /etc/mprovifilesharing/github-repository
install -o root -g root -m 0755 "$source_dir/deploy/scripts/backup.sh" /usr/local/lib/mprovifilesharing/backup.sh
printf '%s\n' 'gha-mprovi ALL=(root) NOPASSWD: /usr/local/sbin/mprovi-deploy *' > /etc/sudoers.d/mprovi-deploy
chmod 0440 /etc/sudoers.d/mprovi-deploy
visudo -cf /etc/sudoers.d/mprovi-deploy
sed -e "s|__HOST__|$host|g" -e "s|__CERT__|$certificate|g" -e "s|__KEY__|$key|g" "$source_dir/deploy/apache/mprovifilesharing.conf.template" > /etc/apache2/sites-available/mprovifilesharing.conf
install -o root -g root -m 0644 "$source_dir/deploy/config/logrotate" /etc/logrotate.d/mprovifilesharing
a2enmod ssl headers proxy proxy_http xsendfile reqtimeout
apachectl configtest
systemctl daemon-reload
echo 'Configuration privée et volume préparés. Vérifier app.env, configurer Moodle et la sauvegarde, puis activer le site et les services. Aucun secret affiché.'
