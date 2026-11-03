#!/usr/bin/env bash
# Optional full Moodle 5.2 qualification. User-owned source tree and PHP only.
set -Eeuo pipefail
umask 077
: "${TEST_STORAGE_ROOT:?}" "${DATABASE_URL:?}"
repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd -P)"
source_dir="${MOODLE_SOURCE_DIR:-/home/debian/moodle-qualification-tools/moodle}"
php="${MOODLE_PHP_BINARY:-/home/debian/moodle-qualification-tools/php}"
[[ -f "$source_dir/public/version.php" && -x "$php" ]]
work="$(dirname "$TEST_STORAGE_ROOT")/moodle-qa"
mkdir -m 700 "$work" "$work/source" "$work/data"
cp -a --reflink=auto "$source_dir/." "$work/source/"
[[ ! -f "$work/source/config.php" ]]
cp -a "$repo/moodle/local/filesharing" "$work/source/public/local/"
cp -a "$repo/moodle/lib/editor/tiny/plugins/filesharing" "$work/source/public/lib/editor/tiny/plugins/"
cp -a "$repo/moodle/repository/filesharing" "$work/source/public/repository/"
mkdir -p "$repo/.qualification"
export MOODLE_QA_REPORT="$repo/.qualification/moodle-install.json"
cd "$repo"
node tests/moodle/install-core.mjs "$php" "$work"
