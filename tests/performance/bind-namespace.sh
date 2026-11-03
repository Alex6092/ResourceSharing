#!/usr/bin/env bash
# Unprivileged private mount namespace; never unmounts the real data directory.
set -Eeuo pipefail
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$repo"
mkdir -p .qualification
work="$(mktemp -d "$repo/.qualification/bind-guard.XXXXXXXX")"
cleanup() { [[ "$work" == "$repo/.qualification/bind-guard."* ]] && rm -rf -- "$work"; }
trap cleanup EXIT
mkdir "$work/source" "$work/target"
for area in incoming objects quarantine; do mkdir "$work/source/$area"; done
export BIND_QA_SOURCE="$work/source" BIND_QA_TARGET="$work/target"
export BIND_QA_MARKER="$(node -p 'crypto.randomUUID()')"
printf '%s\n' "$BIND_QA_MARKER" > "$work/source/.mprovi-volume"
unshare --user --map-root-user --mount bash -c '
  set -Eeuo pipefail
  mount --make-rprivate /
  mount --bind "$BIND_QA_SOURCE" "$BIND_QA_TARGET"
  mount -o remount,bind,nodev,nosuid,noexec "$BIND_QA_TARGET"
  BIND_QA_STAGE=mounted node tests/performance/bind-probe.ts
  mount --bind "$BIND_QA_TARGET" "$BIND_QA_TARGET"
  mount -o remount,bind,ro,nodev,nosuid,noexec "$BIND_QA_TARGET"
  mount --bind "$BIND_QA_TARGET/incoming" "$BIND_QA_TARGET/incoming"
  mount -o remount,bind,rw,nodev,nosuid,noexec "$BIND_QA_TARGET/incoming"
  BIND_QA_STAGE=readonly node tests/performance/bind-probe.ts
  umount "$BIND_QA_TARGET/incoming"
  umount "$BIND_QA_TARGET"
  umount "$BIND_QA_TARGET"
  cp -a "$BIND_QA_SOURCE/." "$BIND_QA_TARGET/"
  BIND_QA_STAGE=missing node tests/performance/bind-probe.ts
'
cat > .qualification/bind-namespace.json <<'JSON'
{
  "status": "passed",
  "checks": [
    "production storage readiness on a real private bind mount",
    "API namespace: incoming writable, published objects read-only",
    "missing mount refused even with matching fallback directories and marker"
  ]
}
JSON
