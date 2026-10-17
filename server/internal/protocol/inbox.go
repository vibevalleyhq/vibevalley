package protocol

// A playbook's own sessions leave their finished, failed and conflicted work to the playbook, which asks in their place; a quiet one still asks.

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
	"strings"

	"vibevalley/pkg/x/str"
)

// What is waiting on someone, as the inbox and the manager's patrol read it. Channel nil: the general channel; Since nil:
// from when the reader first saw it. Brief is for the manager, {ago} filled with how long it has waited.
type InboxEntry struct {
	Item    InboxItem
	Channel *int64
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
		if need == nil || need.Kind == "retrying" || (h.Playbook != nil && need.Kind != "quiet") {
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
		summary := h.Task
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
				Brief: who + "的活做完 {ago}了还没收：「" + str.Slice(h.Task, 0, 60) + "」",
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
				Item:    InboxItem{ID: fmt.Sprintf("%s:quiet:%d", h.ID, since), Kind: InboxKindQuiet, From: from, Text: str.Cut(h.Task, 40), At: since, Target: target},
				Channel: channel, Since: &since,
				Brief: who + "在干活，{ago}没动静了，最后在" + doing,
			})
		}
	}

	manager := InboxFrom{InboxFromManager{}}
	for _, pb := range PlaybooksOf(state) {
		target := InboxTarget{InboxTargetPlans{Playbook: pb.ID}}
		switch pb.State {
		case PlaybookStateDraft:
			out = append(out, InboxEntry{
				Item:    InboxItem{ID: pb.ID + ":draft", Kind: InboxKindPlanDraft, From: manager, Text: str.Cut(pb.Title, 40), At: pb.CreatedAt, Target: target},
				Channel: general, Brief: "种植计划「" + pb.Title + "」（" + pb.ID + "）拆好了，{ago}还没人看",
			})
		case PlaybookStateRipe:
			out = append(out, InboxEntry{
				Item:    InboxItem{ID: pb.ID + ":ripe", Kind: InboxKindPlanRipe, From: manager, Text: str.Cut(pb.Title, 40), At: pb.CreatedAt, Target: target},
				Channel: general, Brief: "种植计划「" + pb.Title + "」（" + pb.ID + "）都做完了，{ago}还没收",
			})
		case PlaybookStateRunning, PlaybookStatePaused:
			for _, node := range pb.Nodes {
				if node.State != NodeStateFailed {
					continue
				}
				// A step retried and failed again asks again: from its second failure the id counts them.
				id := pb.ID + ":failed:" + node.ID
				if node.Failures > 1 {
					id += fmt.Sprintf(":%d", node.Failures)
				}
				why := ""
				if node.Conclusion != nil && *node.Conclusion != "" {
					why = "：" + str.Slice(*node.Conclusion, 0, 80)
				}
				out = append(out, InboxEntry{
					Item:    InboxItem{ID: id, Kind: InboxKindPlanFailed, From: manager, Text: str.Cut(pb.Title+"："+node.Title, 40), At: pb.CreatedAt, Target: target},
					Channel: general,
					Brief:   "种植计划「" + pb.Title + "」（" + pb.ID + "）的步骤 " + node.ID + "「" + node.Title + "」没做成，{ago}没人管了" + why,
				})
			}
		}
	}

	// A message said in full that names the person, not read and not answered in its conversation yet.
	if chat != nil {
		lastFromUser := map[int64]int64{}
		for _, m := range chat.Messages {
			if m.From == "user" {
				lastFromUser[m.Conversation] = max(lastFromUser[m.Conversation], m.Seq)
			}
		}
		for _, c := range chat.Conversations {
			read := int64(0)
			if c.Read != nil {
				read = *c.Read
			}
			for _, m := range MessagesIn(chat, c.ID) {
				if !m.Final || m.From == "user" || m.Seq <= read || lastFromUser[c.ID] > m.Seq || !slices.Contains(m.Mentions, "user") {
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
					Item: InboxItem{ID: "m" + strconv.FormatInt(m.Seq, 10), Kind: InboxKindMention, From: from, Text: str.Cut(m.Text, 40), At: m.At,
						Target: InboxTarget{InboxTargetChat{Conversation: c.ID}}},
					Channel: conversationID(ChannelOf(chat, &c)), Since: &since,
					Brief: m.Name + " 在 " + AddressOf(chat, c) + " 问主人的话，{ago}没人回：「" + str.Slice(oneLine(m.Text), 0, 80) + "」",
				})
			}
		}
	}
	return out
}

func conversationID(c *Conversation) *int64 {
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
