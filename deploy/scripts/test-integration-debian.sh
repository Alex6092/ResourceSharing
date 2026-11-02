#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
if [[ "$EUID" == 0 ]]; then echo 'Exécuter comme utilisateur debian, sans sudo.' >&2; exit 1; fi
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
pgbin=/usr/lib/postgresql/17/bin
command -v node >/dev/null
[[ -x "$pgbin/initdb" ]] || { echo 'PostgreSQL 17 requis.' >&2; exit 1; }
scratch_parent=/tmp
if [[ "${1:-tests}" == large ]]; then scratch_parent="$repo/.qualification"; mkdir -p "$scratch_parent"; fi
readonly scratch="$(mktemp -d "$scratch_parent/mprovi-integration.XXXXXXXX")"
printf '%s' "$$" > "$scratch/.owned-by-integration"
started=0
cleanup() {
    trap - EXIT
    if [[ "$started" == 1 ]]; then "$pgbin/pg_ctl" -D "$scratch/pg" -m immediate -w stop >/dev/null 2>&1 || true; fi
    if [[ "$scratch" == "$scratch_parent/mprovi-integration."* && -f "$scratch/.owned-by-integration" && "$(cat "$scratch/.owned-by-integration")" == "$$" ]]; then rm -rf -- "$scratch"; fi
}
trap cleanup EXIT
mkdir "$scratch/pg" "$scratch/socket" "$scratch/storage"
"$pgbin/initdb" -D "$scratch/pg" -A trust --no-locale -E UTF8 > "$scratch/init.log"
"$pgbin/pg_ctl" -D "$scratch/pg" -l "$scratch/pg/server.log" -o "-k $scratch/socket -c listen_addresses='' -c max_connections=60 -c shared_buffers=64MB" -w start > /dev/null
started=1
"$pgbin/createdb" -h "$scratch/socket" mprovi_test_runtime
export DATABASE_URL="postgresql://$(id -un)@localhost/mprovi_test_runtime?host=$scratch/socket"
export TEST_STORAGE_ROOT="$scratch/storage"
cd "$repo"
case "${1:-tests}" in
    tests) npm run test:integration ;;
    demo) npm run dev:fixture ;;
    large) CONFIRM_LARGE_TEST=WRITE_50_GIB TEST_REPORT_FILE="$repo/.qualification/large-upload.json" node tests/performance/large-upload.ts ;;
    apache) mkdir -p "$repo/.qualification"; TEST_REPORT_FILE="$repo/.qualification/apache-app.json" node tests/performance/apache-app.ts ;;
    *) echo 'Mode attendu : tests, demo, large ou apache.' >&2; exit 1 ;;
esac
