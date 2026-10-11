#!/bin/sh
# Better Grok Bot installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/Unravl/better-grok-bot/main/install.sh | sh
#
# Downloads the `bgb` release archive for this OS/architecture, verifies it against the release's
# SHA256SUMS and runs `bgb setup`, which installs it into the Better Grok Bot data directory.
#
# Environment:
#   BGB_VERSION         release to install (`1.2.3` or `v1.2.3`); default: latest
#   BGB_SETUP_ARGS      extra `bgb setup` flags, split on spaces (e.g. `--no-autostart`); simple flags
#                       only, since quotes are not honored; use BGB_APP_PATH for a path
#   BGB_APP_PATH        Grok Bot install to use, passed as one `--app <path>` argument (may contain spaces)
#   BGB_NONINTERACTIVE  set to run `bgb setup --yes --no-restart` without prompts
#   BGB_LOCAL_ARCHIVE + BGB_LOCAL_SUMS  install a local archive instead of downloading (CI)
set -eu

REPO="Unravl/better-grok-bot"

die() {
	printf 'install.sh: %s\n' "$*" >&2
	exit 1
}

case "$(uname -s)" in
Darwin) os=darwin ;;
Linux) os=linux ;;
*) die "unsupported OS $(uname -s); on Windows run install.ps1" ;;
esac

case "$(uname -m)" in
arm64 | aarch64) arch=arm64 ;;
x86_64 | amd64) arch=x64 ;;
*) die "unsupported architecture $(uname -m)" ;;
esac
# A shell running under Rosetta reports x86_64 on Apple silicon.
if [ "$os" = darwin ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then
	arch=arm64
fi

name="bgb-$os-$arch.tar.gz"
version="${BGB_VERSION:-latest}"
if [ "$version" = latest ]; then
	base="https://github.com/$REPO/releases/latest/download"
else
	case "$version" in
	v*) tag="$version" ;;
	*) tag="v$version" ;;
	esac
	base="https://github.com/$REPO/releases/download/$tag"
fi

tmp="$(mktemp -d 2>/dev/null || mktemp -d -t bgb-install)"
trap 'rm -rf "$tmp"' EXIT
trap 'exit 130' INT TERM

fetch() {
	if command -v curl >/dev/null 2>&1; then
		curl -fsSL --retry 3 -o "$2" "$1" || die "download failed: $1"
	elif command -v wget >/dev/null 2>&1; then
		wget -q -O "$2" "$1" || die "download failed: $1"
	else
		die "curl or wget is required"
	fi
}

if [ -n "${BGB_LOCAL_ARCHIVE:-}" ] && [ -n "${BGB_LOCAL_SUMS:-}" ]; then
	cp "$BGB_LOCAL_ARCHIVE" "$tmp/$name"
	cp "$BGB_LOCAL_SUMS" "$tmp/SHA256SUMS"
else
	printf 'Downloading %s (%s)…\n' "$name" "$version" >&2
	fetch "$base/$name" "$tmp/$name"
	fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS"
fi

# Verify against exactly the line for this archive.
awk -v n="$name" '$2 == n || $2 == "*" n' "$tmp/SHA256SUMS" >"$tmp/check"
[ -s "$tmp/check" ] || die "SHA256SUMS has no entry for $name"
if [ "$os" = darwin ]; then
	(cd "$tmp" && shasum -a 256 -c check >/dev/null 2>&1) || die "checksum mismatch for $name"
else
	(cd "$tmp" && sha256sum -c check >/dev/null 2>&1) || die "checksum mismatch for $name"
fi

tar -xzf "$tmp/$name" -C "$tmp"
[ -x "$tmp/bgb" ] || die "$name does not contain bgb"

cd "$tmp"
# The script's own arguments are unused; reuse them as the one array POSIX sh has, so the path stays one word.
set --
if [ -n "${BGB_APP_PATH:-}" ]; then
	set -- --app "$BGB_APP_PATH"
fi
# `[ -r /dev/tty ]` passes without a controlling terminal; only an actual open proves one exists.
if [ -z "${BGB_NONINTERACTIVE:-}" ] && (exec </dev/tty) 2>/dev/null; then
	# shellcheck disable=SC2086 # BGB_SETUP_ARGS is a word list
	./bgb setup ${BGB_SETUP_ARGS:-} ${1+"$@"} </dev/tty
else
	# shellcheck disable=SC2086 # BGB_SETUP_ARGS is a word list
	./bgb setup --yes --no-restart ${BGB_SETUP_ARGS:-} ${1+"$@"}
fi
