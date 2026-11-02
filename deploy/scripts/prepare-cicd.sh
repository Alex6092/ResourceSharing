#!/usr/bin/env bash
# Can run before DNS/certificate/storage provisioning. Does not start the app.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Exécuter depuis la console root.' >&2; exit 1; }
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
apt-get update
apt-get install -y sudo curl python3
id gha-mprovi > /dev/null 2>&1 || useradd --system --home-dir /var/lib/gha-mprovi --create-home --shell /bin/bash gha-mprovi
install -d -o root -g root -m 0755 /usr/local/lib/mprovifilesharing /var/lib/mprovi-deploy /etc/mprovifilesharing
install -d -o gha-mprovi -g gha-mprovi -m 0700 /var/lib/mprovi-deploy/inbox
for helper in extract-release.py fetch-validated-release.py; do install -o root -g root -m 0644 "$repo/deploy/scripts/$helper" "/usr/local/lib/mprovifilesharing/$helper"; done
install -o root -g root -m 0755 "$repo/deploy/scripts/mprovi-deploy.sh" /usr/local/sbin/mprovi-deploy
printf '%s\n' 'Alex6092/ResourceSharing' > /etc/mprovifilesharing/github-repository
chmod 0644 /etc/mprovifilesharing/github-repository
printf '%s\n' 'gha-mprovi ALL=(root) NOPASSWD: /usr/local/sbin/mprovi-deploy *' > /etc/sudoers.d/mprovi-deploy
chmod 0440 /etc/sudoers.d/mprovi-deploy
visudo -cf /etc/sudoers.d/mprovi-deploy
bash "$repo/deploy/scripts/install-runner.sh" Alex6092/ResourceSharing
