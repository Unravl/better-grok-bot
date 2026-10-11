#!/bin/sh
# Builds the macOS helper: a universal (arm64 + x86_64) `Better Grok Bot Helper.app`, signed, zipped.
#
#   native/macos-helper/build.sh           → build/Better Grok Bot Helper.app
#                                            build/bgb-helper-macos-universal.zip
#   native/macos-helper/build.sh --check   compile both architectures only; writes nothing to build/
#
# Env:
#   MACOS_SIGN_IDENTITY  Developer ID identity: hardened runtime + Apple Events entitlement.
#                        Unset: ad-hoc signature (same identifier).
#   HELPER_VERSION       CFBundleVersion / CFBundleShortVersionString
#                        (default: "version" in native/helper-manifest.json).
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
identifier=io.github.unravl.bettergrokbot.helper
check=0
case "${1:-}" in
	"") ;;
	--check) check=1 ;;
	*) echo "usage: $0 [--check]" >&2; exit 2 ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/bgb-helper-build.XXXXXX")
trap 'rm -rf "$work"' EXIT INT TERM

for arch in arm64 x86_64; do
	swiftc -O -swift-version 5 -target "$arch-apple-macos13.0" "$here/main.swift" -o "$work/bgb-helper-$arch"
done

if [ "$check" = 1 ]; then
	echo "macOS helper compiles (arm64, x86_64)"
	exit 0
fi

version=${HELPER_VERSION:-$(sed -n 's/^[[:space:]]*"version":[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$here/../helper-manifest.json" | head -n 1)}
if [ -z "$version" ]; then
	echo "cannot determine the helper version; set HELPER_VERSION" >&2
	exit 1
fi

out="$here/build"
app="$out/Better Grok Bot Helper.app"
zip="$out/bgb-helper-macos-universal.zip"
rm -rf "$app" "$zip"
mkdir -p "$app/Contents/MacOS"
lipo -create -output "$app/Contents/MacOS/bgb-helper" "$work/bgb-helper-arm64" "$work/bgb-helper-x86_64"
sed "s/@VERSION@/$version/g" "$here/Info.plist.template" > "$app/Contents/Info.plist"
plutil -lint -s "$app/Contents/Info.plist"

if [ -n "${MACOS_SIGN_IDENTITY:-}" ]; then
	codesign --force --options runtime --timestamp --entitlements "$here/entitlements.plist" \
		--sign "$MACOS_SIGN_IDENTITY" --identifier "$identifier" "$app"
else
	codesign --force --sign - --identifier "$identifier" "$app"
fi
codesign --verify --strict --verbose=2 "$app"

# No AppleDouble `._*` entries: the code signature lives in the bundle itself, and an extractor other
# than ditto would otherwise write them into the sealed bundle as files.
ditto -c -k --norsrc --noextattr --noacl --keepParent "$app" "$zip"
echo "$zip"
