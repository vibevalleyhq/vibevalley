package protocol

// A task's own sessions leave their finished, failed and conflicted work to the task, which asks in their place; a quiet one still asks.

import (
	"cmp"
	"fmt"
	"slices"
	"strings"

	"vibevalley/pkg/x/str"
)

// What is waiting on someone, as the inbox and the manager's patrol read it. Channel nil: the general channel; Since nil:
// from when the reader first saw it. Brief is for the manager, {ago} filled with how long it has waited.
type InboxEntry struct {
	Item    InboxItem
	Channel *string
	Since   *int64
	Brief   string
}

// Newest first; items of the same moment in the order they are gathered.
func Inbox(state CoreState) []InboxItem {
	items := []InboxItem{}
	for _, e := range InboxEntries(state) {
		items = append(items, e.Item)
	}
	slices.SortStableFunc(items, func(a, b InboxItem) int { return cmp.Compare(b.At, a.At) })
	return items
}

func InboxEntries(state CoreState) []InboxEntry {
	chat := state.Chat
	general := conversationID(GeneralOf(chat))
	out := []InboxEntry{}
	for _, h := range state.Sessions {
		need := NeedOf(h)
		if need == nil || need.Kind == "retrying" || (h.Graph != nil && need.Kind != "quiet") {
			continue
		}
		channel := general
		if h.Channel != nil {
			c := *h.Channel
			channel = &c
		}
		from := InboxFrom{InboxFromSession{ID: h.ID, Name: h.Name, Agent: h.Agent}}
		target := InboxTarget{InboxTargetSession{ID: h.ID}}
		at := h.HiredAt
		summary := h.Brief
		if h.LastRun != nil {
			at = h.LastRun.At
			if h.LastRun.Summary != "" {
				summary = h.LastRun.Summary
			}
		}
		who := h.Name + "（" + h.ID + "）"
		switch need.Kind {
		case "harvest":
			out = append(out, InboxEntry{
				Item:    InboxItem{ID: fmt.Sprintf("%s:merge:%d", h.ID, h.Runs), Kind: InboxKindMerge, From: from, Text: str.Cut(summary, 40), At: at, Target: target},
				Channel: channel, Since: &at,
				Brief: who + "的活做完 {ago}了还没收：「" + str.Slice(h.Brief, 0, 60) + "」",
			})
		case "fix":
			out = append(out, InboxEntry{
				Item:    InboxItem{ID: fmt.Sprintf("%s:fix:%d", h.ID, h.Runs), Kind: InboxKindFix, From: from, Text: str.Cut(summary, 40), At: at, Target: target},
				Channel: channel, Since: &at,
				Brief: who + "这一轮没做成，{ago}没人管了：「" + str.Slice(summary, 0, 60) + "」",
			})
		case "conflict":
			out = append(out, InboxEntry{
				Item: InboxItem{ID: fmt.Sprintf("%s:conflict:%d", h.ID, h.Runs), Kind: InboxKindConflict, From: from,
					Text: fmt.Sprintf("%d 个文件和主分支冲突", len(need.Conflict.Files)), At: at, Target: target},
				Channel: channel, Since: &at,
				Brief: who + fmt.Sprintf("的活合进主分支会冲突（%d 个文件），{ago}没人管了", len(need.Conflict.Files)),
			})
		case "quiet":
			since := need.Since
			doing := "想事情"
			if p, ok := h.Phase.Value.(PhaseWorking); ok && p.Doing.Label != "" {
				doing = "「" + p.Doing.Label + "」"
			}
			out = append(out, InboxEntry{
				Item:    InboxItem{ID: fmt.Sprintf("%s:quiet:%d", h.ID, since), Kind: InboxKindQuiet, From: from, Text: str.Cut(h.Brief, 40), At: since, Target: target},
				Channel: channel, Since: &since,
				Brief: who + "在干活，{ago}没动静了，最后在" + doing,
			})
		}
	}

	manager := InboxFrom{InboxFromManager{}}
	for _, graph := range GraphsOf(state) {
		target := InboxTarget{InboxTargetGraph{Graph: graph.ID}}
		switch graph.State {
		case GraphStateDraft:
			out = append(out, InboxEntry{
				Item:    InboxItem{ID: graph.ID + ":draft", Kind: InboxKindGraphDraft, From: manager, Text: str.Cut(graph.Title, 40), At: graph.CreatedAt, Target: target},
				Channel: general, Brief: "种植计划「" + graph.Title + "」（" + graph.ID + "）拆好了，{ago}还没人看",
			})
		case GraphStateRipe:
			out = append(out, InboxEntry{
				Item:    InboxItem{ID: graph.ID + ":ripe", Kind: InboxKindGraphRipe, From: manager, Text: str.Cut(graph.Title, 40), At: graph.CreatedAt, Target: target},
				Channel: general, Brief: "种植计划「" + graph.Title + "」（" + graph.ID + "）都做完了，{ago}还没收",
			})
		case GraphStateRunning, GraphStatePaused:
			for _, task := range graph.Tasks {
				if task.State != TaskStateFailed {
					continue
				}
				// A step retried and failed again asks again: from its second failure the id counts them.
				id := graph.ID + ":failed:" + task.ID
				if task.Failures > 1 {
					id += fmt.Sprintf(":%d", task.Failures)
				}
				why := ""
				if task.Conclusion != nil && *task.Conclusion != "" {
					why = "：" + str.Slice(*task.Conclusion, 0, 80)
				}
				out = append(out, InboxEntry{
					Item:    InboxItem{ID: id, Kind: InboxKindTaskFailed, From: manager, Text: str.Cut(graph.Title+"："+task.Title, 40), At: graph.CreatedAt, Target: target},
					Channel: general,
					Brief:   "种植计划「" + graph.Title + "」（" + graph.ID + "）的步骤 " + task.ID + "「" + task.Title + "」没做成，{ago}没人管了" + why,
				})
			}
		}
	}

	for _, sc := range state.Schedules {
		if !sc.Pending {
			continue
		}
		channel, since := sc.Channel, sc.Created
		out = append(out, InboxEntry{
			Item: InboxItem{ID: sc.ID + ":ask", Kind: InboxKindScheduleAsk, From: manager, Text: str.Cut(sc.Name, 40), At: sc.Created,
				Target: InboxTarget{InboxTargetChat{Conversation: sc.Channel}}},
			Channel: &channel, Since: &since,
			Brief: "定时「" + sc.Name + "」（" + sc.ID + "）等主人同意，{ago}了",
		})
	}

	// A message said in full that names the person, not read and not answered in its conversation yet.
	if chat != nil {
		lastFromUser := map[string]int64{}
		for _, m := range chat.Messages {
			if m.From == "user" {
				lastFromUser[m.Conversation] = max(lastFromUser[m.Conversation], m.Number)
			}
		}
		for _, c := range chat.Conversations {
			read := int64(0)
			if c.Read != nil {
				read = *c.Read
			}
			for _, m := range MessagesIn(chat, c.ID) {
				if !m.Final || m.From == "user" || m.Number <= read || lastFromUser[c.ID] > m.Number || !slices.Contains(m.Mentions, "user") {
					continue
				}
				from := manager
				if m.FromKind == SenderKindAgent {
					agent := ""
					if m.Agent != nil {
						agent = *m.Agent
					}
					from = InboxFrom{InboxFromSession{ID: m.From, Name: m.Name, Agent: agent}}
				}
				since := m.At
				out = append(out, InboxEntry{
					Item: InboxItem{ID: m.ID, Kind: InboxKindMention, From: from, Text: str.Cut(m.Text, 40), At: m.At,
						Target: InboxTarget{InboxTargetChat{Conversation: c.ID}}},
					Channel: conversationID(ChannelOf(chat, &c)), Since: &since,
					Brief: m.Name + " 在 " + AddressOf(chat, c) + " 问主人的话，{ago}没人回：「" + str.Slice(oneLine(m.Text), 0, 80) + "」",
				})
			}
		}
	}
	return out
}

func conversationID(c *Conversation) *string {
	if c == nil {
		return nil
	}
	id := c.ID
	return &id
}

// Runs of white space are one space.
func oneLine(text string) string {
	var b strings.Builder
	space := false
	for _, r := range text {
		if str.IsSpace(r) {
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
