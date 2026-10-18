#!/bin/sh
# vibevalley's desktop app for macOS, Flutter's: the Go server (server/cmd/server) built without cgo and put in
# the bundle beside the app's executable (Contents/MacOS/vibevalley-server; lib/desktop starts it), the app built in
# release, signed ad hoc (no Developer ID, no notarization), and a DMG made of it.
#
#   tool/build-macos.sh                  # build/vibevalley.app, build/vibevalley-arm64.dmg
#   tool/build-macos.sh --channel alpha  # build/vibevalley Alpha.app, its own bundle id and home (lib/desktop/channel.dart)
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
REPO=$(CDPATH= cd -- "$HERE/.." && pwd)
mkdir -p "$HERE/build"
if [ "${VIBEVALLEY_PACKAGE_LOCKED:-}" != 1 ]; then
  exec sh "$HERE/tool/with-lock.sh" "$HERE/build/.package-macos.lock" env VIBEVALLEY_PACKAGE_LOCKED=1 sh "$0" "$@"
fi
CHANNEL=release
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL=$2; shift 2 ;;
    *) echo "usage: $0 [--channel alpha|beta|release]" >&2; exit 2 ;;
  esac
done
sh "$HERE/tool/agora-voice-only.sh"
META=$(dart "$HERE/tool/channel.dart" "$CHANNEL")
TAB=$(printf '\t')
IFS="$TAB" read -r NAME SHOWN ID DMG_NAME <<EOF
$META
EOF

mkdir -p "$HERE/build"
WORK=$(mktemp -d "$HERE/build/package-$CHANNEL.XXXXXX")
PUBLISHING=0
cleanup() {
  if [ "$PUBLISHING" = 1 ]; then
    echo "publication interrupted or failed; staging preserved at $WORK" >&2
  else
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
APP="$WORK/$NAME.app"
DMG="$WORK/$DMG_NAME"

echo "== the Go server"
(cd "$REPO/server" && env -u GOROOT -u GOTOOLDIR CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
  go build -trimpath -ldflags='-s -w' -o "$WORK/vibevalley-server" ./cmd/server)

echo "== the app"
(cd "$HERE" && flutter build macos --release --dart-define=VIBEVALLEY_CHANNEL="$CHANNEL")

BUILT="$HERE/build/macos/Build/Products/Release/vibevalley.app"
cp -R "$BUILT" "$APP"
cp "$WORK/vibevalley-server" "$APP/Contents/MacOS/vibevalley-server"
# Apache 2.0: the app carries vibevalley's license and the notices of what it includes.
cp "$REPO/LICENSE" "$REPO/NOTICE" "$APP/Contents/Resources/"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $ID" -c "Set :CFBundleName $NAME" -c "Set :CFBundleDisplayName $SHOWN" "$PLIST"

echo "== signing (ad hoc)"
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/vibevalley-server"
codesign --force --deep --sign - --timestamp=none --entitlements "$HERE/macos/Runner/Release.entitlements" "$APP"
codesign --verify --deep --strict "$APP"

echo "== the DMG"
STAGE="$WORK/dmg-stage"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
hdiutil verify "$DMG" >/dev/null
xcrun clang -Wall -Wextra -Werror "$HERE/tool/publish-macos.c" -o "$WORK/publish"
PUBLISHING=1
if ! "$WORK/publish" "$APP" "$HERE/build/$NAME.app" "$DMG" "$HERE/build/$DMG_NAME"; then
  # A failed rollback must never let the cleanup trap delete the previous artifacts.
  exit 1
fi
PUBLISHING=0
ls -lh "$HERE/build/$DMG_NAME" "$HERE/build/$NAME.app/Contents/MacOS/vibevalley-server"
