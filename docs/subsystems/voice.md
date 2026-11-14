# 语音

语音在 Rust 服务端上：通话、听写和 MOSS 的本机中继是契约的 `voice.*`（`crates/vibevalley-protocol/src/contract/voice.rs`），文字转语音是一种媒体任务。本篇只写已经沉淀的部分和要守住的约束。

## 在哪

| 位置 | 是什么 |
|---|---|
| `crates/vibevalley-server/src/modules/setting.rs` | `settings.json` 里的语音设置：默认值、校验（`settings_problem`）、只存和默认不同的部分 |
| `crates/vibevalley-server/src/modules/media/jobs.rs`、`crates/vibevalley-server/src/modules/media/vendor.rs` | 文字转语音是一种[媒体任务](docs/subsystems/media.md)（含流式），走 MOSS 的音频接口 |
| `crates/vibevalley-server/src/offline.rs` | 测试用的离线 MOSS：音频、文件和下载 |
| `apps/mac/ui/vv/web/features/voice/` | 工作台里语音的页面 |

## 守住的

- **密钥不进页面**：页面连本机服务端的中继，服务端握手时注入厂商 Key，回传的帧里抹掉。
- **主监听不上公网**：要让外部语音平台回调时，单开一个只放一个接口、每通一钥的监听，不暴露主端口。
- **一段听写绑定发起的输入框**：切换焦点不写错地方，卸载时取消在途转写。
