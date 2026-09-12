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

mode="${1-}"
offline="false"
dependency_role=""
dependency_specs=()

is_exact_package() {
  local spec="$1"
  [[ "$spec" =~ ^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]
}

case "$mode" in
  --version)
    [[ "$#" -eq 1 ]] || fail "unsupported npm command arguments"
    ;;
  ci)
    if [[ "$#" -eq 2 && "$2" == "--offline" ]]; then
      offline="true"
    elif [[ "$#" -ne 1 ]]; then
      fail "npm ci accepts only the optional --offline flag"
    fi
    ;;
  lock-add-exact)
    [[ "$#" -ge 2 ]] || fail "lock-add-exact requires --prod or --dev"
    case "$2" in
      --prod) dependency_role="prod" ;;
      --dev) dependency_role="dev" ;;
      *) fail "lock-add-exact requires --prod or --dev" ;;
    esac
    [[ "$#" -ge 3 ]] || fail "lock-add-exact requires at least one exact package version"
    shift 2
    for spec in "$@"; do
      if [[ "$spec" == "--prod" || "$spec" == "--dev" ]]; then
        fail "lock-add-exact accepts a single dependency role"
      fi
      is_exact_package "$spec" || fail "lock-add-exact requires an exact package version: $spec"
      dependency_specs+=("$spec")
    done
    ;;
  *)
    fail "unsupported npm command: ${mode:-<empty>}"
    ;;
esac

cd -- "$repository_root"
[[ ! -e .npmrc && ! -L .npmrc ]] ||
  fail "repository npm configuration is not allowed: .npmrc"

values="$(/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
  "$lock_file" node --require-locked)"
mapfile -t fields <<<"$values"
/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
  "$lock_file" node --require-locked --verify-package-lock "$repository_root"
node_home="$repository_root/.toolchain/${fields[6]}"
node_binary="$node_home/bin/node"
npm_cli="$node_home/lib/node_modules/npm/bin/npm-cli.js"
home="$repository_root/.toolchain/home"
xdg_cache="$repository_root/.toolchain/xdg-cache"
npm_cache="$repository_root/.toolchain/npm-cache"
user_config="$repository_root/.toolchain/npm-config/user.npmrc"
global_config="$repository_root/.toolchain/npm-config/global.npmrc"
empty_config_sha256="${fields[16]}"
execution_directory="$repository_root"
lock_add_directory=""

[[ -d .toolchain && ! -L .toolchain ]] || fail "verified local toolchain root is missing"
/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
  "$lock_file" node --require-locked --verify-tree "$node_home"
for private_directory in "$home" "$xdg_cache" "$npm_cache"; do
  [[ -d "$private_directory" && ! -L "$private_directory" ]] ||
    fail "private npm directory is missing: $private_directory"
  [[ "$(/usr/bin/stat -c '%u:%a' -- "$private_directory")" == "$(/usr/bin/id -u):700" ]] ||
    fail "private npm directory owner or mode mismatch: $private_directory"
done
for config in "$user_config" "$global_config"; do
  [[ -f "$config" && ! -L "$config" ]] || fail "verified empty npm config is missing: $config"
  [[ "$(/usr/bin/stat -c '%u:%a' -- "$config")" == "$(/usr/bin/id -u):600" ]] ||
    fail "npm config owner or mode mismatch: $config"
  [[ "$(/usr/bin/sha256sum -- "$config" | /usr/bin/cut -d ' ' -f 1)" == "$empty_config_sha256" ]] ||
    fail "npm config checksum mismatch: $config"
done

npm_arguments=(
  "--userconfig=$user_config"
  "--globalconfig=$global_config"
  "--cache=$npm_cache"
  "--audit=false"
  "--fund=false"
  "--update-notifier=false"
  "--ignore-scripts"
)
if [[ "$mode" == "--version" ]]; then
  npm_arguments+=("--version")
elif [[ "$mode" == "ci" ]]; then
  [[ "$offline" == "false" ]] || npm_arguments+=("--offline")
  npm_arguments+=("ci")
else
  /usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked --verify-dependencies "$repository_root"
  [[ -f package.json && ! -L package.json ]] ||
    fail "package.json must be a regular, non-symlink file"
  lock_add_directory="$(/usr/bin/mktemp -d "$repository_root/.toolchain/npm-lock-add.XXXXXXXX")"
  trap '/usr/bin/rm -rf -- "$lock_add_directory"' EXIT
  /usr/bin/cp -- package.json package-lock.json "$lock_add_directory/"
  execution_directory="$lock_add_directory"
  npm_arguments+=("install" "--package-lock-only" "--save-exact")
  if [[ "$dependency_role" == "prod" ]]; then
    npm_arguments+=("--save-prod")
  else
    npm_arguments+=("--save-dev")
  fi
  npm_arguments+=("${dependency_specs[@]}")
fi

cd -- "$execution_directory"
/usr/bin/env -i \
  HOME="$home" \
  XDG_CACHE_HOME="$xdg_cache" \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PATH="$node_home/bin:/usr/bin:/bin" \
  "$node_binary" "$npm_cli" "${npm_arguments[@]}"
status="$?"
[[ "$status" -eq 0 ]] || exit "$status"
if [[ "$mode" == "ci" ]]; then
  vite_scratch="$repository_root/node_modules/.vite-temp"
  [[ ! -e "$vite_scratch" && ! -L "$vite_scratch" ]] ||
    fail "npm produced the reserved Vitest scratch path"
  /usr/bin/mkdir --mode=700 -- "$vite_scratch"
  /usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked --verify-dependencies "$repository_root"
elif [[ "$mode" == "lock-add-exact" ]]; then
  [[ -f "$lock_add_directory/package.json" && ! -L "$lock_add_directory/package.json" ]] ||
    fail "npm did not produce a regular package.json"
  [[ -f "$lock_add_directory/package-lock.json" && ! -L "$lock_add_directory/package-lock.json" ]] ||
    fail "npm did not produce a regular package-lock.json"
  /usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked --verify-dependency-tree "$repository_root"
  /usr/bin/mv -- "$lock_add_directory/package.json" "$repository_root/package.json"
  /usr/bin/mv -- "$lock_add_directory/package-lock.json" "$repository_root/package-lock.json"
fi
