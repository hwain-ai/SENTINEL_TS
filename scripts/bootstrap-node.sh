#!/usr/bin/env -S -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/bash --noprofile --norc
set -euo pipefail
umask 022

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
repository_root="$(cd -- "$script_directory/.." && pwd -P)"
lock_file="$repository_root/toolchain.lock.json"

fail() {
  /usr/bin/printf 'toolchain error: %s\n' "$1" >&2
  exit 2
}

read_lock() {
  /usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked
}

verify_archive() {
  local archive="$1"
  local expected_size="$2"
  local expected_sha256="$3"
  [[ -f "$archive" && ! -L "$archive" ]] || return 1
  [[ "$(/usr/bin/stat -c '%s' -- "$archive")" == "$expected_size" ]] || return 1
  [[ "$(/usr/bin/sha256sum -- "$archive" | /usr/bin/cut -d ' ' -f 1)" == "$expected_sha256" ]]
}

ensure_private_directory() {
  local directory="$1"
  /usr/bin/mkdir -p -- "$directory"
  [[ -d "$directory" && ! -L "$directory" ]] || fail "private path is not a directory: $directory"
  [[ "$(/usr/bin/stat -c '%u' -- "$directory")" == "$(/usr/bin/id -u)" ]] ||
    fail "private path owner mismatch: $directory"
  /usr/bin/chmod 700 -- "$directory"
}

verify_empty_config() {
  local path="$1"
  local expected_sha256="$2"
  if [[ ! -e "$path" && ! -L "$path" ]]; then
    (umask 077 && : >"$path")
  fi
  [[ -f "$path" && ! -L "$path" ]] || fail "npm config must be a regular file: $path"
  [[ "$(/usr/bin/stat -c '%u' -- "$path")" == "$(/usr/bin/id -u)" ]] ||
    fail "npm config owner mismatch: $path"
  /usr/bin/chmod 600 -- "$path"
  [[ "$(/usr/bin/sha256sum -- "$path" | /usr/bin/cut -d ' ' -f 1)" == "$expected_sha256" ]] ||
    fail "npm config checksum mismatch: $path"
}

values="$(read_lock)"
mapfile -t fields <<<"$values"
archive_url="${fields[2]}"
archive_size="${fields[3]}"
archive_sha256="${fields[4]}"
archive_root="${fields[5]}"
install_directory="${fields[6]}"
empty_config_sha256="${fields[16]}"
toolchain_root="$repository_root/.toolchain"
download_directory="$toolchain_root/downloads"
archive="$download_directory/$archive_sha256.tar.xz"
destination="$toolchain_root/$install_directory"
bootstrap_lock="$toolchain_root/bootstrap-node.lock"
archive_part=""
staging=""

cleanup() {
  if [[ -n "$archive_part" && -e "$archive_part" ]]; then
    /usr/bin/rm -f -- "$archive_part"
  fi
  if [[ -n "$staging" && -d "$staging" && ! -L "$staging" ]]; then
    /usr/bin/rm -rf -- "$staging"
  fi
  /usr/bin/rmdir -- "$bootstrap_lock" 2>/dev/null || true
}

cd -- "$repository_root"
if [[ -e "$toolchain_root" || -L "$toolchain_root" ]]; then
  [[ -d "$toolchain_root" && ! -L "$toolchain_root" ]] ||
    fail ".toolchain must be a local directory"
fi
ensure_private_directory "$toolchain_root"
/usr/bin/mkdir -- "$bootstrap_lock" 2>/dev/null ||
  fail "another Node bootstrap is active"
trap cleanup EXIT
ensure_private_directory "$download_directory"
ensure_private_directory "$toolchain_root/home"
ensure_private_directory "$toolchain_root/xdg-cache"
ensure_private_directory "$toolchain_root/npm-cache"
ensure_private_directory "$toolchain_root/npm-config"
verify_empty_config "$toolchain_root/npm-config/user.npmrc" "$empty_config_sha256"
verify_empty_config "$toolchain_root/npm-config/global.npmrc" "$empty_config_sha256"

if [[ -d "$destination" && ! -L "$destination" ]]; then
  /usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
    "$lock_file" node --require-locked --verify-tree "$destination"
  exit 0
fi
[[ ! -e "$destination" && ! -L "$destination" ]] ||
  fail "Node install destination is not an approved directory"

if [[ -e "$archive" || -L "$archive" ]]; then
  verify_archive "$archive" "$archive_size" "$archive_sha256" ||
    fail "cached Node archive checksum mismatch"
else
  archive_part="$(/usr/bin/mktemp "$download_directory/.node-archive.XXXXXX")"
  /usr/bin/curl --fail --location --proto '=https' --proto-redir '=https' \
    --tlsv1.2 --output "$archive_part" "$archive_url"
  verify_archive "$archive_part" "$archive_size" "$archive_sha256" ||
    fail "downloaded Node archive checksum mismatch"
  /usr/bin/mv --no-clobber -- "$archive_part" "$archive"
  archive_part=""
  verify_archive "$archive" "$archive_size" "$archive_sha256" ||
    fail "cached Node archive changed during installation"
fi

staging="$(/usr/bin/mktemp -d "$toolchain_root/.node-staging.XXXXXX")"
/usr/bin/tar --extract --xz --file "$archive" --directory "$staging" \
  --no-same-owner --no-same-permissions
[[ -d "$staging/$archive_root" && ! -L "$staging/$archive_root" ]] ||
  fail "Node archive root is missing"
/usr/bin/python3 -I "$script_directory/toolchain_lock.py" \
  "$lock_file" node --require-locked --verify-tree "$staging/$archive_root"
/usr/bin/mv -- "$staging/$archive_root" "$destination"
/usr/bin/rmdir -- "$staging"
staging=""
