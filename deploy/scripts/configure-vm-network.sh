#!/usr/bin/env bash
# Address selected for the existing fichiers VM. Run from its root console.
set -Eeuo pipefail
umask 077
[[ $# == 1 && ( $1 == --check || $1 == --apply ) ]] || { echo 'Usage : configure-vm-network.sh --check|--apply' >&2; exit 1; }
[[ "$(cat /sys/class/net/ens18/address)" == d2:a6:fe:89:82:a1 ]] || { echo 'Ce script concerne uniquement la VM fichiers (ens18).' >&2; exit 1; }
[[ "$(. /etc/os-release; echo "$VERSION_ID")" == 13 ]]
python3 - <<'PY'
from pathlib import Path
import re
text = Path('/etc/network/interfaces').read_text()
stanzas = re.findall(r'^iface\s+ens18\s+inet\s+(\S+)', text, re.M)
if stanzas not in (['dhcp'], ['static']):
    raise SystemExit('Configuration ens18 inattendue : aucune modification.')
for file in Path('/etc/network/interfaces.d').glob('*'):
    if file.is_file() and re.search(r'^\s*iface\s+ens18\b', file.read_text(), re.M):
        raise SystemExit('ens18 est aussi défini dans interfaces.d : aucune modification.')
if stanzas == ['static'] and not re.search(r'^\s*address\s+172\.29\.254\.22/16\s*$', text, re.M):
    raise SystemExit('Autre adresse statique déjà configurée : aucune modification.')
PY
echo 'ens18 : 172.29.254.22/16 ; passerelle conservée : 172.29.255.254'
echo 'DNS conservés : 172.20.0.100, 172.20.0.101 ; domaine : laprovidence.local'
[[ $1 == --apply ]] || exit 0
[[ $EUID == 0 && -z ${SSH_CONNECTION:-} ]] || { echo 'Exécuter --apply dans la console root de la VM, pas par SSH.' >&2; exit 1; }
[[ ! -L /etc/network/interfaces && ! -L /etc/resolv.conf ]] || { echo 'Configuration réseau liée à un autre gestionnaire : arrêt.' >&2; exit 1; }
if ip -4 -o address show dev ens18 | grep -q '172\.29\.254\.22/16' && grep -q '^iface ens18 inet static$' /etc/network/interfaces; then
    echo 'Adresse statique déjà appliquée.'; exit 0
fi
ip -4 route show default | grep -q '^default via 172\.29\.255\.254 dev ens18' || { echo 'La passerelle a changé : arrêt.' >&2; exit 1; }
if ! command -v arping > /dev/null; then
    apt-get update
    apt-get install -y iputils-arping
fi
arping -D -q -I ens18 -c 3 -w 5 172.29.254.22 || { echo 'Adresse occupée ou contrôle ARP impossible : aucune modification.' >&2; exit 1; }
backup="$(mktemp -d /root/mprovi-network.XXXXXXXX)"
cp -p /etc/network/interfaces "$backup/interfaces"
cp -p /etc/resolv.conf "$backup/resolv.conf"
python3 - "$backup/interfaces" "$backup/interfaces.new" <<'PY'
from pathlib import Path
import sys
text = Path(sys.argv[1]).read_text()
text = text.replace('iface ens18 inet dhcp', '''iface ens18 inet static
    address 172.29.254.22/16
    gateway 172.29.255.254
    dns-nameservers 172.20.0.100 172.20.0.101
    dns-search laprovidence.local''')
Path(sys.argv[2]).write_text(text)
PY
# ifdown reads the OLD DHCP stanza and stops its dhcpcd instance first.
restore_network() {
    trap - ERR INT TERM
    echo "Échec ; restauration réseau depuis $backup" >&2
    ifdown --force ens18 || true
    cp -p "$backup/interfaces" /etc/network/interfaces
    ifup ens18 || true
    cp -p "$backup/resolv.conf" /etc/resolv.conf
    exit 1
}
trap restore_network ERR INT TERM
ifdown --force ens18
install -o root -g root -m 0644 "$backup/interfaces.new" /etc/network/interfaces
ifup ens18
# No resolvconf dependency: the static stanza no longer starts dhcpcd.
printf '%s\n' 'search laprovidence.local' 'nameserver 172.20.0.100' 'nameserver 172.20.0.101' > /etc/resolv.conf
ip -4 -o address show dev ens18 | grep -q '172\.29\.254\.22/16'
ip -4 route show default | grep -q '^default via 172\.29\.255\.254 dev ens18'
getent ahostsv4 github.com > /dev/null
curl --fail --silent --show-error --head --max-time 20 https://github.com/ > /dev/null
trap - ERR INT TERM
echo "Adresse statique appliquée. Sauvegarde précédente : $backup"
echo 'Nouvel accès SSH : debian@172.29.254.22'
ip -4 -brief address show dev ens18
ip -4 route show default
