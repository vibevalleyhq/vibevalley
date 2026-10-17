package manager

// No model: each item waits out its kind's grace (a question may be answered in a minute), is reported once, and again only
// after reportAgainMs if it still stands.

import (
	"strconv"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/num"
)

// In ms. Kinds not here the manager does not hear of from the patrol: a failed run reaches it as it happens, a playbook waiting is the person's to
// look at.
var patrolGrace = map[protocol.InboxKind]int64{
	protocol.InboxKindMention:    15 * 60_000,
	protocol.InboxKindQuiet:      20 * 60_000,
	protocol.InboxKindMerge:      2 * 60 * 60_000,
	protocol.InboxKindConflict:   2 * 60 * 60_000,
	protocol.InboxKindPlanFailed: 30 * 60_000,
}

type patrolNote struct {
	Key     string
	Channel *string
	Text    string
}

const reportAgainMs = 4 * 60 * 60_000

type patrolMemory struct {
	FirstSeen map[string]int64
	Reported  map[string]int64
}

func emptyPatrol() patrolMemory {
	return patrolMemory{FirstSeen: map[string]int64{}, Reported: map[string]int64{}}
}

func patrolAgo(ms int64) string {
	if ms >= 2*60*60_000 {
		return strconv.FormatInt(int64(num.Round(float64(ms)/(60*60_000))), 10) + " 小时"
	}
	return strconv.FormatInt(max(1, int64(num.Round(float64(ms)/60_000))), 10) + " 分钟"
}

// Things no longer hanging are forgotten, so if they come back they are new.
func patrolStep(state protocol.CoreState, now int64, memory patrolMemory) ([]patrolNote, patrolMemory) {
	next := emptyPatrol()
	report := []patrolNote{}
	for _, e := range protocol.InboxEntries(state) {
		grace, ok := patrolGrace[e.Item.Kind]
		if !ok {
			continue
		}
		key := e.Item.ID
		seen, ok := memory.FirstSeen[key]
		if !ok {
			seen = now
		}
		next.FirstSeen[key] = seen
		since := seen
		if e.Since != nil {
			since = *e.Since
		}
		last, reported := memory.Reported[key]
		if reported {
			next.Reported[key] = last
		}
		if now-since < grace {
			continue
		}
		if reported && now-last < reportAgainMs {
			continue
		}
		next.Reported[key] = now
		report = append(report, patrolNote{Key: key, Channel: e.Channel, Text: strings.Replace(e.Brief, "{ago}", patrolAgo(now-since), 1)})
	}
	return report, next
}

func patrolText(channelName string, found []patrolNote) string {
	lines := make([]string, len(found))
	for i, f := range found {
		lines[i] = "- " + f.Text
	}
	return "【巡查】#" + channelName + " 里有几件事放着没人管：\n" + strings.Join(lines, "\n") +
		"\n\n看看要不要提醒主人（一两句，说在 #" + channelName + "）、催帮工或者叫停；都不用管就什么也别说。"
}
