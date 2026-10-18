package main

import (
	"fmt"
	"slices"
	"strings"
)

// capabilities is docs/reference/capabilities.md: every endpoint and who may call it, from vibevalley:can.
func (s *shapes) capabilities() string {
	var b strings.Builder
	b.WriteString(`# 能力表

由 ` + "`server/tool/shapegen`" + ` 从 ` + "`server/internal/protocol/api.go`" + ` 的 ` + "`//vibevalley:route`" + ` 和 ` + "`//vibevalley:can`" + ` 写出，不手改；` + "`go run ./tool/shapegen -check`" + ` 查它是不是最新。为什么这样分见 [先有能力，再有入口](docs/subsystems/core.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | Flutter、命令行 |
| 连进来的设备 | 主人配对过的手机、另一台电脑 | 经「连接到本机」只放这一列打了 ✓ 的 |
| 管家 | 管家 | 只是记下，不按它放行：管家的工具另写在 `+"`internal/tool`"+` |
| Session | 帮工 | 没有接口打 ✓：帮工经 `+"`/mcp`"+` 用 `+"`internal/tool`"+` 的工具 |

管家、Session 两列要去掉，agent 能调什么写在档案上（[管家是一份档案](.agents/notes/proposed/architecture/2026-10-17-manager-is-an-agent.md)）。

` + "`GET /api/v1/state`" + `、` + "`GET /api/v1/events`" + ` 和 ` + "`GET /api/v1/live`" + ` 是 SSE，不在 ` + "`Handlers`" + ` 里：主人和连进来的设备都能读；` + "`/state`" + ` 给折好的帧，` + "`/live`" + ` 只给客户端要的三种 side event，` + "`/events`" + ` 留给命令行和调试。接口都在 ` + "`/api/v1`" + ` 下；换成不兼容的形状时另起 ` + "`/api/v2`" + `，` + "`v1`" + ` 留到设备都升级（[理由](docs/subsystems/core.md)）。
`)
	// Groups in the order api.go first names them; api.go interleaves them.
	var groups []string
	for _, r := range s.routes {
		if !slices.Contains(groups, r.group) {
			groups = append(groups, r.group)
		}
	}
	for _, group := range groups {
		fmt.Fprintf(&b, "\n## %s\n\n| 操作 | 方法和路径 | 主人 | 连进来的设备 | 管家 | Session |\n|---|---|---|---|---|---|\n", group)
		for _, r := range s.routes {
			if r.group != group {
				continue
			}
			mark := func(c string) string {
				if slices.Contains(r.can, c) {
					return "✓"
				}
				return ""
			}
			fmt.Fprintf(&b, "| `%s.%s` | `%s %s` | %s | %s | %s | %s |\n", r.group, r.op, r.method, r.path, mark("owner"), mark("remote"), mark("manager"), mark("session"))
		}
	}
	return b.String()
}
