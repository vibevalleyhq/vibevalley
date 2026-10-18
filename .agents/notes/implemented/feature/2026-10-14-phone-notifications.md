# Agent Note: 手机上的通知

Status: implemented

## Problem

用[院门](2026-10-14-yard-gate.md)连上农场以后，手机能看能派活，但帮工做完活时手机不会响，主人还得自己打开 App 去看。桌面版有通知，规则写在 `app/lib/host/notify.dart` 里，是纯函数；手机上缺的是谁来把通知送到。难点在于：农场在局域网里，手机上的 App 一离开屏幕就可能被系统挂起，挂起以后状态流断了，App 自己什么也发不出来。

## Decision

- **App 活着的时候弹本地通知**（`app/lib/host/mobile_notices.dart`）：用 `flutter_local_notifications`，规则和桌面版是同一套（`noticeForCall`、`noticeForEffect`、`noticeForEvent`、`CallBell`）。只在 App 不在屏幕前时弹；在前台时农场自己会说。点一条通知，打开它说的那件事：经 `hostProvider` 的 `commands` 交给画面，和 Mac 上点通知走同一条路。点通知启动 App 时，命令先存着，等画面开始听再交出去。
- **Android 用前台服务让 App 常驻**：App 进后台时开一个前台服务（类型 `remoteMessaging`，通知栏里一条低优先级的「VibeValley 连着农场」），回到前台就关掉。进程不被系统回收，状态流就一直连着，帮工做完活时能马上弹通知。服务跟着 App 的任务走，划掉 App 它也就停了。
- **iOS 不常驻**：iOS 不让普通 App 在后台保持连接，离开屏幕以后只有挂起前的那一小会儿能收到通知。
- **App 关着的时候靠连接器**：汇报本来就会发到微信、飞书、QQ（[连接器](../../../../docs/subsystems/channel.md)）。要随时收到，用微信或飞书：汇报一出来就发，不用等主人先说话。

## Alternatives considered

**系统推送：iOS 的 APNs，Android 的 FCM。** 这是唯一能在 App 关着、也不在局域网里时把通知送到手机系统上的路。APNs 可以由 Go 服务端拿 `.p8` 密钥直接发，但要苹果开发者账号和推送证书；FCM 在国内多数安卓手机上收不到，要换成各家厂商的推送，一家一家接，成本很高。现在先不做。等要上架 iOS、有了开发者账号再加 APNs，到那时手机配对时把推送 token 交给农场就行。

**Android 不开前台服务，只在前台时弹。** 那手机放下以后就收不到了，本地通知几乎没有用处。代价是通知栏里常驻一条，主人可以在系统设置里把这一类通知关掉。

**在服务端判断「该通知谁」。** 现在通知的规则都在客户端，从服务端折好的帧里读 Inbox（`inbox`）。要做系统推送时，这部分才需要搬到服务端去。

## Consequences

- Android 在后台多耗一点电，通知栏多一条常驻的通知。Doze 模式下网络可能被系统暂停，通知会晚到。
- iOS 上 App 不在屏幕前时基本收不到通知；要及时知道，就用微信或飞书连接器。
- Android 要 `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_REMOTE_MESSAGING` 权限，还要在 Gradle 里开 core library desugaring（插件要求）。通知权限在第一次启动时向主人申请。
