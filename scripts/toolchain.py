#!/usr/bin/env python3
"""Cross-platform launcher for the checker's locked Node.js, npm and TypeScript.

Replaces the Linux-only shell launchers. Runs on Linux and macOS (x86_64 and
arm64) with the host's Python 3.9+ and the standard library only.

    scripts/toolchain.py bootstrap                     download, verify and install the locked Node
    scripts/toolchain.py setup                         bootstrap, npm ci, build dist, version
    scripts/toolchain.py node --version
    scripts/toolchain.py node --tool tsc|stryker -- ARGS...
    scripts/toolchain.py node --entry sentinel-ts -- ARGS...
    scripts/toolchain.py node --test ARGS...
    scripts/toolchain.py npm --version | ci [--offline] | lock-add-exact --prod|--dev SPEC...
    scripts/toolchain.py platform                      print the detected platform key
    scripts/toolchain.py describe PLATFORM             (maintenance) lock fields for a Node archive
    scripts/toolchain.py describe-dependencies         (maintenance) dependency fingerprints on this host

Every child process gets a minimal environment: no inherited variables, a
private HOME and caches under .toolchain, and PATH limited to the locked Node.
"""
from __future__ import annotations

import sys

# The launcher may run under any interpreter; callers pass -I -B so no bytecode lands anywhere.
sys.dont_write_bytecode = True

import os  # noqa: E402

# Everything the launcher creates or lets a child create is private, as the shell launchers had it.
os.umask(0o077)

import hashlib  # noqa: E402
import json  # noqa: E402
import platform as platform_module  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tarfile  # noqa: E402
import tempfile  # noqa: E402
import urllib.request  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any, Dict, List, Optional, Sequence  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parent))
import toolchain_lock  # noqa: E402

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
LOCK_FILE = REPOSITORY_ROOT / "toolchain.lock.json"
TOOLCHAIN_ROOT = REPOSITORY_ROOT / ".toolchain"
PRIVATE_DIRECTORIES = ("home", "xdg-cache", "npm-cache", "npm-config", "downloads")
NPM_CONFIG_FILES = ("user.npmrc", "global.npmrc")
BOOTSTRAP_LOCK = TOOLCHAIN_ROOT / "bootstrap-node.lock"
VITE_SCRATCH = REPOSITORY_ROOT / "node_modules" / ".vite-temp"
EXACT_PACKAGE = re.compile(
    r"^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*@[0-9]+\.[0-9]+\.[0-9]+"
    r"(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$"
)
USAGE = "usage: toolchain.py {bootstrap|setup|node|npm|platform|describe|describe-dependencies} ..."


class ToolchainError(RuntimeError):
    pass


def fail(message: str) -> ToolchainError:
    return ToolchainError(f"toolchain error: {message}")


# ---------------------------------------------------------------- platform

def platform_key(system: Optional[str] = None, machine: Optional[str] = None) -> str:
    if (system or platform_module.system()).lower() == "windows":
        raise ToolchainError("toolchain error: native Windows is not supported; run SENTINEL inside WSL2")
    try:
        return toolchain_lock.platform_key(system, machine)
    except toolchain_lock.LockError as error:
        raise fail(str(error)) from error


def select(key: Optional[str] = None, allow_pending: bool = False) -> Dict[str, Any]:
    document = toolchain_lock._load(LOCK_FILE)
    try:
        return toolchain_lock._select(document, True, key or platform_key(), allow_pending)
    except toolchain_lock.LockError as error:
        raise fail(str(error)) from error


# ------------------------------------------------------------------ files

def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _private_directory(path: Path) -> None:
    if path.is_symlink():
        raise fail(f"private directory is a symlink: {path}")
    path.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path, 0o700)


def _download(entry: Dict[str, Any]) -> Path:
    """Fetch the locked archive once into .toolchain/downloads, verifying size and SHA-256."""

    downloads = TOOLCHAIN_ROOT / "downloads"
    _private_directory(downloads)
    archive = downloads / (entry["archiveSha256"] + ".tar.xz")
    if archive.is_file() and archive.stat().st_size == entry["archiveSize"] and _sha256_file(archive) == entry["archiveSha256"]:
        return archive
    partial = archive.with_suffix(".partial")
    if partial.exists():
        partial.unlink()
    request = urllib.request.Request(entry["archiveUrl"], headers={"User-Agent": "sentinel-toolchain/1"})
    with urllib.request.urlopen(request, timeout=120) as response, open(partial, "wb") as stream:
        shutil.copyfileobj(response, stream, 1024 * 1024)
    os.chmod(partial, 0o600)
    if partial.stat().st_size != entry["archiveSize"]:
        partial.unlink()
        raise fail("archive size mismatch")
    if _sha256_file(partial) != entry["archiveSha256"]:
        partial.unlink()
        raise fail("archive checksum mismatch")
    os.replace(partial, archive)
    return archive


def _stays_under_root(name: str, parts: Sequence[str], root_name: str) -> bool:
    absolute = name.startswith("/") or name.startswith("\\")
    return bool(parts) and not absolute and ".." not in parts and parts[0] == root_name


def _safe_member(member: tarfile.TarInfo, root_name: str) -> Optional[str]:
    parts = Path(member.name).parts
    if not _stays_under_root(member.name, parts, root_name):
        raise fail(f"archive entry escapes or leaves the expected root: {member.name}")
    if len(parts) == 1:
        return None
    if member.type not in (tarfile.DIRTYPE, tarfile.SYMTYPE, tarfile.REGTYPE, tarfile.AREGTYPE):
        raise fail(f"archive entry has an unsupported type: {member.name}")
    return "/".join(parts[1:])


# The Node tree keeps the conventional 755/644 modes the lock was first taken with; only the
# archive's execute bit survives, so every platform extracts to the same fingerprint.
DIRECTORY_MODE = 0o755


def _normalized_mode(member: tarfile.TarInfo) -> int:
    if member.isdir():
        return DIRECTORY_MODE
    return 0o755 if member.mode & 0o111 else 0o644


def _extract_entry(tar: tarfile.TarFile, member: tarfile.TarInfo, target: Path) -> None:
    if member.isdir():
        target.mkdir(mode=DIRECTORY_MODE, exist_ok=True)
        return
    target.parent.mkdir(mode=DIRECTORY_MODE, parents=True, exist_ok=True)
    source = tar.extractfile(member)
    if source is None:
        raise fail(f"archive entry is unreadable: {member.name}")
    with open(target, "wb") as stream:
        shutil.copyfileobj(source, stream, 1024 * 1024)
    os.chmod(target, _normalized_mode(member))


def _inside(root: Path, candidate: Path) -> bool:
    try:
        return os.path.commonpath((str(root), str(candidate))) == str(root)
    except ValueError:
        return False


def _create_symlink(root: Path, target: Path, link: str) -> None:
    if link.startswith("/"):
        raise fail(f"archive symlink is absolute: {target}")
    target.parent.mkdir(mode=DIRECTORY_MODE, parents=True, exist_ok=True)
    os.symlink(link, target)
    if not _inside(root.resolve(), target.resolve()):
        target.unlink()
        raise fail(f"archive symlink escapes its root: {target}")


def _set_directory_modes(root: Path, mode: int) -> None:
    for current, directories, _files in os.walk(root):
        for name in directories:
            path = Path(current) / name
            if not path.is_symlink():
                os.chmod(path, mode)


def extract(archive: Path, root_name: str, destination: Path) -> None:
    """Extract the archive's root directory with normalized modes (755 dirs, 644/755 files)."""

    destination.mkdir(mode=DIRECTORY_MODE)
    symlinks: List[tuple] = []
    with tarfile.open(archive, "r:xz") as tar:
        for member in tar:
            relative = _safe_member(member, root_name)
            if relative is None:
                continue
            if member.issym():
                symlinks.append((destination / relative, member.linkname))
            else:
                _extract_entry(tar, member, destination / relative)
    for target, link in symlinks:
        _create_symlink(destination, target, link)
    _set_directory_modes(destination, DIRECTORY_MODE)


# ------------------------------------------------------------ environment

def _node_home(entry: Dict[str, Any]) -> Path:
    return TOOLCHAIN_ROOT / entry["installDirectory"]


def _child_environment(entry: Dict[str, Any]) -> Dict[str, str]:
    return {
        "HOME": str(TOOLCHAIN_ROOT / "home"),
        "XDG_CACHE_HOME": str(TOOLCHAIN_ROOT / "xdg-cache"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "PATH": os.pathsep.join([str(_node_home(entry) / "bin"), "/usr/bin", "/bin"]),
    }


def _version_output(argv: Sequence[str], environment: Dict[str, str]) -> str:
    completed = subprocess.run(
        list(argv), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env=environment, check=False, text=True,
    )
    if completed.returncode != 0:
        raise fail(f"{Path(argv[0]).name} --version failed")
    return completed.stdout.splitlines()[0].strip() if completed.stdout else ""


def _verify_private_runtime(entry: Dict[str, Any]) -> None:
    for name in ("home", "xdg-cache"):
        directory = TOOLCHAIN_ROOT / name
        if directory.is_symlink() or not directory.is_dir():
            raise fail(f"private runtime directory is missing: {directory}")
        if (directory.stat().st_mode & 0o777) != 0o700 or directory.stat().st_uid != os.getuid():
            raise fail(f"private runtime directory owner or mode mismatch: {directory}")
    node_version = REPOSITORY_ROOT / ".node-version"
    if node_version.is_symlink() or not node_version.is_file():
        raise fail(".node-version is missing")
    if node_version.read_text(encoding="utf-8").strip() != entry["version"]:
        raise fail(".node-version does not match the lock")


def _verify_installed(entry: Dict[str, Any], check_version: bool) -> Path:
    home = _node_home(entry)
    if home.is_symlink() or not home.is_dir():
        raise fail("verified local Node tree is missing; run scripts/toolchain.py bootstrap")
    try:
        toolchain_lock._verify_runtime(entry, home)
    except toolchain_lock.LockError as error:
        raise fail(str(error)) from error
    if check_version:
        environment = _child_environment(entry)
        node = home / toolchain_lock.NODE_BINARY
        if _version_output([str(node), "--version"], environment) != entry["versionOutput"]:
            raise fail("node version output mismatch")
        npm = home / toolchain_lock.NPM_CLI
        if _version_output([str(node), str(npm), "--version"], environment) != entry["npmVersionOutput"]:
            raise fail("npm version output mismatch")
    return home


# -------------------------------------------------------------- bootstrap

def _prepare_private_files(entry: Dict[str, Any]) -> None:
    _private_directory(TOOLCHAIN_ROOT)
    for name in PRIVATE_DIRECTORIES:
        _private_directory(TOOLCHAIN_ROOT / name)
    for name in NPM_CONFIG_FILES:
        path = TOOLCHAIN_ROOT / "npm-config" / name
        if not path.exists():
            path.write_bytes(b"")
        os.chmod(path, 0o600)
        if _sha256_file(path) != entry["emptyConfigSha256"]:
            raise fail(f"npm config checksum mismatch: {path}")


def bootstrap(allow_pending: bool = True) -> Path:
    """Install the locked Node for this platform; an already-verified tree is left alone."""

    entry = select(allow_pending=allow_pending)
    _prepare_private_files(entry)
    home = _node_home(entry)
    try:
        BOOTSTRAP_LOCK.mkdir(mode=0o700)
    except FileExistsError:
        raise fail("another Node bootstrap is active") from None
    try:
        if home.exists() or home.is_symlink():
            return _verify_installed(entry, check_version=False)
        archive = _download(entry)
        staging = Path(tempfile.mkdtemp(prefix=".staging-node-", dir=TOOLCHAIN_ROOT))
        try:
            extracted = staging / "tree"
            extract(archive, entry["archiveRoot"], extracted)
            toolchain_lock._verify_runtime(entry, extracted)
            os.rename(extracted, home)
        finally:
            shutil.rmtree(staging, ignore_errors=True)
    except toolchain_lock.LockError as error:
        raise fail(str(error)) from error
    finally:
        BOOTSTRAP_LOCK.rmdir()
    return _verify_installed(entry, check_version=True)


# ------------------------------------------------------------------- node

def _require_argument(arguments: List[str], message: str) -> None:
    if not arguments:
        raise fail(message)


def _split_tool_arguments(arguments: List[str], label: str) -> tuple:
    """NAME -- ARGS... for --tool and --entry."""

    if len(arguments) < 2:
        raise fail(f"{label} mode requires a name and -- separator")
    if arguments[1] != "--":
        raise fail(f"{label} mode requires -- separator")
    if len(arguments) < 3:
        raise fail(f"{label} mode requires at least one argument")
    return arguments[0], arguments[2:]


def _parse_node_mode(arguments: List[str]) -> tuple:
    """(mode, name, rest) for the launcher's closed set of Node modes; grammar only, no file access."""

    _require_argument(arguments, "unsupported Node mode: <empty>")
    mode = arguments[0]
    if mode == "--version":
        if len(arguments) != 1:
            raise fail("Node version mode accepts no extra arguments")
        return mode, None, []
    if mode == "--test":
        if len(arguments) < 2:
            raise fail("Node test mode requires at least one test argument")
        return mode, None, arguments[1:]
    if mode == "--tool":
        name, rest = _split_tool_arguments(arguments[1:], "package tool")
        if name not in ("tsc", "stryker"):
            raise fail(f"unknown package tool: {name}")
        return mode, name, rest
    if mode == "--entry":
        name, rest = _split_tool_arguments(arguments[1:], "first-party")
        if name != "sentinel-ts":
            raise fail(f"unknown first-party tool: {name}")
        return mode, name, rest
    raise fail(f"unsupported Node mode: {mode}")


def _node_command(entry: Dict[str, Any], mode: str, name: Optional[str], rest: List[str]) -> List[str]:
    node = str(_node_home(entry) / toolchain_lock.NODE_BINARY)
    if mode == "--version":
        return [node, "--version"]
    if mode == "--test":
        _verify_dependencies(entry)
        return [node, "--test", *rest]
    if mode == "--tool":
        return [node, _package_tool_entry(entry, name or ""), *rest]
    return [node, _first_party_entry(entry, name or ""), *rest]


def _verify_dependencies(entry: Dict[str, Any]) -> None:
    try:
        toolchain_lock._verify_dependencies(entry, REPOSITORY_ROOT)
    except toolchain_lock.LockError as error:
        raise fail(str(error)) from error


def _package_tool_entry(entry: Dict[str, Any], name: str) -> str:
    if name == "tsc":
        _verify_dependencies(entry)
        return str(REPOSITORY_ROOT / toolchain_lock.TSC_ENTRY)
    if name == "stryker":
        try:
            return str(REPOSITORY_ROOT / toolchain_lock._resolve_stryker(entry, REPOSITORY_ROOT))
        except toolchain_lock.LockError as error:
            raise fail(str(error)) from error
    raise fail(f"unknown package tool: {name}")


def _first_party_entry(entry: Dict[str, Any], name: str) -> str:
    if name != "sentinel-ts":
        raise fail(f"unknown first-party tool: {name}")
    try:
        return str(REPOSITORY_ROOT / toolchain_lock._resolve_first_party(entry, REPOSITORY_ROOT))
    except toolchain_lock.LockError as error:
        raise fail(str(error)) from error


# -------------------------------------------------------------------- npm

def _npm_base(entry: Dict[str, Any]) -> List[str]:
    home = _node_home(entry)
    return [
        str(home / toolchain_lock.NODE_BINARY),
        str(home / toolchain_lock.NPM_CLI),
        f"--userconfig={TOOLCHAIN_ROOT / 'npm-config' / 'user.npmrc'}",
        f"--globalconfig={TOOLCHAIN_ROOT / 'npm-config' / 'global.npmrc'}",
        f"--cache={TOOLCHAIN_ROOT / 'npm-cache'}",
        "--audit=false",
        "--fund=false",
        "--update-notifier=false",
        "--ignore-scripts",
    ]


def _reject_repository_npm_config() -> None:
    npmrc = REPOSITORY_ROOT / ".npmrc"
    if npmrc.exists() or npmrc.is_symlink():
        raise fail("repository npm configuration is not allowed: .npmrc")


def _verify_npm_private_files(entry: Dict[str, Any]) -> None:
    for name in ("home", "xdg-cache", "npm-cache", "npm-config"):
        directory = TOOLCHAIN_ROOT / name
        if directory.is_symlink() or not directory.is_dir() or (directory.stat().st_mode & 0o777) != 0o700:
            raise fail(f"private npm directory owner or mode mismatch: {directory}")
    for name in NPM_CONFIG_FILES:
        config = TOOLCHAIN_ROOT / "npm-config" / name
        if config.is_symlink() or not config.is_file() or (config.stat().st_mode & 0o777) != 0o600:
            raise fail(f"npm config owner or mode mismatch: {config}")
        if _sha256_file(config) != entry["emptyConfigSha256"]:
            raise fail(f"npm config checksum mismatch: {config}")


def _lock_add_specs(arguments: List[str]) -> tuple:
    if not arguments or arguments[0] not in ("--prod", "--dev"):
        raise fail("lock-add-exact requires --prod or --dev")
    specs = arguments[1:]
    if not specs:
        raise fail("lock-add-exact requires at least one exact package version")
    for spec in specs:
        if spec in ("--prod", "--dev"):
            raise fail("lock-add-exact accepts a single dependency role")
        if not EXACT_PACKAGE.match(spec):
            raise fail(f"lock-add-exact requires an exact package version: {spec}")
    return arguments[0], specs


def _run_npm(entry: Dict[str, Any], arguments: Sequence[str], cwd: Path) -> int:
    completed = subprocess.run([*_npm_base(entry), *arguments], cwd=str(cwd), env=_child_environment(entry), check=False)
    return completed.returncode


def _npm_ci(entry: Dict[str, Any], arguments: List[str]) -> int:
    status = _run_npm(entry, [*arguments, "ci"], REPOSITORY_ROOT)
    if status != 0:
        return status
    if VITE_SCRATCH.exists() or VITE_SCRATCH.is_symlink():
        raise fail("npm produced the reserved Vitest scratch path")
    VITE_SCRATCH.mkdir(mode=0o700)
    if entry.get("dependencyTreeSha256") == toolchain_lock.PENDING_DIGEST:
        print("toolchain: dependency fingerprints are pending for this platform; run describe-dependencies", file=sys.stderr)
        return 0
    _verify_dependencies(entry)
    return 0


def _npm_lock_add(entry: Dict[str, Any], arguments: List[str]) -> int:
    role, specs = _lock_add_specs(arguments)
    _verify_dependencies(entry)
    package_json = REPOSITORY_ROOT / "package.json"
    if package_json.is_symlink() or not package_json.is_file():
        raise fail("package.json must be a regular, non-symlink file")
    scratch = Path(tempfile.mkdtemp(prefix="npm-lock-add.", dir=TOOLCHAIN_ROOT))
    try:
        for name in ("package.json", "package-lock.json"):
            shutil.copyfile(REPOSITORY_ROOT / name, scratch / name)
        save = "--save-prod" if role == "--prod" else "--save-dev"
        status = _run_npm(entry, ["install", "--package-lock-only", "--save-exact", save, *specs], scratch)
        if status != 0:
            return status
        for name in ("package.json", "package-lock.json"):
            produced = scratch / name
            if produced.is_symlink() or not produced.is_file():
                raise fail(f"npm did not produce a regular {name}")
        try:
            toolchain_lock._verify_dependency_tree(entry, REPOSITORY_ROOT)
        except toolchain_lock.LockError as error:
            raise fail(str(error)) from error
        for name in ("package.json", "package-lock.json"):
            shutil.copyfile(scratch / name, REPOSITORY_ROOT / name)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    return 0


def _parse_npm_mode(arguments: List[str]) -> str:
    _require_argument(arguments, "unsupported npm command: <empty>")
    mode = arguments[0]
    if mode == "--version":
        if len(arguments) != 1:
            raise fail("unsupported npm command arguments")
    elif mode == "ci":
        if arguments[1:] not in ([], ["--offline"]):
            raise fail("npm ci accepts only the optional --offline flag")
    elif mode == "lock-add-exact":
        _lock_add_specs(arguments[1:])
    else:
        raise fail(f"unsupported npm command: {mode}")
    return mode


def command_npm(arguments: List[str]) -> int:
    mode = _parse_npm_mode(arguments)
    _reject_repository_npm_config()
    entry = select(allow_pending=mode != "lock-add-exact")
    if mode == "ci":
        try:
            toolchain_lock._verify_package_lock(entry, REPOSITORY_ROOT)
        except toolchain_lock.LockError as error:
            raise fail(str(error)) from error
    _verify_installed(entry, check_version=False)
    _verify_npm_private_files(entry)
    if mode == "--version":
        return _run_npm(entry, ["--version"], REPOSITORY_ROOT)
    if mode == "ci":
        return _npm_ci(entry, arguments[1:])
    return _npm_lock_add(entry, arguments[1:])


# --------------------------------------------------------------- commands

def command_node(arguments: List[str]) -> int:
    mode, name, rest = _parse_node_mode(arguments)
    entry = select()
    _verify_installed(entry, check_version=False)
    _verify_private_runtime(entry)
    argv = _node_command(entry, mode, name, rest)
    sys.stdout.flush()
    sys.stderr.flush()
    os.execve(argv[0], argv, _child_environment(entry))
    return 3  # not reached


def command_setup() -> int:
    bootstrap(allow_pending=False)
    entry = select()
    if command_npm(["ci", "--offline"]) != 0:
        print("sentinel-tool: locked packages are not cached, installing from the lock file online", file=sys.stderr)
        if command_npm(["ci"]) != 0:
            raise fail("npm ci failed")
    dist = REPOSITORY_ROOT / "dist"
    if dist.exists():
        shutil.rmtree(dist)
    environment = _child_environment(entry)
    node = str(_node_home(entry) / toolchain_lock.NODE_BINARY)
    if subprocess.run([node, str(REPOSITORY_ROOT / toolchain_lock.TSC_ENTRY), "-p", "tsconfig.json"], cwd=str(REPOSITORY_ROOT), env=environment, check=False).returncode != 0:
        raise fail("TypeScript build failed")
    # The compiled tree is private (700/600); that is what the first-party lock fingerprints.
    _set_directory_modes(dist, 0o700)
    for current, _directories, files in os.walk(dist):
        for name in files:
            os.chmod(Path(current) / name, 0o600)
    version = subprocess.run([node, _first_party_entry(entry, "sentinel-ts"), "version"], cwd=str(REPOSITORY_ROOT), env=environment, stdout=subprocess.DEVNULL, check=False)
    if version.returncode != 0:
        raise fail("version failed")
    print("sentinel-tool: typescript checker ready", file=sys.stderr)
    return 0


def command_describe(key: str) -> int:
    """Maintenance: download and extract a Node archive for another platform and print its fingerprints."""

    entry = select(key, allow_pending=True)
    archive = _download(entry)
    with tempfile.TemporaryDirectory(prefix="describe-node-") as directory:
        tree = Path(directory) / "tree"
        extract(archive, entry["archiveRoot"], tree)
        output = {
            "archiveSize": entry["archiveSize"],
            "binarySha256": _sha256_file(tree / toolchain_lock.NODE_BINARY),
            "npmCliSha256": _sha256_file(tree / toolchain_lock.NPM_CLI),
            "installedTreeSha256": toolchain_lock._tree_digest(tree),
        }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def command_describe_dependencies() -> int:
    """Maintenance: this host's node_modules fingerprint and TypeScript binary digest for the lock."""

    entry = select(allow_pending=True)
    output = {
        "platform": entry["platform"],
        "dependencyTreeSha256": toolchain_lock._tree_digest(REPOSITORY_ROOT / "node_modules"),
        "tscBinaryPath": toolchain_lock.tsc_binary(entry).as_posix(),
        "tscBinarySha256": _sha256_file(REPOSITORY_ROOT / toolchain_lock.tsc_binary(entry)),
    }
    print(json.dumps(output, indent=2, sort_keys=True))
    return 0


def main(argv: Optional[Sequence[str]] = None) -> int:
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        raise fail(USAGE)
    mode, rest = arguments[0], arguments[1:]
    if mode == "platform":
        print(platform_key())
        return 0
    if mode == "bootstrap":
        print(f"verified node: {bootstrap().relative_to(REPOSITORY_ROOT)}")
        return 0
    if mode == "setup":
        return command_setup()
    if mode == "node":
        return command_node(rest)
    if mode == "npm":
        return command_npm(rest)
    if mode == "describe":
        if len(rest) != 1:
            raise fail("usage: toolchain.py describe PLATFORM")
        return command_describe(rest[0])
    if mode == "describe-dependencies":
        return command_describe_dependencies()
    raise fail(USAGE)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ToolchainError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(2)
