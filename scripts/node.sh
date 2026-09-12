#!/usr/bin/env -S -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/bash --noprofile --norc
set -euo pipefail
umask 077

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_directory/.." && pwd -P)"
lock_file="$repository_root/toolchain.lock.json"

fail() {
  /usr/bin/printf 'toolchain error: %s\n' "$1" >&2
  exit 2
}

mode="node"
if [[ "${1-}" == "--tool" ]]; then
  [[ "$#" -ge 3 ]] || fail "package tool mode requires a name and -- separator"
  case "$2" in
    stryker|tsc) mode="$2" ;;
    *) fail "unknown package tool: $2" ;;
  esac
  [[ "$3" == "--" ]] || fail "package tool mode requires -- separator"
  shift 3
  [[ "$#" -ge 1 ]] || fail "package tool mode requires at least one argument"
elif [[ "${1-}" == "--entry" ]]; then
  [[ "$#" -ge 3 ]] || fail "first-party mode requires a name and -- separator"
  [[ "$2" == "sentinel-ts" ]] || fail "unknown first-party tool: $2"
  [[ "$3" == "--" ]] || fail "first-party mode requires -- separator"
  mode="sentinel-ts"
  shift 3
  [[ "$#" -ge 1 ]] || fail "first-party mode requires at least one argument"
elif [[ "${1-}" == "--version" ]]; then
  [[ "$#" -eq 1 ]] || fail "Node version mode accepts no extra arguments"
elif [[ "${1-}" == "--test" ]]; then
  [[ "$#" -ge 2 ]] || fail "Node test mode requires at least one test argument"
else
  fail "unsupported Node mode: ${1-<empty>}"
fi

values="$(/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
  "$lock_file" node --require-locked)"
mapfile -t fields <<<"$values"
node_home="$repository_root/.toolchain/${fields[6]}"
node_binary="$node_home/bin/node"
expected_version="${fields[0]}"

cd -- "$repository_root"
[[ -f .node-version && ! -L .node-version ]] || fail ".node-version is missing"
[[ "$(<.node-version)" == "$expected_version" ]] || fail ".node-version does not match the lock"
[[ -d .toolchain && ! -L .toolchain ]] || fail "verified local toolchain root is missing"
/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
  "$lock_file" node --require-locked --verify-tree "$node_home"

home="$repository_root/.toolchain/home"
xdg_cache="$repository_root/.toolchain/xdg-cache"
for private_directory in "$home" "$xdg_cache"; do
  [[ -d "$private_directory" && ! -L "$private_directory" ]] ||
    fail "private runtime directory is missing: $private_directory"
  [[ "$(/usr/bin/stat -c '%u:%a' -- "$private_directory")" == "$(/usr/bin/id -u):700" ]] ||
    fail "private runtime directory owner or mode mismatch: $private_directory"
done

child_arguments=("$@")
if [[ "$mode" == "tsc" ]]; then
  /usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked --verify-dependencies "$repository_root"
  child_arguments=("$repository_root/node_modules/@typescript/native/lib/tsc.js" "$@")
elif [[ "$mode" == "stryker" ]]; then
  package_tool_entry="$(/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked \
    --resolve-package-tool stryker "$repository_root")"
  child_arguments=("$repository_root/$package_tool_entry" "$@")
elif [[ "$mode" == "sentinel-ts" ]]; then
  first_party_entry="$(/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked \
    --resolve-first-party sentinel-ts "$repository_root")"
  child_arguments=("$repository_root/$first_party_entry" "$@")
elif [[ "${1-}" == "--test" ]]; then
  /usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked --verify-dependencies "$repository_root"
fi

exec /usr/bin/env -i \
  HOME="$home" \
  XDG_CACHE_HOME="$xdg_cache" \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PATH="$node_home/bin:/usr/bin:/bin" \
  "$node_binary" "${child_arguments[@]}"
