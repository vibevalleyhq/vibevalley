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

由 ` + "`server/tool/shapegen`" + ` 从 ` + "`server/internal/protocol/api.go`" + ` 的 ` + "`//vibevalley:route`" + ` 和 ` + "`//vibevalley:can`" + ` 写出，不手改；` + "`go run ./tool/shapegen -check`" + ` 查它是不是最新。为什么这样分见 [先有能力，再有入口](../../.agents/notes/proposed/architecture/2026-10-17-capabilities-before-surfaces.md)。

| 谁 | 是谁 | 从哪个入口 |
|---|---|---|
| 主人 | 主人在农场那台电脑上 | Flutter、命令行 |
| 院门 | 主人配对过的设备 | 院门只放这一列打了 ✓ 的 |
| 管家 | 管家 | 管家的工具 |
| Session | 帮工 | 带钥匙的命令行 |

` + "`GET /api/state`" + ` 和 ` + "`GET /api/events`" + ` 是 SSE，不在 ` + "`Handlers`" + ` 里：主人和院门都能读。
`)
	// Groups in the order api.go first names them; api.go interleaves them.
	var groups []string
	for _, r := range s.routes {
		if !slices.Contains(groups, r.group) {
			groups = append(groups, r.group)
		}
	}
	for _, group := range groups {
		fmt.Fprintf(&b, "\n## %s\n\n| 操作 | 方法和路径 | 主人 | 院门 | 管家 | Session |\n|---|---|---|---|---|---|\n", group)
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
