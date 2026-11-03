#!/usr/bin/env bash
# Root console: reuse the existing root disk, without formatting or allocating
# a second virtual disk. The unmounted target remains empty and root-only.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 ]] || { echo 'Exécuter depuis la console root.' >&2; exit 1; }
source_dir=/var/lib/mprovifilesharing-data
target_dir=/srv/ressources
[[ ! -L "$source_dir" && ! -L "$target_dir" ]]
if [[ -d "$source_dir" && ! -f "$source_dir/.mprovi-bind-storage" ]]; then
    [[ -z "$(find "$source_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'Répertoire source non vide et non identifié ; aucune adoption automatique.' >&2; exit 1; }
fi
if ! mountpoint -q "$target_dir"; then
    if [[ -d "$target_dir" ]]; then
        [[ -z "$(find "$target_dir" -mindepth 1 -maxdepth 1 -print -quit)" ]] || { echo 'Point de montage non vide ; aucune donnée déplacée.' >&2; exit 1; }
    fi
    if [[ ! -f "$source_dir/.mprovi-bind-storage" ]]; then install -d -o root -g root -m 0750 "$source_dir"; fi
    install -d -o root -g root -m 0000 "$target_dir"
else
    [[ "$(findmnt -n -o FSROOT --mountpoint "$target_dir")" == "$source_dir" ]] || { echo 'Un autre volume est déjà monté ; configuration conservée.' >&2; exit 1; }
fi
if [[ -e "$source_dir/.mprovi-bind-storage" || -L "$source_dir/.mprovi-bind-storage" ]]; then
    [[ ! -L "$source_dir/.mprovi-bind-storage" && "$(cat "$source_dir/.mprovi-bind-storage")" == mprovifilesharing-rootdisk-bind-v1 ]]
else
    (set -C; printf '%s\n' 'mprovifilesharing-rootdisk-bind-v1' > "$source_dir/.mprovi-bind-storage")
fi
expected="$source_dir $target_dir none bind,nofail,nodev,nosuid,noexec 0 0"
if awk '$1 !~ /^#/ && $2=="/srv/ressources" {found=1} END {exit !found}' /etc/fstab; then
    grep -Fxq "$expected" /etc/fstab || { echo 'Une autre entrée fstab existe ; vérification manuelle requise.' >&2; exit 1; }
else
    cp --preserve=mode,ownership /etc/fstab "/etc/fstab.before-mprovifilesharing.$(date +%Y%m%d%H%M%S)"
    printf '\n%s\n' "$expected" >> /etc/fstab
fi
if ! mountpoint -q "$target_dir"; then mount --bind "$source_dir" "$target_dir"; fi
mount -o remount,bind,nodev,nosuid,noexec "$target_dir"
for flag in nodev nosuid noexec; do findmnt -n -o OPTIONS --mountpoint "$target_dir" | tr ',' '\n' | grep -qx "$flag"; done
systemctl daemon-reload
echo 'Stockage sur le disque existant préparé, sans formatage. Le service utilisera STORAGE_MODE=bind.'
df -h "$target_dir"
