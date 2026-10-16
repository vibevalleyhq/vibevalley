package protocol

// No model: each item waits out its kind's grace (a question may be answered in a minute), is reported once, and again only after ReportAgainMS if it
// still stands.

import (
	"strconv"
	"strings"
)

// In ms. Kinds not here the manager does not hear of from the patrol: a failed turn reaches it as it happens, a playbook waiting is the person's to
// look at.
var PatrolGrace = map[InboxKind]int64{
	InboxKindMention:    15 * 60_000,
	InboxKindQuiet:      20 * 60_000,
	InboxKindHarvest:    2 * 60 * 60_000,
	InboxKindConflict:   2 * 60 * 60_000,
	InboxKindPlanFailed: 30 * 60_000,
}

type PatrolNote struct {
	Key     string
	Channel *int64
	Text    string
}

const ReportAgainMS = 4 * 60 * 60_000

type PatrolMemory struct {
	FirstSeen map[string]int64
	Reported  map[string]int64
}

func EmptyPatrol() PatrolMemory {
	return PatrolMemory{FirstSeen: map[string]int64{}, Reported: map[string]int64{}}
}

func patrolAgo(ms int64) string {
	if ms >= 2*60*60_000 {
		return strconv.FormatInt(progressRound(float64(ms)/(60*60_000)), 10) + " 小时"
	}
	return strconv.FormatInt(max(1, progressRound(float64(ms)/60_000)), 10) + " 分钟"
}

func patrolID(c *Conversation) *int64 {
	if c == nil {
		return nil
	}
	id := c.ID
	return &id
}

func patrolOneLine(text string) string {
	var b strings.Builder
	space := false
	for _, r := range text {
		if coreIsSpace(r) {
			if !space {
				b.WriteByte(' ')
			}
			space = true
			continue
		}
		space = false
		b.WriteRune(r)
	}
	return b.String()
}

// Things no longer hanging are forgotten, so if they come back they are new.
func PatrolStep(state FarmState, now int64, memory PatrolMemory) ([]PatrolNote, PatrolMemory) {
	next := EmptyPatrol()
	report := []PatrolNote{}
	for _, e := range inboxEntries(state) {
		grace, ok := PatrolGrace[e.item.Kind]
		if !ok {
			continue
		}
		key := e.item.ID
		seen, ok := memory.FirstSeen[key]
		if !ok {
			seen = now
		}
		next.FirstSeen[key] = seen
		since := seen
		if e.since != nil {
			since = *e.since
		}
		last, reported := memory.Reported[key]
		if reported {
			next.Reported[key] = last
		}
		if now-since < grace {
			continue
		}
		if reported && now-last < ReportAgainMS {
			continue
		}
		next.Reported[key] = now
		report = append(report, PatrolNote{Key: key, Channel: e.channel, Text: strings.Replace(e.brief, "{ago}", patrolAgo(now-since), 1)})
	}
	return report, next
}

func PatrolText(channelName string, found []PatrolNote) string {
	lines := make([]string, len(found))
	for i, f := range found {
		lines[i] = "- " + f.Text
	}
	return "【巡查】#" + channelName + " 里有几件事放着没人管：\n" + strings.Join(lines, "\n") +
		"\n\n看看要不要提醒主人（一两句，说在 #" + channelName + "）、催帮工或者叫停；都不用管就什么也别说。"
}
