#!/bin/sh
# Standard tools first so a hostile PATH cannot hide dirname or python3; the launcher itself gives
# every child a clean environment.
PATH="/usr/bin:/bin:${PATH:-}"
export PATH
# Thin wrapper: downloads and verifies the locked Node for this platform. See scripts/toolchain.py.
exec "${SENTINEL_PYTHON:-python3}" -I -B "$(dirname "$0")/toolchain.py" bootstrap
