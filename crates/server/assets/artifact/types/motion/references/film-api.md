# 时间轴、场景 Schema 与纯时间求值契约（motion / film-api）

## 1. 单场景 `structure/scenes/<id>.json`

```json
{
  "id": "sc01-intro",
  "label": "开场标题",
  "duration": 4.5,
  "transitionOut": { "kind": "crossfade", "duration": 0.35 },
  "layers": [
    {
      "id": "bg_glow",
      "kind": "shape",
      "shape": "ellipse",
      "fill": "#4d7a2a",
      "x": 960,
      "y": 540,
      "w": 900,
      "h": 900,
      "keyframes": {
        "opacity": [{ "t": 0, "v": 0 }, { "t": 0.8, "v": 0.18, "ease": "outQuart" }]
      }
    },
    {
      "id": "hero_title",
      "kind": "text",
      "text": "VibeValley 2.0",
      "fontSize": 96,
      "weight": 700,
      "color": "#ecebe8",
      "x": 960,
      "y": 500,
      "keyframes": {
        "y": [{ "t": 0.2, "v": 540 }, { "t": 0.75, "v": 500, "ease": "outQuart" }],
        "opacity": [{ "t": 0.2, "v": 0 }, { "t": 0.65, "v": 1, "ease": "outCubic" }]
      }
    },
    {
      "id": "logo_mark",
      "kind": "image",
      "src": "asset/image/logo.svg",
      "x": 960,
      "y": 360,
      "w": 120,
      "h": 120
    }
  ],
  "subtitles": [
    { "id": "sub_1", "start": 0.4, "end": 4.0, "text": "以目录与实时协作为基石的新一代作品引擎。" }
  ]
}
```

## 2. 确定性缓动与辅助原语

所有关键帧求值均为局部时间 `localT = clamp(t - scene.start, 0, scene.duration)` 的纯函数：
- 内置缓动：`linear`、`outCubic`、`inOutCubic`、`outQuart`、`outBack`、`spring`（显式 `damping` 与 `stiffness`）。
- 列表错落入场：在图层配置 `stagger: { start, step, duration, ease }`，自动按序号确定性计算进场进度，无需手写重复时间偏移。
- 音画同步：在 `structure/timeline.json` 的 `audioTracks` 引用 `asset/audio/*.wav`，字幕时间窗严格对齐对应配音片段起止时间。

## 3. 资产目录约定

- `asset/image/`：SVG/PNG 图形、图标、产品截图；引用写 `asset/image/<name>`。
- `asset/audio/`：配音 WAV、背景乐、转场音效；引用写 `asset/audio/<name>`。
- `asset/video/`：嵌入式产品录屏或素材视频，显式声明 `clipStart`、`clipEnd` 与 `muted`。
