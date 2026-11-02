#!/usr/bin/env bash
set -Eeuo pipefail
umask 022

# À exécuter depuis une console root de la VM de qualification, après relecture.
# Ne modifie pas sudo, SSH, les partitions ou /etc/fstab.
if [[ "$EUID" -ne 0 || "${1:-}" != --scratch-loopback ]]; then
    echo 'Usage (root, VM de test) : bash bootstrap-phase0-debian.sh --scratch-loopback' >&2
    exit 1
fi
source /etc/os-release
if [[ "${ID:-}" != debian || "${VERSION_ID:-}" != 13 ]]; then echo 'Debian 13 requis.' >&2; exit 1; fi
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
if [[ "$repo" != /home/debian/mprovifilesharing ]]; then
    echo 'Ce script est réservé au dépôt de qualification /home/debian/mprovifilesharing.' >&2; exit 1
fi
if [[ "$(stat -c %U "$repo")" != debian ]]; then echo 'Le dépôt doit appartenir à debian.' >&2; exit 1; fi

fresh_apache=0
fresh_postgres=0
dpkg-query -W -f='${Status}' apache2 2>/dev/null | grep -q 'install ok installed' || fresh_apache=1
dpkg-query -W -f='${Status}' postgresql-17 2>/dev/null | grep -q 'install ok installed' || fresh_postgres=1
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y apache2 libapache2-mod-xsendfile postgresql-17 \
    openssl ca-certificates wget xz-utils e2fsprogs util-linux
# Les paquets peuvent démarrer leurs services par défaut. Arrêter uniquement ceux
# nouvellement installés ici ; le banc utilise des instances privées sur loopback.
if [[ "$fresh_apache" == 1 ]]; then systemctl stop apache2.service; fi
if [[ "$fresh_postgres" == 1 ]]; then systemctl stop postgresql@17-main.service; fi

case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) echo 'Architecture Node non prise en charge par ce script.' >&2; exit 1 ;;
esac
download="$(mktemp -d /var/tmp/mprovi-node-download.XXXXXXXX)"
cleanup_download() {
    if [[ "$download" == /var/tmp/mprovi-node-download.* && -d "$download" ]]; then rm -rf -- "$download"; fi
}
trap cleanup_download EXIT
wget --https-only --timeout=30 --tries=2 -q -O "$download/SHASUMS256.txt" \
    https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt
mapfile -t artifacts < <(grep -E "^[0-9a-f]{64} +node-v24\.[0-9]+\.[0-9]+-linux-${arch}\.tar\.xz$" "$download/SHASUMS256.txt")
if [[ "${#artifacts[@]}" != 1 ]]; then echo 'Manifeste officiel Node 24 inattendu.' >&2; exit 1; fi
read -r checksum archive <<< "${artifacts[0]}"
version="${archive%-linux-*}"
version="${version#node-}"
wget --https-only --timeout=30 --tries=2 -q -O "$download/$archive" "https://nodejs.org/dist/$version/$archive"
printf '%s  %s\n' "$checksum" "$archive" | (cd "$download" && sha256sum -c -)

node_base=/opt/mprovifilesharing
if [[ -L "$node_base" ]]; then echo 'Répertoire Node symbolique refusé.' >&2; exit 1; fi
install -d -o root -g root -m 0755 "$node_base"
node_dir="$node_base/${archive%.tar.xz}"
if [[ -e "$node_dir" ]]; then
    if [[ -L "$node_dir" || "$(stat -c %u "$node_dir")" != 0 || ! -x "$node_dir/bin/node" ]]; then
        echo 'Installation Node existante non reconnue.' >&2; exit 1
    fi
else
    tar --extract --xz --file "$download/$archive" --directory "$node_base" --no-same-owner
fi
export PATH="$node_dir/bin:$PATH"
if [[ "$(node --version)" != "$version" ]]; then echo 'Version Node installée incohérente.' >&2; exit 1; fi
runuser -u debian -- env PATH="$PATH" npm ci --prefix "$repo" --ignore-scripts --no-audit --no-fund

# Un fichier de 1 Gio sur le disque existant, jamais un périphérique bloc brut.
# Il sert seulement à la faisabilité, pas aux essais de débit ou de plus de 50 Go.
storage_base=/var/lib/mprovifilesharing-qualification
storage_mount=/srv/mprovifilesharing-qualification
if [[ -L "$storage_base" || -L "$storage_mount" ]]; then echo 'Chemin de stockage symbolique refusé.' >&2; exit 1; fi
if [[ -e "$storage_base" && ! -f "$storage_base/.created-by-mprovi-bootstrap" ]]; then
    echo 'Répertoire de stockage préexistant non reconnu ; aucune modification.' >&2; exit 1
fi
install -d -o root -g root -m 0700 "$storage_base"
printf '%s\n' 'scratch-loopback-1GiB' > "$storage_base/.created-by-mprovi-bootstrap"
image="$storage_base/storage.ext4"
if [[ -L "$image" ]]; then echo 'Image symbolique refusée.' >&2; exit 1; fi
if [[ ! -e "$image" ]]; then
    truncate --size 1G "$image"
    chmod 0600 "$image"
    mkfs.ext4 -q -F "$image"
    blkid -s UUID -o value "$image" > "$storage_base/storage.uuid"
fi
if [[ ! -f "$storage_base/storage.uuid" || "$(blkid -s UUID -o value "$image")" != "$(cat "$storage_base/storage.uuid")" ]]; then
    echo 'Image existante non reconnue ; aucun formatage.' >&2; exit 1
fi
if [[ ! -d "$storage_mount" ]]; then install -d -o root -g root -m 0755 "$storage_mount"; fi
if mountpoint -q "$storage_mount"; then
    source="$(findmnt -n -o SOURCE --mountpoint "$storage_mount")"
    if ! losetup -j "$image" -n -O NAME | grep -Fqx "$source"; then
        echo 'Un autre volume occupe le point de montage ; aucune modification.' >&2; exit 1
    fi
else
    if [[ -n "$(find "$storage_mount" -mindepth 1 -maxdepth 1 -print -quit)" ]]; then
        echo 'Le point de montage doit être vide.' >&2; exit 1
    fi
    mount -o loop,nodev,nosuid,noexec "$image" "$storage_mount"
fi

echo 'Prérequis prêts. Lancement du banc Apache/PostgreSQL isolé.'
bash "$repo/deploy/scripts/phase0-debian.sh" "$storage_mount"
echo 'Rapport disponible dans /home/debian/mprovifilesharing/test-results/phase0-debian.json'
