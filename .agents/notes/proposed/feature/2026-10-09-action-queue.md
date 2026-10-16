# Agent Note: 每个动作至少播完一小段

Status: proposed

## Problem

帮工一秒内可能连着调好几次工具，气泡和姿势跟着来一个切一个，闪得看不清。

## Proposal

客户端的像素村（`app/lib/village/`）给每个动作至少播 800 毫秒；后来的排队，队列只留最新的一个，所以不会越积越落后。只改画面，不改核心状态。

帮工走到哪座房子已经有这样的节流（`app/lib/village/world.dart` 的 `Whereabouts`：想去新地方 1.2 秒、在原地待够 2 秒才动身）；姿势和头上写的在做什么还没有，这一条补的是它们。

## Alternatives considered

**服务端合并事件。** 干活过程和计分要的是每一次调用；节奏是画面的事。

## Acceptance criteria

连续的快速工具调用在画面上一个个看得清，停下来时画面在一秒内追上最新的动作。

## Risks

画面会比真实进度慢一点。
