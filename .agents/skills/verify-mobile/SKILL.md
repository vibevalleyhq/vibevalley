---
name: verify-mobile
description: 改了手机壳（apps/mobile/**）、宿主的桥（packages/host/src/mobile.ts）、「连接到本机」的配对或放行（apps/server/src/lan）、或页面里用到宿主的地方（apps/web/src/app/Follow.tsx、apps/web/src/voice/call.ts）之后，在安卓模拟器上装一个真的应用，对着沙箱里的农场走一遍：配对、经「连接到本机」打开页面、页面经桥让手机弹通知、重开应用直接回到农场。用在：主人说「手机上看看」「验证手机壳」「配对还能用吗」。
---

# 验证手机壳

`apps/mobile` 的规则和桥有单元测试，但配对、钥匙串、WebView 里的 cookie、桥两头对不对得上，只有装一个真的应用才看得出来。这个 skill 用安卓模拟器和 `scripts/verify-server.ts` 的沙箱农场做这件事。

## 什么时候用

- 改了 `apps/mobile` 的任何代码或 `app.json`。
- 改了 `packages/host`（桥的形状、`currentHost`），或页面里调宿主的地方。
- 改了 `apps/server/src/lan`（配对、cookie、放行页面）。

不用它：只改了 `apps/mobile/src/rules.ts` 的纯函数、`bun test` 已经覆盖的。

## 准备

1. `bun run web:check`（类型，宿主的桥和手机壳的规则，构建出 `apps/web/dist`：沙箱农场经「连接到本机」放出的就是它）。
2. 一个 JDK 17（`/usr/libexec/java_home -V` 看；JDK 27 太新）和安卓 SDK。模拟器和镜像没装就装：

   ```bash
   export JAVA_HOME=<JDK 17> T=~/Library/Android/sdk/cmdline-tools/latest/bin
   yes | $T/sdkmanager --install emulator "system-images;android-35;google_apis;arm64-v8a"
   echo no | $T/avdmanager create avd -n vv-e2e -k "system-images;android-35;google_apis;arm64-v8a" --force
   ```

3. 起模拟器（后台跑，不开窗口），等它开完机：

   ```bash
   ~/Library/Android/sdk/emulator/emulator -avd vv-e2e -no-window -no-audio -no-boot-anim -no-snapshot-save
   ~/Library/Android/sdk/platform-tools/adb shell getprop sys.boot_completed   # 1 才算好
   ```

## 步骤

1. 生成安卓工程，带着端到端的开关构建（Gradle 的守护进程记着它开起来时的环境，先停掉它）：

   ```bash
   cd apps/mobile && CI=1 bunx expo prebuild -p android --no-install
   cd android && ./gradlew --stop && EXPO_PUBLIC_VIBEVALLEY_E2E=1 ./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
   ```

   第一次构建要下载 NDK 和依赖，七八分钟。

2. 在仓库根目录跑：

   ```bash
   bun scripts/verify-server.ts -- bun apps/mobile/scripts/e2e.ts android
   ```

   脚本把应用重新装一遍（不留上次的农场），农场打开「连接到本机」、出一个码，用 `vibevalley://pair` 链接打开应用；应用请主人放行，脚本替主人点头，再看农场收到这台手机带钥匙的请求（页面经「连接到本机」加载了）；截图；经 WebView 的 DevTools 让页面往桥上发一条通知，看安卓真的弹出来；最后杀掉应用重开，看它不再要配对就回到农场。

3. `command.stdout.log` 应有：`paired and seen 安卓手机`、`bridge: the page's notice shown by the phone`、`back after a restart`。打开 `apps/mobile/.screens/android-farm.png` 看页面画出来了（新农场是首页）。

## 证据

- 执行的命令和打印的证据目录，`result.json` 的 `code` 是 0。
- `command.stdout.log` 的三行。
- 截图。

## 出错时

- **`waited for the phone questions to pair`**：应用没收到链接或没起来：`adb logcat | grep -i vibevalley`；模拟器要能连到这台电脑的局域网地址（脚本打印的 `pairing` 那一行）。
- **`bridge: not checked`**：应用不是带 `EXPO_PUBLIC_VIBEVALLEY_E2E=1` 构建的（多半是 Gradle 守护进程没停），重来第 1 步。
- **`the bridge answered "no host"`**：页面没装手机的宿主：`apps/web/dist` 是旧的（重新构建），或者页面没有调 `currentHost()`。
- **Gradle 失败**：JDK 不对（要 17）；`ANDROID_HOME` 没设时默认 `~/Library/Android/sdk`。

iOS（Xcode 装好、跑过一次 `xcodebuild -runFirstLaunch`）：

```bash
cd apps/mobile && CI=1 bunx expo prebuild -p ios --no-install && (cd ios && pod install)
cd ios && EXPO_PUBLIC_VIBEVALLEY_E2E=1 xcodebuild -workspace VibeValley.xcworkspace -scheme VibeValley -configuration Release \
  -sdk iphonesimulator -arch arm64 -derivedDataPath build CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=YES
bun scripts/verify-server.ts -- bun apps/mobile/scripts/e2e.ts ios   # 在仓库根目录；默认 iPhone 17，VIBEVALLEY_SIMULATOR 换
```

- 要临时签名（`CODE_SIGN_IDENTITY=-`）：不签的话模拟器不肯加载声网的框架，应用一开就退。
- `simctl openurl` 打开 `vibevalley://` 链接时，系统会先问「Open in "VibeValley"?」，脚本点不了；所以端到端构建的应用从启动参数 `-vibevalleyPair <链接>` 读配对链接（`App.tsx`），脚本这样启动它。
- iOS 不查桥（`bridge: not checked`）：WebView 的调试口要 Safari 的 Web 检查器，脚本连不上；其余三行和安卓一样。

## 收拾

- 停模拟器：`adb emu kill`。
- 沙箱农场由脚本停掉；`apps/mobile/.screens/`、`ios/`、`android/` 都不进 git。
