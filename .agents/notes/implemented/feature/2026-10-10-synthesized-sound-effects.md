# Agent Note: 音效在页面里合成，按响度分档

Status: implemented

## Problem

农场要有声音反馈：点工具、地里熟了、长虫、拿到金币。声音要轻（语音通话时麦克风就在旁边），彼此音量一致，还不想往仓库里塞一堆音频文件和授权问题。

## Decision

见 [pixel-village.md](../../../../docs/reference/pixel-village.md)「音效」：

- 每个音效是一个配方（`app/lib/shell/sfx.dart`），在客户端里现合成：音调、滤过的噪声、铃声各有自己的起落。合成器是 `app/lib/shell/synth.dart`，算成样本、写成 WAV 再播放（网页时在浏览器里用 Web Audio 实时合成；Flutter 照搬成 Dart，和网页的合成逐样本对过）。
- 按人耳加权的响度（ITU-R BS.1770 的 K 计权，取最响的 100 毫秒）分三档：点击约 -28，干活和状态变化约 -24，奖励约 -20；改了配方要重新量。
- 从状态里响，不从点击里响（`app/lib/shell/farm_sounds.dart`）：不管是你点的、帮工做的、服务端推的还是调试台改的都会响。

## Alternatives considered

**录音或买音效包。** 要管文件、授权和格式；各家音效的响度不一，要逐个调。

**在点击处理里放声音。** 帮工自己做完、服务端推来的变化就没有声音，同一件事在不同入口响法不一样。

## Consequences

没有音频文件，音量可量可调，一致。代价是合成出来的声音偏简单；要听就开客户端，在图鉴或调试台的「音效」里逐个播放（原来导出 WAV 的 `design/sounds/export.py` 随网页删掉了）。
