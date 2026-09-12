#!/usr/bin/env -S -i PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 /usr/bin/bash --noprofile --norc
set -euo pipefail
umask 077

self_script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
self_repository_root="$(cd -- "$self_script_directory/.." && pwd -P)"
self_lock_file="$self_repository_root/toolchain.lock.json"
self_coverage_directory="$self_repository_root/.sentinel-self-coverage"
self_cache_directory="$self_repository_root/.sentinel-self-cache"

clean_self_artifacts() {
  local artifact_directory
  for artifact_directory in "$self_coverage_directory" "$self_cache_directory"; do
    if [[ -d "$artifact_directory" && ! -L "$artifact_directory" ]]; then
      /usr/bin/find "$artifact_directory" -mindepth 1 -depth -delete
      /usr/bin/rmdir -- "$artifact_directory"
    fi
  done
}

trap clean_self_artifacts EXIT
clean_self_artifacts
cd -- "$self_repository_root"

mapfile -t self_lock_fields < <(
  /usr/bin/python3 -I "$self_script_directory/toolchain_lock.py" \
    "$self_lock_file" node --require-locked
)
self_node_home="$self_repository_root/.toolchain/${self_lock_fields[6]}"
self_node_binary="$self_node_home/bin/node"
self_sandbox_home="$self_repository_root/.toolchain/home"
self_xdg_cache="$self_repository_root/.toolchain/xdg-cache"

/usr/bin/python3 -I "$self_script_directory/toolchain_lock.py" \
  "$self_lock_file" node --require-locked --verify-tree "$self_node_home"
/usr/bin/python3 -I "$self_script_directory/toolchain_lock.py" \
  "$self_lock_file" node --require-locked --verify-dependencies "$self_repository_root"
"$self_script_directory/node.sh" --tool tsc -- -p tsconfig.json

/usr/bin/env -i \
  HOME="$self_sandbox_home" \
  XDG_CACHE_HOME="$self_xdg_cache" \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PATH="$self_node_home/bin:/usr/bin:/bin" \
  "$self_node_binary" node_modules/vitest/vitest.mjs run \
    --config scripts/vitest-self.config.mjs --coverage

/usr/bin/env -i \
  HOME="$self_sandbox_home" \
  XDG_CACHE_HOME="$self_xdg_cache" \
  LANG=C.UTF-8 \
  LC_ALL=C.UTF-8 \
  PATH="$self_node_home/bin:/usr/bin:/bin" \
  "$self_node_binary" scripts/self-crap-report.mjs

/usr/bin/python3 -I "$self_script_directory/toolchain_lock.py" \
  "$self_lock_file" node --require-locked --verify-dependencies "$self_repository_root"
