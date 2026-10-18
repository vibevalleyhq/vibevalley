#!/bin/sh
# The Agora plugin links every extension of the RTC SDK on macOS and iOS (face capture, lip sync, virtual background,
# video codecs, screen sharing…), tens of MB a voice-only client never loads. This copies the plugin out of the pub
# cache into third_party/ (not in git) and keeps, in both Swift packages, only the core and the two audio AI extensions
# ConvoAI benefits from: noise suppression (AINS) and echo cancellation (AIAEC). Android keeps the plugin's full SDK.
# pubspec.yaml's dependency_overrides points at the copy.
# Packaging and flutter:check call this before resolving dependencies; the version/recipe stamp makes repeats cheap.
set -eu
cd "$(dirname "$0")/.."
mkdir -p third_party
if [ "${VIBEVALLEY_AGORA_LOCKED:-}" != 1 ]; then
  exec sh tool/with-lock.sh third_party/.agora.lock env VIBEVALLEY_AGORA_LOCKED=1 sh tool/agora-voice-only.sh
fi
tmp=''
prepared=''
cleanup() {
  [ -z "$tmp" ] || rm -rf "$tmp"
  [ -z "$prepared" ] || rm -rf "$prepared"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
version=$(sed -n 's/^  agora_rtc_engine: \^\{0,1\}\([0-9.]*\)$/\1/p' pubspec.yaml)
[ -n "$version" ] || { echo "cannot read agora_rtc_engine version" >&2; exit 1; }
recipe=voice-only-v1
stamp="$version/$recipe"
if [ -f third_party/agora_rtc_engine/.vibevalley-prepared ] && [ "$(cat third_party/agora_rtc_engine/.vibevalley-prepared)" = "$stamp" ]; then
  exit 0
fi
source=$(ls -d "${PUB_CACHE:-$HOME/.pub-cache}"/hosted/*/agora_rtc_engine-"$version" 2>/dev/null | head -1)
if [ -z "$source" ]; then
  # Fetch it once through a throwaway project, so this works before the overrides are resolvable.
  tmp=$(mktemp -d)
  printf 'name: fetch\nenvironment:\n  sdk: ^3.8.0\ndependencies:\n  agora_rtc_engine: %s\n' "$version" > "$tmp/pubspec.yaml"
  (cd "$tmp" && dart pub get >/dev/null)
  rm -rf "$tmp"
  source=$(ls -d "${PUB_CACHE:-$HOME/.pub-cache}"/hosted/*/agora_rtc_engine-"$version" | head -1)
fi
mkdir -p third_party
prepared=$(mktemp -d third_party/agora-preparing.XXXXXX)
cp -R "$source" "$prepared/agora_rtc_engine"
chmod -R u+w "$prepared/agora_rtc_engine"
for platform in macOS iOS; do
  manifest="$prepared/agora_rtc_engine/$(echo "$platform" | tr '[:upper:]' '[:lower:]')/agora_rtc_engine/Package.swift"
  for product in AINSLL AudioBeauty ClearVision ContentInspect SpatialAudio VirtualBackground AIAECLL VQA FaceDetection FaceCapture LipSync VideoCodecEnc VideoAv1CodecEnc ScreenCapture ReplayKit; do
    sed "/\.product(name: \"$product\", package: \"AgoraRtcEngine_$platform\"),/d" "$manifest" > "$manifest.tmp"
    mv "$manifest.tmp" "$manifest"
  done
  grep -c '\.product(' "$manifest" | xargs echo "agora_rtc_engine $version, $platform: products kept:"
done

printf '%s\n' "$stamp" > "$prepared/agora_rtc_engine/.vibevalley-prepared"
# Only replace the generated override after copying and patching both manifests succeeded.
rm -rf third_party/agora_rtc_engine
mv "$prepared/agora_rtc_engine" third_party/agora_rtc_engine
