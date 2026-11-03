#!/usr/bin/env bash
# Finish the two explicitly selected preparations, without deploying the app.
set -Eeuo pipefail
[[ $EUID == 0 ]] || { echo 'Exécuter depuis la console root.' >&2; exit 1; }
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
install -o root -g root -m 0755 "$repo/deploy/scripts/mprovi-deploy.sh" /usr/local/sbin/mprovi-deploy
bash "$repo/deploy/scripts/prepare-rootdisk-storage.sh"
echo 'Lanceur protégé mis à jour et stockage préparé. Aucun service applicatif démarré.'
