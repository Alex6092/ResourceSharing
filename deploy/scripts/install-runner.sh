#!/usr/bin/env bash
# Requires existing gha-mprovi account and root-owned deployment wrapper.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $# == 1 && $1 =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo 'Usage root : install-runner.sh proprietaire/depot' >&2; exit 1; }
repo=$1
id gha-mprovi > /dev/null
[[ -x /usr/local/sbin/mprovi-deploy ]]
version=2.338.2
checksum=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
directory=/var/lib/gha-mprovi/runner
[[ ! -e "$directory/.runner" ]] || { echo 'Runner déjà enregistré.' >&2; exit 1; }
install -d -o gha-mprovi -g gha-mprovi -m 0700 "$directory"
archive="$(mktemp /tmp/mprovi-runner.XXXXXXXX.tar.gz)"
trap 'rm -f -- "$archive"; unset runner_token' EXIT
curl -fL --proto '=https' --tlsv1.2 "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-x64-$version.tar.gz" -o "$archive"
printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check
tar -xzf "$archive" -C "$directory" --no-same-owner
chown -R gha-mprovi:gha-mprovi "$directory"
# Installs the runner's Debian native prerequisites using the official script.
bash "$directory/bin/installdependencies.sh"
token_file=/home/debian/.mprovi-runner-token
if [[ -f "$token_file" && ! -L "$token_file" && "$(stat -c %a "$token_file")" == 600 ]]; then
    runner_token="$(cat -- "$token_file")"
    rm -f -- "$token_file"
else
    read -r -s -p 'Jeton temporaire d’enregistrement GitHub (non journalisé) : ' runner_token
    printf '\n'
fi
[[ "$runner_token" =~ ^[A-Za-z0-9_]+$ ]]
cd "$directory"
runuser -u gha-mprovi -- ./config.sh --unattended --url "https://github.com/$repo" --token "$runner_token" --name mprovi-debian13 --labels mprovi-deploy --work _work
unset runner_token
./svc.sh install gha-mprovi
./svc.sh start
echo 'Runner enregistré. Vérifier ses mises à jour chaque mois et les restrictions de l’environnement production sur main.'
