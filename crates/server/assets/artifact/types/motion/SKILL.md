# motion：纯时间函数动态短片

`motion` 面向高质感图形动画、产品揭幕、算法可视化与动态字幕短片。作品以独立目录存放在 `storage/`（`<storage>/artifact/<id>/`），总时间轴存放在 `structure/timeline.json`，各分镜场景存放在 `structure/scenes/*.json`，音视频与贴图素材归档于 `asset/{audio,video,image}/`，支持逐帧定位、章节跳转与导出视频到媒体库。

## 目录结构（Directory-per-Artifact）

```text
<storage>/artifact/<id>/
├── manifest.json                 # id、artifactType: "motion"、title、entry: "structure/timeline.json"
├── structure/
│   ├── timeline.json             # 画幅、帧率、总时长、章节、音轨与场景编排顺序
│   └── scenes/
│       ├── sc01-intro.json       # 单个场景的图层、关键帧曲线与字幕声明
│       └── sc02-reveal.json
└── asset/
    ├── audio/                    # 配音、BGM、音效（asset/audio/vo-01.wav）
    ├── video/                    # 录屏或实拍底片（asset/video/demo.mp4）
    └── image/                    # 贴图、图标、参考图（asset/image/logo.svg）
```

`structure/timeline.json` 示例：
```json
{
  "title": "版本发布片头",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "duration": 12.0,
  "background": "#151413",
  "chapters": [{ "at": 0, "label": "开场" }, { "at": 4.5, "label": "核心揭幕" }],
  "scenes": [
    { "id": "sc01-intro", "file": "structure/scenes/sc01-intro.json", "start": 0, "end": 4.5 },
    { "id": "sc02-reveal", "file": "structure/scenes/sc02-reveal.json", "start": 4.5, "end": 12.0 }
  ],
  "audioTracks": [{ "id": "bgm", "src": "asset/audio/bgm.wav", "start": 0, "gain": 0.35 }]
}
```

## 多人与多执行会话实时协作规则

1. **按场景文件并行同步（`artifact_collab`）**：每个场景独立存于 `structure/scenes/<id>.json`，多人或多执行会话可同时精修不同场景的图层与关键帧，由 `artifact_collab` 无冲突合并并落盘；严禁为调一帧动画重写整个时间轴。
2. **来源追踪与分叉试剪（`artifact_change`）**：所有时间轴剪辑、关键帧与音轨改动均带 `origin` 记录，支持按轮次撤销某次动效调整或分叉不同节奏版本；成片导出前通过 `artifact_version` 保存不可变目录快照。
3. **审阅建议流（`artifact_suggestion`）**：修改用户手调的关键帧时长、文案字幕或转场节奏时，先提交 `artifact_suggestion`（附目标场景与时间点），经用户接受后再合入。
4. **实时在场感知（Presence）**：查看协作者当前播放头位置（playhead）与选中场景，优先在空闲场景或音频轨上并行协作，避免抢改同一图层关键帧。

## 铁律：纯时间确定性

- **任意时刻 `t` 必须永远产出完全相同的一帧**：禁止帧间状态累加（`x += vx`）或无种子随机；所有位移、缩放、透明度均由 `t`（或场景局部进度 `0..1`）经缓动函数唯一决定，确保拖动时间轴与逐帧导出 100% 一致。
- **衔接 `storyboard`**：复杂成片可先用 `storyboard` 敲定镜头与配音，再按 `shots.json` 与 `asset/{audio,image}/` 逐镜转化为 `motion` 场景。

按需延伸阅读：`artifact_type_read({ type: "motion", reference: "film-api" | "choreography" })`。
