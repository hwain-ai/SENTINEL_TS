#!/usr/bin/python3
"""Validate the repository-owned Node.js toolchain lock and installed trees."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform as platform_module
import re
import stat
import sys
from pathlib import Path
from typing import Any, Optional
from urllib.parse import urlsplit


EXPECTED_REPOSITORY = "SENTINEL_TS"
LOCKED_STATUS = "locked"
SHA256_PATTERN = re.compile(r"[0-9a-f]{64}")
SAFE_DIRECTORY_PATTERN = re.compile(r"[A-Za-z0-9][A-Za-z0-9.+_-]*")
NODE_ARCHIVE_HOST = "nodejs.org"
NODE_BINARY = Path("bin/node")
NPM_CLI = Path("lib/node_modules/npm/bin/npm-cli.js")
TSC_ENTRY = Path("node_modules/@typescript/native/lib/tsc.js")
# Platform keys map to the names Node and the TypeScript native package use.
PLATFORM_KEYS = ("linux-x86_64", "linux-aarch64", "darwin-x86_64", "darwin-aarch64")
NODE_PLATFORMS = {
    "linux-x86_64": "linux-x64",
    "linux-aarch64": "linux-arm64",
    "darwin-x86_64": "darwin-x64",
    "darwin-aarch64": "darwin-arm64",
}
PENDING_STATUS = "pending"
PENDING_DIGEST = "pending"


def platform_key(system: Optional[str] = None, machine: Optional[str] = None) -> str:
    """linux-x86_64 | linux-aarch64 | darwin-x86_64 | darwin-aarch64 for this host."""

    system = (system or platform_module.system()).lower()
    machine = (machine or platform_module.machine()).lower()
    if system not in ("linux", "darwin"):
        raise LockError(f"unsupported operating system: {system}")
    if machine in ("x86_64", "amd64"):
        architecture = "x86_64"
    elif machine in ("aarch64", "arm64"):
        architecture = "aarch64"
    else:
        raise LockError(f"unsupported architecture: {machine}")
    return f"{system}-{architecture}"


def tsc_binary(toolchain: dict[str, Any]) -> Path:
    """The TypeScript native binary for the selected platform (legacy flat locks mean Linux x64)."""

    return Path(toolchain.get("tscBinaryPath", "node_modules/@typescript/typescript-linux-x64/lib/tsc"))
STRYKER_ENTRY = Path("node_modules/@stryker-mutator/core/bin/stryker.js")
STRYKER_PACKAGE = "@stryker-mutator/core"
STRYKER_VERSION = "10.0.0"
STRYKER_INTEGRITY = (
    "sha512-ZvMsRyaXQQ5e6Thcid9pkuODv6Fn9E3nrBQJUap+hcJuGJ4unm26afo3m6YKSjn8"
    "kinyxJ/3TXf0cTWRDaTxVw=="
)
STRYKER_RUNNER_PACKAGE = "@stryker-mutator/vitest-runner"
STRYKER_RUNNER_INTEGRITY = (
    "sha512-SHK2/vfvRUpiz7jXPnQMBnr6zLdm69DK03Mo5mPhaZWcRSygrKUqYsPqWsXsK+5y"
    "SHzlMTfCyFK5NQ/X9sJFFw=="
)
SENTINEL_ENTRY = Path("dist/cli.js")
SENTINEL_TREE = Path("dist")


class LockError(ValueError):
    """Raised when locked metadata cannot safely select an executable."""


def _reject_duplicate_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for key, value in pairs:
        if key in result:
            raise LockError(f"duplicate JSON key: {key}")
        result[key] = value
    return result


def _text(mapping: dict[str, Any], key: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value or "\n" in value or "\r" in value:
        raise LockError(f"toolchain lock field {key!r} is missing or invalid")
    return value


def _sha256(mapping: dict[str, Any], key: str) -> str:
    value = _text(mapping, key)
    if SHA256_PATTERN.fullmatch(value) is None:
        raise LockError(f"toolchain lock field {key!r} is not a SHA-256 digest")
    return value


def _load(path: Path) -> dict[str, Any]:
    if path.is_symlink() or not path.is_file():
        raise LockError("toolchain lock must be a regular, non-symlink file")
    try:
        document = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys
        )
    except LockError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise LockError(f"cannot read toolchain lock: {error}") from error
    if not isinstance(document, dict) or document.get("repository") != EXPECTED_REPOSITORY:
        raise LockError("toolchain lock repository identity is invalid")
    if not isinstance(document.get("toolchains"), dict):
        raise LockError("toolchain lock has no toolchains object")
    return document


def _validate_archive_url(value: str, version: str, platform: Optional[str]) -> None:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as error:
        raise LockError("node archive URL is malformed") from error
    node_platforms = [NODE_PLATFORMS[platform]] if platform else list(NODE_PLATFORMS.values())
    expected_paths = {
        f"/download/release/v{version}/node-v{version}-{node_platform}.tar.xz" for node_platform in node_platforms
    }
    if (
        parsed.scheme != "https"
        or parsed.hostname != NODE_ARCHIVE_HOST
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in expected_paths
        or parsed.query
        or parsed.fragment
    ):
        raise LockError("node archive URL is not the approved immutable release URL")


def _for_platform(toolchain: dict[str, Any], platform: Optional[str]) -> tuple[dict[str, Any], Optional[str]]:
    """Merge the platforms[...] entry into the common fields; legacy flat locks pass through."""

    platforms = toolchain.get("platforms")
    if platforms is None:
        return toolchain, None
    if not isinstance(platforms, dict):
        raise LockError("node platforms must be an object")
    key = platform or platform_key()
    entry = platforms.get(key)
    if not isinstance(entry, dict):
        raise LockError(f"node toolchain has no entry for platform {key}")
    merged = {name: value for name, value in toolchain.items() if name != "platforms"}
    merged.update(entry)
    merged["platform"] = key
    return merged, key


def _dependency_digest(toolchain: dict[str, Any], key: str, allow_pending: bool) -> str:
    """A platform's dependency fingerprint, or 'pending' when not yet measured on that platform."""

    value = toolchain.get(key)
    if value == PENDING_DIGEST and toolchain.get("platformStatus") == PENDING_STATUS:
        if allow_pending:
            return PENDING_DIGEST
        raise LockError(f"node platform {toolchain.get('platform')} dependency lock is pending")
    return _sha256(toolchain, key)


def _select(
    document: dict[str, Any], require_locked: bool, platform: Optional[str] = None, allow_pending: bool = False
) -> dict[str, Any]:
    toolchain = document["toolchains"].get("node")
    if not isinstance(toolchain, dict):
        raise LockError("node toolchain is pending")
    toolchain, key = _for_platform(toolchain, platform)
    repository_status = _text(document, "status")
    tool_status = _text(toolchain, "status")
    if require_locked and (repository_status != LOCKED_STATUS or tool_status != LOCKED_STATUS):
        raise LockError(
            "node toolchain is pending: "
            f"repository={repository_status}, tool={tool_status}"
        )
    version = _text(toolchain, "version")
    npm_version = _text(toolchain, "npmVersion")
    archive_url = _text(toolchain, "archiveUrl")
    archive_size = toolchain.get("archiveSize")
    archive_root = _text(toolchain, "archiveRoot")
    install_directory = _text(toolchain, "installDirectory")
    if not SAFE_DIRECTORY_PATTERN.fullmatch(archive_root):
        raise LockError("node archiveRoot is unsafe")
    if not SAFE_DIRECTORY_PATTERN.fullmatch(install_directory):
        raise LockError("node installDirectory is unsafe")
    if not isinstance(archive_size, int) or isinstance(archive_size, bool) or archive_size < 1:
        raise LockError("node archiveSize is invalid")
    _validate_archive_url(archive_url, version, key)
    version_output = _text(toolchain, "versionOutput")
    npm_version_output = _text(toolchain, "npmVersionOutput")
    if version_output != f"v{version}" or npm_version_output != npm_version:
        raise LockError("node or npm version output does not match the selected release")
    for name in (
        "archiveSha256",
        "binarySha256",
        "npmCliSha256",
        "installedTreeSha256",
        "packageLockSha256",
        "tscEntrySha256",
        "emptyConfigSha256",
    ):
        _sha256(toolchain, name)
    for name in ("dependencyTreeSha256", "tscBinarySha256"):
        _dependency_digest(toolchain, name, allow_pending)
    if require_locked and (version != "22.23.1" or npm_version != "10.9.8"):
        raise LockError("node or npm version does not match the approved release")
    _select_stryker(toolchain, require_locked)
    _select_first_party(toolchain, require_locked)
    return toolchain


def _select_stryker(toolchain: dict[str, Any], require_locked: bool) -> dict[str, Any]:
    package_tools = toolchain.get("packageTools")
    if not isinstance(package_tools, dict):
        raise LockError("node packageTools lock is missing")
    stryker = package_tools.get("stryker")
    if not isinstance(stryker, dict):
        raise LockError("StrykerJS package tool is pending")
    status = _text(stryker, "status")
    package = _text(stryker, "package")
    version = _text(stryker, "version")
    integrity = _text(stryker, "integrity")
    runner_package = _text(stryker, "runnerPackage")
    runner_version = _text(stryker, "runnerVersion")
    runner_integrity = _text(stryker, "runnerIntegrity")
    entry = _text(stryker, "entry")
    _sha256(stryker, "entrySha256")
    if entry != STRYKER_ENTRY.as_posix():
        raise LockError("StrykerJS entry is not the approved repository path")
    if require_locked and (
        status != LOCKED_STATUS
        or package != STRYKER_PACKAGE
        or version != STRYKER_VERSION
        or integrity != STRYKER_INTEGRITY
        or runner_package != STRYKER_RUNNER_PACKAGE
        or runner_version != STRYKER_VERSION
        or runner_integrity != STRYKER_RUNNER_INTEGRITY
    ):
        raise LockError("StrykerJS packages do not match the approved releases")
    return stryker


def _select_first_party(toolchain: dict[str, Any], require_locked: bool) -> dict[str, Any]:
    tools = toolchain.get("firstPartyTools")
    if not isinstance(tools, dict):
        raise LockError("node firstPartyTools lock is missing")
    sentinel = tools.get("sentinel-ts")
    if not isinstance(sentinel, dict):
        raise LockError("sentinel-ts first-party tool is pending")
    status = _text(sentinel, "status")
    entry = _text(sentinel, "entry")
    tree = _text(sentinel, "tree")
    _sha256(sentinel, "entrySha256")
    _sha256(sentinel, "treeSha256")
    if entry != SENTINEL_ENTRY.as_posix() or tree != SENTINEL_TREE.as_posix():
        raise LockError("sentinel-ts paths do not match the approved repository paths")
    if require_locked and status != LOCKED_STATUS:
        raise LockError("sentinel-ts first-party tool is pending")
    return sentinel


def _fields(toolchain: dict[str, Any]) -> list[str]:
    names = (
        "version",
        "npmVersion",
        "archiveUrl",
        "archiveSize",
        "archiveSha256",
        "archiveRoot",
        "installDirectory",
        "binarySha256",
        "npmCliSha256",
        "versionOutput",
        "npmVersionOutput",
        "installedTreeSha256",
        "dependencyTreeSha256",
        "packageLockSha256",
        "tscEntrySha256",
        "tscBinarySha256",
        "emptyConfigSha256",
    )
    return [str(toolchain[name]) for name in names]


def _record(digest: Any, kind: bytes, path: bytes, mode: int, payload: bytes) -> None:
    for value in (kind, path, f"{mode:03o}".encode("ascii"), payload):
        digest.update(len(value).to_bytes(8, "big"))
        digest.update(value)


def _file_digest(path: Path) -> bytes:
    digest = hashlib.sha256()
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    try:
        with os.fdopen(descriptor, "rb", closefd=False) as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
    finally:
        os.close(descriptor)
    return digest.digest()


def _tree_entries(root: Path) -> list[Path]:
    entries: list[Path] = []
    for current, directories, files in os.walk(root, topdown=True, followlinks=False):
        current_path = Path(current)
        entries.extend(current_path / name for name in directories)
        entries.extend(current_path / name for name in files)
    return sorted(
        entries, key=lambda item: item.relative_to(root).as_posix().encode("utf-8")
    )


def _tree_digest(root: Path) -> str:
    if root.is_symlink() or not root.is_dir():
        raise LockError("installed tree is missing or is a symlink")
    resolved_root = root.resolve(strict=True)
    digest = hashlib.sha256()
    try:
        entries = _tree_entries(root)
    except (OSError, UnicodeError) as error:
        raise LockError(f"cannot enumerate installed tree: {error}") from error
    for path in entries:
        _add_tree_entry(digest, resolved_root, root, path)
    return digest.hexdigest()


def _add_tree_entry(digest: Any, resolved_root: Path, root: Path, path: Path) -> None:
    relative = path.relative_to(root).as_posix()
    try:
        path_bytes = relative.encode("utf-8")
        metadata = path.lstat()
    except (OSError, UnicodeError) as error:
        raise LockError(f"invalid installed tree entry: {relative!r}") from error
    mode = stat.S_IMODE(metadata.st_mode)
    if stat.S_ISREG(metadata.st_mode):
        _record(digest, b"file", path_bytes, mode, _file_digest(path))
        return
    if stat.S_ISDIR(metadata.st_mode):
        _record(digest, b"directory", path_bytes, mode, b"")
        return
    if stat.S_ISLNK(metadata.st_mode):
        # Symlink modes differ between Linux (777) and macOS (umask-dependent); only the target matters.
        _add_symlink(digest, resolved_root, path, path_bytes, 0o777)
        return
    raise LockError(f"installed tree contains special file: {relative}")


def _add_symlink(
    digest: Any, resolved_root: Path, path: Path, path_bytes: bytes, mode: int
) -> None:
    try:
        target = os.readlink(path)
        target_bytes = target.encode("utf-8")
    except (OSError, UnicodeError) as error:
        raise LockError("installed tree symlink target is invalid") from error
    if os.path.isabs(target):
        raise LockError("installed tree contains an absolute symlink")
    resolved_target = (path.parent / target).resolve(strict=False)
    try:
        resolved_target.relative_to(resolved_root)
    except ValueError as error:
        raise LockError("installed tree symlink escapes its root") from error
    _record(digest, b"symlink", path_bytes, mode, target_bytes)


def _sha256_file(path: Path, label: str) -> str:
    if path.is_symlink() or not path.is_file():
        raise LockError(f"{label} must be a regular, non-symlink file")
    return _file_digest(path).hex()


def _verify_runtime(toolchain: dict[str, Any], root: Path) -> None:
    if _tree_digest(root) != _text(toolchain, "installedTreeSha256"):
        raise LockError("installed Node tree manifest mismatch")
    if _sha256_file(root / NODE_BINARY, "Node binary") != _text(
        toolchain, "binarySha256"
    ):
        raise LockError("Node binary checksum mismatch")
    if _sha256_file(root / NPM_CLI, "npm CLI") != _text(toolchain, "npmCliSha256"):
        raise LockError("npm CLI checksum mismatch")


def _verify_package_lock(toolchain: dict[str, Any], repository: Path) -> None:
    if repository.is_symlink() or not repository.is_dir():
        raise LockError("repository root is missing or is a symlink")
    if _sha256_file(repository / "package-lock.json", "package lock") != _text(
        toolchain, "packageLockSha256"
    ):
        raise LockError("package-lock.json checksum mismatch")


def _verify_dependency_tree(toolchain: dict[str, Any], repository: Path) -> None:
    if _tree_digest(repository / "node_modules") != _text(
        toolchain, "dependencyTreeSha256"
    ):
        raise LockError("installed dependency tree manifest mismatch")
    if _sha256_file(repository / TSC_ENTRY, "TypeScript entry") != _text(
        toolchain, "tscEntrySha256"
    ):
        raise LockError("TypeScript entry checksum mismatch")
    if _sha256_file(repository / tsc_binary(toolchain), "TypeScript binary") != _text(
        toolchain, "tscBinarySha256"
    ):
        raise LockError("TypeScript binary checksum mismatch")


def _verify_dependencies(toolchain: dict[str, Any], repository: Path) -> None:
    _verify_package_lock(toolchain, repository)
    _verify_dependency_tree(toolchain, repository)


def _load_package_lock(repository: Path) -> dict[str, Any]:
    path = repository / "package-lock.json"
    try:
        document = json.loads(
            path.read_text(encoding="utf-8"), object_pairs_hook=_reject_duplicate_keys
        )
    except LockError:
        raise
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        raise LockError(f"cannot read package lock: {error}") from error
    if not isinstance(document, dict) or not isinstance(document.get("packages"), dict):
        raise LockError("package-lock.json has no packages object")
    return document


def _verify_package_record(
    packages: dict[str, Any], package: str, version: str, integrity: str
) -> None:
    record = packages.get(f"node_modules/{package}")
    if not isinstance(record, dict):
        raise LockError(f"locked package is missing: {package}")
    if record.get("version") != version or record.get("integrity") != integrity:
        raise LockError(f"locked package provenance mismatch: {package}")


def _resolve_stryker(toolchain: dict[str, Any], repository: Path) -> str:
    _verify_dependencies(toolchain, repository)
    _resolve_first_party(toolchain, repository)
    stryker = _select_stryker(toolchain, True)
    package_lock = _load_package_lock(repository)
    packages = package_lock["packages"]
    _verify_package_record(
        packages,
        _text(stryker, "package"),
        _text(stryker, "version"),
        _text(stryker, "integrity"),
    )
    _verify_package_record(
        packages,
        _text(stryker, "runnerPackage"),
        _text(stryker, "runnerVersion"),
        _text(stryker, "runnerIntegrity"),
    )
    entry = _text(stryker, "entry")
    if _sha256_file(repository / entry, "StrykerJS entry") != _text(
        stryker, "entrySha256"
    ):
        raise LockError("StrykerJS entry checksum mismatch")
    return entry


def _resolve_first_party(toolchain: dict[str, Any], repository: Path) -> str:
    _verify_dependencies(toolchain, repository)
    sentinel = _select_first_party(toolchain, True)
    tree = _text(sentinel, "tree")
    if _tree_digest(repository / tree) != _text(sentinel, "treeSha256"):
        raise LockError("sentinel-ts compiled tree manifest mismatch")
    entry = _text(sentinel, "entry")
    if _sha256_file(repository / entry, "sentinel-ts entry") != _text(
        sentinel, "entrySha256"
    ):
        raise LockError("sentinel-ts entry checksum mismatch")
    return entry


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("lock", type=Path)
    parser.add_argument("tool", choices=("node",))
    parser.add_argument("--require-locked", action="store_true")
    parser.add_argument("--platform", choices=PLATFORM_KEYS)
    parser.add_argument("--allow-pending", action="store_true")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--verify-tree", type=Path)
    action.add_argument("--print-tree-digest", type=Path)
    action.add_argument("--verify-package-lock", type=Path)
    action.add_argument("--verify-dependency-tree", type=Path)
    action.add_argument("--verify-dependencies", type=Path)
    action.add_argument("--resolve-package-tool", nargs=2, metavar=("NAME", "REPOSITORY"))
    action.add_argument("--resolve-first-party", nargs=2, metavar=("NAME", "REPOSITORY"))
    arguments = parser.parse_args()
    try:
        document = _load(arguments.lock)
        toolchain = _select(document, arguments.require_locked, arguments.platform, arguments.allow_pending)
        if arguments.verify_tree is not None:
            _verify_runtime(toolchain, arguments.verify_tree)
        elif arguments.print_tree_digest is not None:
            print(_tree_digest(arguments.print_tree_digest))
        elif arguments.verify_package_lock is not None:
            _verify_package_lock(toolchain, arguments.verify_package_lock)
        elif arguments.verify_dependency_tree is not None:
            _verify_dependency_tree(toolchain, arguments.verify_dependency_tree)
        elif arguments.verify_dependencies is not None:
            _verify_dependencies(toolchain, arguments.verify_dependencies)
        elif arguments.resolve_package_tool is not None:
            name, repository = arguments.resolve_package_tool
            if name != "stryker":
                raise LockError(f"unknown package tool: {name}")
            print(_resolve_stryker(toolchain, Path(repository)))
        elif arguments.resolve_first_party is not None:
            name, repository = arguments.resolve_first_party
            if name != "sentinel-ts":
                raise LockError(f"unknown first-party tool: {name}")
            print(_resolve_first_party(toolchain, Path(repository)))
        else:
            print("\n".join(_fields(toolchain)))
    except (LockError, OSError) as error:
        print(f"toolchain error: {error}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
