package manager

import (
	"fmt"
	"strconv"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/ai"
)

// As vvagent's PrefixChanged names the parts.
var managerPrefixParts = map[string]string{
	"instructions": "说明", "env": "环境", "skills": "技能", "memory": "记性", "tools": "工具",
}

func managerTokens(u ai.Usage) protocol.EventTokens {
	return protocol.EventTokens{Input: int64(u.Input), CacheRead: int64(u.CacheRead), Output: int64(u.Output)}
}

// Groups of three digits, split by a space: 41 200.
func managerDigits(n int64) string {
	s := strconv.FormatInt(n, 10)
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 && s[i-1] != '-' {
			b.WriteByte(' ')
		}
		b.WriteRune(c)
	}
	return b.String()
}

// changed is a PrefixChanged's parts, none when the prompt's start was as before.
func managerUsageText(t protocol.EventTokens, changed []string) string {
	text := "没报读了多少：输出 " + managerDigits(t.Output)
	if prompt := t.CacheRead + t.Input; prompt > 0 {
		text = fmt.Sprintf("缓存命中 %d%%：读缓存 %s，没命中 %s，输出 %s", t.CacheRead*100/prompt, managerDigits(t.CacheRead), managerDigits(t.Input), managerDigits(t.Output))
	}
	if len(changed) > 0 {
		var parts []string
		for _, name := range changed {
			if label, ok := managerPrefixParts[name]; ok {
				parts = append(parts, label)
			} else {
				parts = append(parts, name)
			}
		}
		text += "；开头变了：" + strings.Join(parts, "、")
	}
	return text
}
