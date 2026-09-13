#!/usr/bin/bash
# First-run preparation for the TypeScript checker: pinned Node, locked npm
# dependencies, the compiled dist tree and a doctor pass. Safe to rerun; each
# step verifies before it downloads anything.
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")/.." && pwd -P)"
"$root/scripts/bootstrap-node.sh"
if ! "$root/scripts/npm.sh" ci --offline; then
  printf 'sentinel-tool: locked packages are not cached, installing from the lock file online\n' >&2
  "$root/scripts/npm.sh" ci
fi
# A fresh dist tree (files 600, directories 700 under the launcher's umask) is what the lock fingerprints.
rm -rf "$root/dist"
"$root/scripts/node.sh" --tool tsc -- -p tsconfig.json
"$root/scripts/node.sh" --entry sentinel-ts -- doctor >/dev/null
printf 'sentinel-tool: typescript checker ready\n' >&2
