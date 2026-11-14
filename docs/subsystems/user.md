# 用户和设备

一个服务端只有一个用户：在跑服务端的那台电脑上，来自本机的请求就是这个用户，不用登录。Rust 服务端只听 `127.0.0.1`，没有账号、密码、设备钥匙和确认码登录。

## 现状

- **只有本机**：主监听固定绑 `127.0.0.1`（`crates/vibevalley-server/src/main.rs`）；请求不带身份，都是用户的。用户的名字、语言在设置里（[设置和配置](docs/subsystems/setting.md)）。
- **砍掉的**：TS 服务端的 `user.*`（账号、scrypt 密码、设备钥匙、门外登录、RFC 8628 确认码登录）和命令行的 `vibevalley auth` 随「连接到本机」与手机壳一起删了（[原生计划](.agents/notes/proposed/architecture/2026-11-14-native-vibevalley.md)「砍掉的」）。`packages/protocol/src/user/` 的形状还在，Rust 不服务这些接口；`apps/web` 的 `/login`、`/approve` 在 Rust 服务端上用不了，随页面删。

## 为什么这样

- **本机不登录**：本机的进程本来就能读家目录里的一切，要登录挡不住什么。
- **对外的门以后再做**：要从别的设备进来时，在 Rust 上重做一道独立的门，账号和钥匙跟它一起回来；主监听仍只认本机。
