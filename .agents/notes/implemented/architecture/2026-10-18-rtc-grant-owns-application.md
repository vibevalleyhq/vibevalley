# Agent Note: RTC 授予拥有这通电话的应用身份

Status: implemented

## Problem

客户端先拿令牌加入 RTC，再请语音管家进频道，令牌过期前续签。三个请求原来各读一次当前凭据：拿令牌后修改 App ID，会让启动请求或续期令牌指向另一个应用；客户端无法用新的令牌改变已经初始化的 RTC 引擎身份。

## Decision

`voice` 用服务端签发的 `channel + uid` 保存 RTC 授予及凭据快照。Start 与 Renew 只接受这份授予，不重新读取当前应用凭据；新电话才使用新设置。客户端仍按 Session → RTC join → Start 接通，不增加协议字段或客户端版本协调。

未启动授予的有效期与 `agora.TokenSeconds` 相同，续签后同步更新有效期，不另设较短的凭据期限。过期授予在请求时清理，服务停止时清空。Start 原子认领，失败撤销；成功后授予归通话持有。首次 Stop 尝试撤销续签资格，远端停止失败仍保留原 client 供重试。

完整行为见 [语音参考](docs/reference/voice.md)，代码与测试见 [voice](server/internal/voice/README.md)。

## Alternatives considered

**每次签令牌都读最新设置。** 新设置不能修改已加入频道的 RTC 应用身份，调用者必须自行避免设置变化，接口无法保证接通。

**新增 grant ID 和一套协议。** 现有 channel 与 uid 已由服务端生成，足以标识本次授予；再加一个客户端关联键没有减少协调。

**未启动授予只保留五分钟。** 会出现 RTC 令牌仍有效但 Start 已拒绝的第二套期限；采用现有令牌有效期。

## Consequences

续期和启动不再依赖跨请求的设置稳定性。授予只在当前进程有效，服务重启、启动失败、挂断后需要重新获取令牌；未完成接通且无人再请求的授予留到进程结束，下一次请求会清理已经过期的记录。

## Verification

`rtc_test.go` 用本地 SDK capture 验证签发后修改设置，Start 与 Renew 仍使用原 App ID，新 Session 才使用新 App ID；覆盖过期、未授予 UID、启动失败、停止失败后重试、并发重复启动以及服务停止后的迟到启动补偿。没有连接真实声网服务。
