# apps/mobile

The phone's shell (Expo, React Native): it pairs with a farm once, then shows the page that farm serves through its
lan listener (连接到本机) in a WebView, and is that page's host (`@vibevalley/protocol/host`, over its `mobileBridge`
whose page end is `mobileHost` there). How it fits with the desktop and the browser: [the client](docs/subsystems/app.md);
pairing and keys: [连接到本机](docs/subsystems/lan.md).

```
App.tsx              follows the current farm choice; a vibevalley://pair link asks the choice owner to pair again
src/PairScreen.tsx   camera and form: selects a link, names the phone, asks to pair or cancels
src/FarmScreen.tsx   the WebView: the key as the page's cookie; loading another page or leaving closes its host
src/base/host.ts         one loaded page's native host: answers bridge calls, keeps each call's identity, closes its line
src/farm.ts          FarmConnection owns the current choice, pending pairing and serialized keychain commits
src/rtc.ts           the call on Agora's native SDK: owns pending microphone permission, the engine and release
src/notify.ts        the page's notices as the phone's own (expo-notifications)
src/pairing.ts       pure: pairing links, the phone's name, the key's cookie, levels; with its vitest
scripts/e2e.ts       pairs a built app on an emulator or simulator with a sandboxed farm, and screenshots it
```

`ios/` and `android/` are made from `app.json` by `expo prebuild` and not kept. An app built with
`EXPO_PUBLIC_VIBEVALLEY_E2E=1` lets adb's DevTools into its WebView, so `scripts/e2e.ts` also checks the host bridge (a
notice posted by the page shown by the phone); stop the Gradle daemon first (`./gradlew --stop`), as it keeps the
environment it started with. On iOS it also takes the pair link as a launch argument (`-vibevalleyPair <link>`), as
`simctl openurl` stops at the system's "Open in VibeValley?"; the simulator build is signed ad hoc, or it cannot load
Agora's frameworks.

## Commands

```bash
vp run test                                     # farm choice, rules and native call ownership (mock native dependencies)
CI=1 vp exec expo prebuild -p android --no-install # android/, then:
cd android && JAVA_HOME=<a JDK 17> ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
CI=1 vp exec expo prebuild -p ios --no-install && (cd ios && pod install)   # ios/, then:
cd ios && xcodebuild -workspace VibeValley.xcworkspace -scheme VibeValley -configuration Release -sdk iphonesimulator \
  -arch arm64 -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES
vpx scripts/verify-server.ts -- vpx apps/mobile/scripts/e2e.ts android   # from the root, with an emulator running and apps/web/dist built; ios likewise
```
