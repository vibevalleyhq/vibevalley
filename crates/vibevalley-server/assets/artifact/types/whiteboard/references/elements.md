# 元素坐标与连线规范（whiteboard / elements）

- 坐标系：左上角为 `(x, y)`，单位像素，宽高 `w`、`h` 为正数。
- 局部更新：移动单个元素优先发 `{ op: "patch", path: "elements/n1", value: "{\"x\":240,\"y\":180}", ifRev: 1 }`，不覆盖其它字段。
- 颜色语义：`leaf`（通过/核心流程）、`water`（存储/外部系统）、`wheat`（注意/判断分支）、`berry`（异常/风险）、`neutral`（通用说明）。
