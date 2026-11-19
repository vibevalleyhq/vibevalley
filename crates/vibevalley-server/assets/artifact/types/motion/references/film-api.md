# `window.kit` 与 `window.CUT` 接口（motion / film-api）

沙箱预置 `window.kit`：
- `kit.width`、`kit.height`、`kit.fps`
- `kit.clamp(v, lo = 0, hi = 1)`、`kit.lerp(a, b, p)`、`kit.invLerp(a, b, v)`
- `kit.remap(v, in0, in1, out0, out1, easeFn)`
- `kit.ease`：`linear`、`outCubic`、`inOutCubic`、`outQuart`、`outBack`、`spring(p, damping)`
- `kit.stagger(t, index, start, step, dur, easeFn)`：计算列表第 `index` 项的错落进场进度（0..1）
- `kit.typist(text, progress)`：打字机裁剪字符串
- `kit.sceneAt(scenes, t)` → `{ index, scene, local, progress, start, end }`
- `kit.module("scenes")`：读取 `"modules/scenes.json"`
