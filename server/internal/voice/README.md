# voice

服务端的通话、语音线路与听写。对外只有 `Service`；处理函数转交请求，声网 SDK 请求由 `agora.go` 与 `pkg/agora` 适配。客户端接通顺序与接口语义见 [语音参考](docs/reference/voice.md)。

- `rtc.go` 拥有 RTC 授予：签发的应用身份、启动认领、续期与撤销；调用者不协调凭据版本（[决定](.agents/notes/implemented/architecture/2026-10-18-rtc-grant-owns-application.md)）。
- `agora.go` 拥有远端语音管家与本地线路的对应关系，停止重试使用建立通话时的 client。
- `line.go` 拥有回环监听、每通电话的钥匙及隧道；`dictate.go` 拥有听写请求。

`go test ./internal/voice` 覆盖签发、SDK 请求、线路与字幕身份；`rtc_test.go` 使用假 SDK 对端与可控时钟，验证授予跨设置修改仍保持同一个应用。
