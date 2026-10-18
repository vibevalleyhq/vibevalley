package tool

import (
	"fmt"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/num"
	"vibevalley/pkg/x/str"
)

func wan(n int64) string {
	if n >= 10_000 {
		digits := 1
		if n >= 100_000 {
			digits = 0
		}
		return num.Fixed(float64(n)/10_000, digits) + " 万"
	}
	return strconv.FormatInt(n, 10)
}

func spentText(spent protocol.Spent) string {
	tokens := wan(spent.Tokens) + " token"
	if spent.CNY != nil {
		return "约 " + protocol.Yuan(*spent.CNY) + " · " + tokens
	}
	return tokens
}

// JS's s.slice(-n), without splitting a character.
func tail(s string, n int) string {
	units := 0
	runes := []rune(s)
	for i := len(runes) - 1; i >= 0; i-- {
		units += utf16.RuneLen(runes[i])
		if units > n {
			return string(runes[i+1:])
		}
	}
	return s
}

func changesText(c protocol.Changes) string {
	paths := func(items []protocol.UncommittedItem) string {
		out := make([]string, len(items))
		for i, f := range items {
			out[i] = f.Path
		}
		return strings.Join(out, "、")
	}
	if c.Branch == nil || *c.Branch == "" {
		left := "没有"
		if len(c.Uncommitted) > 0 {
			left = paths(c.Uncommitted)
		}
		return fmt.Sprintf("它直接在项目 %s 里干活，没有分支可合。没提交的改动：%s", c.Project, left)
	}
	lines := []string{fmt.Sprintf("%s → %s 的 %s：%d 个提交，改了 %d 个文件。", *c.Branch, c.Project, c.Base, len(c.Commits), len(c.Files))}
	for _, x := range c.Commits[:min(len(c.Commits), 10)] {
		lines = append(lines, "- "+x.Hash+" "+x.Subject)
	}
	if len(c.Files) > 0 {
		files := make([]string, 0, min(len(c.Files), 30))
		for _, f := range c.Files[:min(len(c.Files), 30)] {
			counts := fmt.Sprintf("+%d −%d", f.Added, f.Removed)
			if f.Added < 0 {
				counts = "二进制"
			}
			files = append(files, f.Path+"（"+counts+"）")
		}
		lines = append(lines, "文件："+strings.Join(files, "、"))
	}
	if len(c.Uncommitted) > 0 {
		lines = append(lines, "还没提交（收获时会一起提交）："+paths(c.Uncommitted))
	}
	if c.Behind > 0 {
		lines = append(lines, fmt.Sprintf("这期间 %s 上多了 %d 个提交。", c.Base, c.Behind))
	}
	if len(c.Conflicts) > 0 {
		lines = append(lines, "合进去会冲突："+strings.Join(c.Conflicts, "、")+"。收获前要先让它解决。")
	} else {
		lines = append(lines, "能干净地合进去。")
	}
	return strings.Join(lines, "\n")
}

func sessionLine(w session.Roster) string {
	h := w.Session
	last := ""
	if h.LastRun != nil {
		how := "停下了"
		switch h.LastRun.Outcome {
		case protocol.OutcomeCompleted:
			how = "做完了"
		case protocol.OutcomeFailed:
			how = "失败了"
		case protocol.OutcomeInterrupted:
		}
		last = "；上一轮" + how + "：" + str.Head(h.LastRun.Summary, 80)
	}
	where := "在 " + w.Place.Project
	if w.Place.Branch != "" {
		where = "在 " + w.Place.Project + " 的 " + w.Place.Branch
	}
	task := ""
	if h.Graph != nil {
		if h.Graph.Task != nil {
			task = "，做计划 " + h.Graph.ID + " 的步骤 " + *h.Graph.Task
		} else {
			task = "，在拆计划 " + h.Graph.ID
		}
	}
	spent := ""
	if h.Spent != nil {
		spent = "；花了" + spentText(*h.Spent)
	}
	return fmt.Sprintf("- %s（%s，%s，%s%s）工单「%s」，%s%s%s", h.Name, h.ID, protocol.RuntimeLabel(h.Runtime), where, task,
		str.Head(h.Brief, 60), protocol.PhaseText(h, clock.NowMs()), last, spent)
}

func scheduleLine(s protocol.Schedule, channel string) string {
	direct := ""
	if s.Agent != nil {
		direct = "，直接派给 " + *s.Agent
		if s.Project != nil {
			direct += " 去 " + *s.Project
		}
	}
	next := protocol.NextText(s)
	if s.Enabled {
		next = "下次 " + next
	}
	return fmt.Sprintf("- %s 号「%s」#%s %s%s；%s\n  %s", s.ID, s.Name, channel, protocol.WhenText(s.When, s.TZ), direct, next, s.Text)
}

// The way JS's Date reads the forms a model writes.
func parseTime(s string) (int64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	for _, layout := range []string{time.RFC3339Nano, "2006-01-02T15:04:05Z0700", "2006-01-02T15:04Z07:00"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	// Without a zone, a date-time is local time; a date alone is UTC midnight (as JS reads them).
	for _, layout := range []string{"2006-01-02T15:04:05.999999999", "2006-01-02T15:04", "2006-01-02 15:04:05", "2006-01-02 15:04"} {
		if t, err := time.ParseInLocation(layout, s, time.Local); err == nil {
			return t.UnixMilli(), true
		}
	}
	if t, err := time.Parse("2006-01-02", s); err == nil {
		return t.UnixMilli(), true
	}
	return 0, false
}

// Words in a helper's report or a page it read can ask for a merge; only the owner's can make one. The tool stays in the list, so that
// the prompt's prefix does not change from round to round.
const mergeNotAsked = "没合：合进主分支要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要收。"

// A task starts many helpers at once and spends for each: only the owner's words start one, as with a merge.
const startNotAsked = "没开工：计划开工要主人点头。这一轮不是主人叫你的：把拆好的计划给主人看，问要不要开工。"

// How a session reads to the manager, in its situation as in roster.
func (*Service) SessionLine(w session.Roster) string { return sessionLine(w) }
