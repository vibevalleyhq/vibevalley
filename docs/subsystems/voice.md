# 语音

TS 服务端的语音（声网 ConvoAI 电话、听写、MOSS Live 与 Vision 的本机中继、通话内播报）随 TS 服务端删了，Rust 服务端没有 `voice.*` 接口（[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)「砍掉的」）。日后按需在 Rust 上重做。

## 还在的

| 位置 | 是什么 |
|---|---|
| `crates/vibevalley-server/src/modules/setting.rs` | `settings.json` 里的语音设置：默认值、校验（`settings_problem`）、只存和默认不同的部分；页面还能读写，Rust 不用它们拨电话 |
| `crates/vibevalley-server/src/modules/media/jobs.rs`、`crates/vibevalley-server/src/modules/media/vendor.rs` | 文字转语音是一种[媒体任务](docs/subsystems/media.md)（含流式），走 MOSS 的音频接口 |
| `crates/vibevalley-server/src/offline.rs` | 测试用的离线 MOSS：音频、文件和下载 |
| [`packages/ai/`](packages/ai/README.md)、[`packages/provider/`](packages/provider/README.md) | 页面的听写、MOSS Live 播放对账和声网 SDK；只剩页面在用，随页面删 |

## 重做时守住的

- **密钥不进页面**：页面连本机服务端的中继，服务端握手时注入厂商 Key，回传的帧里抹掉。
- **主监听不上公网**：要让外部语音平台回调时，单开一个只放一个接口、每通一钥的监听，不暴露主端口。
- **一段听写绑定发起的输入框**：切换焦点不写错地方，卸载时取消在途转写。
