# storyboard：逐镜头视听分镜脚本

`storyboard` 面向短片、产品宣传片、教学动画与广告的逐镜头制作脚本，把镜头画面构图、运镜、生成提示词、对白/旁白、音效配乐与参考素材统一编排，直接衔接上游**媒体生成（图片/语音）**与下游 **`motion` 动态短片**。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`）。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json                 # id、artifactType: "storyboard"、title、entry: "structure/shots.json"
├── structure/
│   └── shots.json                # 项目规格、角色/视觉风格锚点与有序镜头清单
└── asset/
    ├── frames/                   # 每镜头关键帧/分镜草图（asset/frames/sh01-key.png）
    ├── refs/                     # 角色三视图、场景与色调参考图（asset/refs/hero-sheet.png）
    └── audio/                    # 每镜头配音试听与音效（asset/audio/sh01-vo.wav）
```

`structure/shots.json` 最小示例：
```json
{
  "title": "VibeValley 产品发布短片",
  "aspectRatio": "16:9",
  "fps": 30,
  "styleGuide": {
    "visualTone": "温暖田间工作台质感、自然日光、克制暖灰底",
    "palette": ["#fcfcfb", "#1c1917", "#4d7a2a", "#d97742"],
    "continuityRefs": ["asset/refs/palette-board.png"]
  },
  "shots": [
    {
      "id": "sh01",
      "scene": "开场",
      "durationSec": 3.5,
      "framing": "wide",
      "camera": "slow push-in",
      "visual": "清晨工作台俯拍，目录结构卡片展开并浮现多人实时光标",
      "prompt": "Warm editorial desk top-down shot, clean paper folders opening, soft morning sunlight",
      "dialogue": "每一份作品，都是一座人与执行会话共同进化的目录。",
      "sfx": "轻柔翻页声 + 温暖木琴起音",
      "frameAsset": "asset/frames/sh01-key.png",
      "refAssets": ["asset/refs/palette-board.png"],
      "audioAsset": "asset/audio/sh01-vo.wav",
      "status": "ready"
    }
  ]
}
```

## 多人与多执行会话实时协作规则

1. **按镜头稳定 ID 并发同步（`artifact_collab`）**：`structure/shots.json` 中每个镜头持有稳定 `id`（如 `sh01`），导演/编剧改对白与时长、美术执行会话挂接 `asset/frames/` 关键帧、配音执行会话挂接 `asset/audio/` 语音轨可同时进行，由 `artifact_collab` 无冲突合并并写回目录文件；**严禁改一个镜头时重写整份镜头表**。
2. **来源追踪与剪辑试错（`artifact_change`）**：每次调序、改时长、换关键帧与改旁白均记录 `origin`，支持回放版本演变、按来源撤销某轮镜头改写或分叉短版（如 30s 预告剪辑）；开拍/转 `motion` 前用 `artifact_version` 冻结锁定版快照。
3. **审阅建议流（`artifact_suggestion`）**：修改用户亲手写定的旁白台词、镜头情绪或删减已锁定（`status: "locked"`）的镜头时，必须先提交 `artifact_suggestion`，由用户确认后再变更。
4. **实时在场感知（Presence）**：先查看协作者当前聚焦的镜头 ID，并行生成或打磨其他镜头的提示词、画面帧与配音轨，避免抢写同一镜头的台词与时长。

## 衔接媒体生成与 `motion`

- **生图与配音资产归档**：通过媒体任务生成的关键帧、角色参考图与配音，一律归档至 `asset/frames/`、`asset/refs/`、`asset/audio/` 并用相对路径回填对应镜头字段。
- **平滑交接 `motion`**：分镜全部 `status: "locked"` 后，总时长直接由 `sum(shots[].durationSec)` 确定，每个镜头可按顺序映射为 `motion` 的 `structure/scenes/<shotId>.json` 并复用 `asset/` 下的图文与配音文件。

按需延伸阅读：`artifact_type_read({ type: "storyboard", reference: "format" | "craft" })`。
