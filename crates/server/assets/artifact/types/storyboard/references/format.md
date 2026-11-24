# 分镜脚本 Schema 与资产映射规范（storyboard / format）

## 1. `structure/shots.json` 完整字段

| 顶层字段 | 类型 | 说明 |
|---|---|---|
| `title` | `string` | 短片或项目标题 |
| `aspectRatio` | `"16:9" \| "9:16" \| "1:1" \| "2.39:1"` | 目标画幅，需与下游生成关键帧及 `motion` 一致 |
| `fps` | `number` | 目标帧率（常见 `24` / `30` / `60`） |
| `styleGuide` | `object` | `visualTone`（画面基调）、`palette`（主色盘）、`continuityRefs`（`asset/refs/*` 统一参考图） |
| `shots` | `Shot[]` | 有序镜头数组 |

单个 `Shot` 对象字段：
- `id`（必填）：稳定短标识（如 `sh01`、`sh02`），切勿因插镜而重编号既有镜头，插入新镜头可命名为 `sh01b`。
- `scene`（必填）：所属段落/章节名（如 `"开场"`、`"痛点"`、`"产品揭幕"`、`"收尾 CTA"`）。
- `durationSec`（必填）：镜头时长（秒，精确到 `0.1s`）；若已配音，以 `asset/audio/` 实际时长加 `0.3s–0.5s` 呼吸余量为准。
- `framing`（必填）：景别枚举 `"extreme-wide"` | `"wide"` | `"medium"` | `"close-up"` | `"extreme-close-up"` | `"screen-ui"`。
- `camera`（必填）：运镜说明（如 `"static"`、`"slow push-in"`、`"pan left-to-right"`、`"rack focus"`）。
- `visual`（必填）：画面发生的动作、构图与屏幕文字（人可读）。
- `prompt`（可选）：面向生图/视频模型的英文提示词，继承 `styleGuide` 关键词与主体描述，便于批量复现一致画风。
- `dialogue`（可选）：该镜头的旁白或对白文本（无语音时留空字符串 `""`）。
- `sfx`（可选）：环境音、动效音与转场音乐提示。
- `transitionOut`（可选）：`"cut"` | `"crossfade"` | `"wipe"` | `"match-cut"`。
- `frameAsset`（可选）：主关键帧相对路径，如 `"asset/frames/sh01-key.png"`。
- `refAssets`（可选）：本镜引用的角色/场景参考图路径数组，如 `["asset/refs/char-a.png"]`。
- `audioAsset`（可选）：本镜配音文件相对路径，如 `"asset/audio/sh01-vo.wav"`。
- `status`（必填）：`"draft"` | `"generating"` | `"ready"` | `"locked"`。

## 2. 资产目录分工

- `asset/refs/`：跨镜头复用的人物设定、材质与色板参考图，供生图模型保持连贯性。
- `asset/frames/`：每个镜头的定格关键帧或草图，命名 `<shotId>-key.png`（备选稿可记 `<shotId>-alt1.png`）。
- `asset/audio/`：每镜配音与局部音效，命名 `<shotId>-vo.wav` / `<shotId>-sfx.wav`。
