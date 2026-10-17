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
CHANNEL=release
while [ $# -gt 0 ]; do
  case "$1" in
    --channel) CHANNEL=$2; shift 2 ;;
    *) echo "usage: $0 [--channel alpha|beta|release]" >&2; exit 2 ;;
  esac
done
case "$CHANNEL" in
  release) NAME='vibevalley'; SHOWN='码农场物语'; ID='dev.vibevalley.app'; DMG="$HERE/build/vibevalley-arm64.dmg" ;;
  beta) NAME='vibevalley Beta'; SHOWN='码农场物语 Beta'; ID='dev.vibevalley.app.beta'; DMG="$HERE/build/vibevalley-beta-arm64.dmg" ;;
  alpha) NAME='vibevalley Alpha'; SHOWN='码农场物语 Alpha'; ID='dev.vibevalley.app.alpha'; DMG="$HERE/build/vibevalley-alpha-arm64.dmg" ;;
  *) echo "unknown channel: $CHANNEL" >&2; exit 2 ;;
esac

mkdir -p "$HERE/build"
echo "== the Go server"
(cd "$REPO/server" && env -u GOROOT -u GOTOOLDIR CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 \
  go build -trimpath -ldflags='-s -w' -o "$HERE/build/vibevalley-server" ./cmd/server)

echo "== the app"
(cd "$HERE" && flutter build macos --release --dart-define=VIBEVALLEY_CHANNEL="$CHANNEL")

BUILT="$HERE/build/macos/Build/Products/Release/vibevalley.app"
APP="$HERE/build/$NAME.app"
rm -rf "$APP"
cp -R "$BUILT" "$APP"
cp "$HERE/build/vibevalley-server" "$APP/Contents/MacOS/vibevalley-server"
# Apache 2.0: the app carries vibevalley's license and the notices of what it includes.
cp "$REPO/LICENSE" "$REPO/NOTICE" "$APP/Contents/Resources/"
PLIST="$APP/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleIdentifier $ID" -c "Set :CFBundleName $NAME" -c "Set :CFBundleDisplayName $SHOWN" "$PLIST"

echo "== signing (ad hoc)"
codesign --force --sign - --timestamp=none "$APP/Contents/MacOS/vibevalley-server"
codesign --force --deep --sign - --timestamp=none --entitlements "$HERE/macos/Runner/Release.entitlements" "$APP"
codesign --verify --deep --strict "$APP"

echo "== the DMG"
STAGE="$HERE/build/dmg-stage"
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "$NAME" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
rm -rf "$STAGE"
ls -lh "$DMG" "$APP/Contents/MacOS/vibevalley-server"
