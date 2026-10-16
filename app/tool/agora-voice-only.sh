#!/bin/sh
# The Agora plugin links every extension of the RTC SDK on macOS and iOS (face capture, lip sync, virtual background,
# video codecs, screen sharing…), tens of MB a voice-only client never loads. This copies the plugin out of the pub
# cache into third_party/ (not in git) and keeps, in both Swift packages, only the core and the two audio AI extensions
# ConvoAI benefits from: noise suppression (AINS) and echo cancellation (AIAEC). Android keeps the plugin's full SDK.
# pubspec.yaml's dependency_overrides points at the copy.
# Run before `flutter pub get` on a fresh checkout, and again after bumping agora_rtc_engine.
set -e
cd "$(dirname "$0")/.."
version=$(sed -n 's/^  agora_rtc_engine: \^\{0,1\}\([0-9.]*\)$/\1/p' pubspec.yaml)
source=$(ls -d "${PUB_CACHE:-$HOME/.pub-cache}"/hosted/*/agora_rtc_engine-"$version" 2>/dev/null | head -1)
if [ -z "$source" ]; then
  # Fetch it once through a throwaway project, so this works before the overrides are resolvable.
  tmp=$(mktemp -d)
  printf 'name: fetch\nenvironment:\n  sdk: ^3.8.0\ndependencies:\n  agora_rtc_engine: %s\n' "$version" > "$tmp/pubspec.yaml"
  (cd "$tmp" && dart pub get >/dev/null)
  rm -rf "$tmp"
  source=$(ls -d "${PUB_CACHE:-$HOME/.pub-cache}"/hosted/*/agora_rtc_engine-"$version" | head -1)
fi
rm -rf third_party/agora_rtc_engine
mkdir -p third_party
cp -R "$source" third_party/agora_rtc_engine
chmod -R u+w third_party/agora_rtc_engine
for platform in macOS iOS; do
  manifest=third_party/agora_rtc_engine/$(echo "$platform" | tr '[:upper:]' '[:lower:]')/agora_rtc_engine/Package.swift
  for product in AINSLL AudioBeauty ClearVision ContentInspect SpatialAudio VirtualBackground AIAECLL VQA FaceDetection FaceCapture LipSync VideoCodecEnc VideoAv1CodecEnc ScreenCapture ReplayKit; do
    sed -i '' "/\.product(name: \"$product\", package: \"AgoraRtcEngine_$platform\"),/d" "$manifest"
  done
  grep -c '\.product(' "$manifest" | xargs echo "agora_rtc_engine $version, $platform: products kept:"
done
