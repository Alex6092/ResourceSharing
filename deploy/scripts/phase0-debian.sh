#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Exécution exclusivement sur une VM Debian 13 de qualification.
# Aucun changement de configuration du service Apache/PostgreSQL existant.
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ "$EUID" -ne 0 ]]; then echo 'Exécuter avec sudo sur une VM de test.' >&2; exit 1; fi
install -d -m 0755 "$repo/test-results"
# Invalider un éventuel succès antérieur dès le début de cette tentative.
printf '{"schemaVersion":1,"phase":0,"status":"blocked","reason":"Prérequis de qualification non validés pour cette tentative."}\n' \
    > "$repo/test-results/phase0-debian.json"
chmod 0644 "$repo/test-results/phase0-debian.json"
source /etc/os-release
if [[ "${ID:-}" != debian || "${VERSION_ID:-}" != 13 ]]; then
    echo 'Debian 13 requis pour qualifier cette architecture.' >&2; exit 1
fi
storage_parent="${1:-}"
if [[ -z "$storage_parent" || ! -d "$storage_parent" ]]; then
    echo 'Usage : sudo bash deploy/scripts/phase0-debian.sh /srv/ressources' >&2; exit 1
fi
storage_parent="$(realpath -- "$storage_parent")"
if [[ "$storage_parent" == / || ! "$storage_parent" =~ ^/[A-Za-z0-9_./-]+$ ]]; then
    echo 'Point de montage explicite sans espaces requis ; racine interdite.' >&2; exit 1
fi
if ! mountpoint -q -- "$storage_parent"; then echo 'Le répertoire doit être un point de montage dédié.' >&2; exit 1; fi
options="$(findmnt -n -o OPTIONS --target "$storage_parent")"
for option in nodev nosuid noexec; do
    if [[ ",$options," != *",$option,"* ]]; then echo "Option de montage requise : $option" >&2; exit 1; fi
done
for command in node npm apache2 openssl runuser findmnt; do
    if ! command -v "$command" >/dev/null; then echo "Prérequis absent : $command" >&2; exit 1; fi
done
if [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then echo 'Node.js 24 requis.' >&2; exit 1; fi
pgbin=/usr/lib/postgresql/17/bin
if [[ ! -x "$pgbin/initdb" || ! -f /usr/lib/apache2/modules/mod_xsendfile.so ]]; then
    echo 'Installer postgresql-17 et libapache2-mod-xsendfile avant ce test.' >&2; exit 1
fi
if [[ ! -d "$repo/node_modules/@tus/server" ]]; then echo 'Exécuter npm ci avant ce test.' >&2; exit 1; fi
id nobody >/dev/null

readonly work="$(mktemp -d /var/tmp/mprovifilesharing-phase0.XXXXXXXX)"
readonly data="$(mktemp -d "$storage_parent/.mprovifilesharing-phase0.XXXXXXXX")"
printf '%s' "$$" > "$work/.owned-by-phase0"
printf '%s' "$$" > "$data/.owned-by-phase0"
chmod 0711 "$work" "$data"
apache_pid=''
pg_started=0
cleanup() {
    trap - EXIT INT TERM
    if [[ -n "$apache_pid" ]]; then
        kill -TERM "$apache_pid" 2>/dev/null || true
        wait "$apache_pid" 2>/dev/null || true
    fi
    # En cas d'arrêt inattendu, nettoyer uniquement les descendants de ce banc.
    for pidfile in "$work"/api-*.pid; do
        [[ -f "$pidfile" ]] || continue
        pid="$(cat -- "$pidfile")"
        if [[ "$pid" =~ ^[0-9]+$ && -r "/proc/$pid/environ" ]] &&
           tr '\0' '\n' < "/proc/$pid/environ" | grep -Fqx "PHASE0_ROOT=$data"; then
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done
    if [[ "$pg_started" == 1 ]]; then
        runuser -u nobody -- "$pgbin/pg_ctl" -D "$work/pgdata" -m immediate -w stop >/dev/null 2>&1 || true
    fi
    if [[ "$work" == /var/tmp/mprovifilesharing-phase0.* && -f "$work/.owned-by-phase0" && "$(cat "$work/.owned-by-phase0")" == "$$" ]]; then
        rm -rf -- "$work"
    fi
    if [[ "$(dirname -- "$data")" == "$storage_parent" && "$(basename -- "$data")" == .mprovifilesharing-phase0.* && -f "$data/.owned-by-phase0" && "$(cat "$data/.owned-by-phase0")" == "$$" ]]; then
        rm -rf -- "$data"
    fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$work/code/tests" "$work/apache/run" "$work/apache/www" "$work/pgdata" "$work/pgsocket"
chmod 0755 "$work/apache" "$work/apache/run" "$work/apache/www"
cp -a -- "$repo/tests/phase0" "$work/code/tests/"
cp -a -- "$repo/node_modules" "$repo/package.json" "$repo/package-lock.json" "$work/code/"
chmod -R a+rX "$work/code"
node "$work/code/tests/phase0/fixture.mjs" "$data"
chown -R nobody:nogroup "$data/incoming" "$data/private" "$data/quarantine" "$work/pgdata" "$work/pgsocket"
chmod 0700 "$work/pgdata" "$work/pgsocket"
runuser -u nobody -- "$pgbin/initdb" -D "$work/pgdata" -A trust --no-locale -E UTF8 > "$work/postgres-init.log"
# Pas de TCP ; socket Unix privé et cluster jetable, aucun compte existant modifié.
runuser -u nobody -- "$pgbin/pg_ctl" -D "$work/pgdata" -l "$work/pgdata/server.log" \
    -o "-k $work/pgsocket -c listen_addresses='' -c max_connections=30 -c shared_buffers=32MB" -w start > /dev/null
pg_started=1

api_port="${PHASE0_PORT:-18731}"
apache_port="${PHASE0_APACHE_PORT:-18443}"
for port in "$api_port" "$apache_port"; do
    if [[ ! "$port" =~ ^[0-9]+$ ]] || (( port < 1024 || port > 65535 )); then echo 'Port invalide.' >&2; exit 1; fi
done
openssl req -x509 -newkey rsa:2048 -noenc -days 1 -subj /CN=localhost \
    -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' \
    -keyout "$work/apache/key.pem" -out "$work/apache/cert.pem" > /dev/null 2>&1
chmod 0644 "$work/apache/cert.pem"
sed -e "s|@WORK@|$work|g" -e "s|@DATA@|$data|g" \
    -e "s|@API_PORT@|$api_port|g" -e "s|@APACHE_PORT@|$apache_port|g" \
    "$repo/deploy/apache/phase0.conf.template" > "$work/apache/httpd.conf"
apache2 -t -f "$work/apache/httpd.conf"
apache2 -f "$work/apache/httpd.conf" -DFOREGROUND &
apache_pid=$!

mkdir -p "$repo/test-results"
export PHASE0_ROOT="$data"
export PHASE0_DATABASE_URL="postgresql://nobody@localhost/postgres?host=$work/pgsocket"
export PHASE0_PUBLIC_ORIGIN="https://127.0.0.1:$apache_port"
export PHASE0_PORT="$api_port"
export PHASE0_RUN_AS=nobody
export PHASE0_WORK="$work"
export PHASE0_REPORT="$repo/test-results/phase0-debian.json"
export NODE_EXTRA_CA_CERTS="$work/apache/cert.pem"

if ! node "$work/code/tests/phase0/debian.test.mjs"; then
    cp -- "$work/apache/error.log" "$repo/test-results/phase0-apache-error.log" || true
    chmod 0644 "$repo/test-results/phase0-apache-error.log" 2>/dev/null || true
    echo 'Qualification non validée. Consulter test-results/phase0-debian.json.' >&2
    exit 1
fi
echo 'Phase 0 validée sur cette VM et ce volume. Rapport : test-results/phase0-debian.json'
