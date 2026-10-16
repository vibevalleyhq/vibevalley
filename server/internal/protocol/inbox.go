package protocol

// The inbox: what needs the person now, worked out from the state. The farm rings it on the phone and the desktop
// bell; the patrol (patrol.go) tells the manager about what has waited past its grace. A playbook's own helpers leave
// their finished, failed and conflicted work to the playbook, which asks in their place; a quiet one still asks.

import (
	"cmp"
	"fmt"
	"slices"
	"strconv"
)

// inboxEntry is an item with what the patrol needs besides: the channel it belongs in (nil: the square), when it began
// (nil: when the patrol first saw it), and how to tell the manager about it ({ago} is filled with how long).
type inboxEntry struct {
	item    InboxItem
	channel *int64
	since   *int64
	brief   string
}

// Inbox is every item standing now, newest first; items of the same moment in the order they are gathered: helpers as
// the farm lists them, then playbooks oldest first and their steps, then messages by conversation.
func Inbox(state FarmState) []InboxItem {
	items := []InboxItem{}
	for _, e := range inboxEntries(state) {
		items = append(items, e.item)
	}
	slices.SortStableFunc(items, func(a, b InboxItem) int { return cmp.Compare(b.At, a.At) })
	return items
}

func inboxEntries(state FarmState) []inboxEntry {
	chat := state.Chat
	square := patrolID(SquareOf(chat))
	out := []inboxEntry{}
	for _, h := range state.Helpers {
		need := NeedOf(h)
		if need == nil || need.Kind == "retrying" || (h.Playbook != nil && need.Kind != "quiet") {
			continue
		}
		channel := square
		if h.Channel != nil {
			c := *h.Channel
			channel = &c
		}
		from := InboxFrom{InboxFromHelper{ID: h.ID, Name: h.Name, Agent: h.Agent}}
		target := InboxTarget{InboxTargetWorker{ID: h.ID}}
		at := h.HiredAt
		summary := h.Task
		if h.Last != nil {
			at = h.Last.At
			if h.Last.Summary != "" {
				summary = h.Last.Summary
			}
		}
		who := h.Name + "（" + h.ID + "）"
		switch need.Kind {
		case "harvest":
			out = append(out, inboxEntry{
				item:    InboxItem{ID: fmt.Sprintf("%s:harvest:%d", h.ID, h.Turns), Kind: InboxKindHarvest, From: from, Text: Clip(summary, 40), At: at, Target: target},
				channel: channel, since: &at,
				brief: who + "的活做完 {ago}了还没收：「" + playbookSlice(h.Task, 60) + "」",
			})
		case "fix":
			out = append(out, inboxEntry{
				item:    InboxItem{ID: fmt.Sprintf("%s:fix:%d", h.ID, h.Turns), Kind: InboxKindFix, From: from, Text: Clip(summary, 40), At: at, Target: target},
				channel: channel, since: &at,
				brief: who + "这一轮没做成，{ago}没人管了：「" + playbookSlice(summary, 60) + "」",
			})
		case "conflict":
			out = append(out, inboxEntry{
				item: InboxItem{ID: fmt.Sprintf("%s:conflict:%d", h.ID, h.Turns), Kind: InboxKindConflict, From: from,
					Text: fmt.Sprintf("%d 个文件和主分支冲突", len(need.Conflict.Files)), At: at, Target: target},
				channel: channel, since: &at,
				brief: who + fmt.Sprintf("的活合进主分支会冲突（%d 个文件），{ago}没人管了", len(need.Conflict.Files)),
			})
		case "quiet":
			since := need.Since
			doing := "想事情"
			if p, ok := h.Phase.Value.(PhaseWorking); ok && p.Doing.Label != "" {
				doing = "「" + p.Doing.Label + "」"
			}
			out = append(out, inboxEntry{
				item:    InboxItem{ID: fmt.Sprintf("%s:quiet:%d", h.ID, since), Kind: InboxKindQuiet, From: from, Text: Clip(h.Task, 40), At: since, Target: target},
				channel: channel, since: &since,
				brief: who + "在干活，{ago}没动静了，最后在" + doing,
			})
		}
	}

	manager := InboxFrom{InboxFromManager{}}
	for _, pb := range PlaybooksOf(state) {
		target := InboxTarget{InboxTargetPlans{Playbook: pb.ID}}
		switch pb.State {
		case PlaybookStateDraft:
			out = append(out, inboxEntry{
				item:    InboxItem{ID: pb.ID + ":draft", Kind: InboxKindPlanDraft, From: manager, Text: Clip(pb.Title, 40), At: pb.CreatedAt, Target: target},
				channel: square, brief: "种植计划「" + pb.Title + "」（" + pb.ID + "）拆好了，{ago}还没人看",
			})
		case PlaybookStateRipe:
			out = append(out, inboxEntry{
				item:    InboxItem{ID: pb.ID + ":ripe", Kind: InboxKindPlanRipe, From: manager, Text: Clip(pb.Title, 40), At: pb.CreatedAt, Target: target},
				channel: square, brief: "种植计划「" + pb.Title + "」（" + pb.ID + "）都做完了，{ago}还没收",
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
					why = "：" + playbookSlice(*node.Conclusion, 80)
				}
				out = append(out, inboxEntry{
					item:    InboxItem{ID: id, Kind: InboxKindPlanFailed, From: manager, Text: Clip(pb.Title+"："+node.Title, 40), At: pb.CreatedAt, Target: target},
					channel: square,
					brief:   "种植计划「" + pb.Title + "」（" + pb.ID + "）的步骤 " + node.ID + "「" + node.Title + "」没做成，{ago}没人管了" + why,
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
				if m.FromKind == SenderKindHelper {
					agent := ""
					if m.Agent != nil {
						agent = *m.Agent
					}
					from = InboxFrom{InboxFromHelper{ID: m.From, Name: m.Name, Agent: agent}}
				}
				since := m.At
				out = append(out, inboxEntry{
					item: InboxItem{ID: "m" + strconv.FormatInt(m.Seq, 10), Kind: InboxKindMention, From: from, Text: Clip(m.Text, 40), At: m.At,
						Target: InboxTarget{InboxTargetChat{Conversation: c.ID}}},
					channel: patrolID(ChannelOf(chat, &c)), since: &since,
					brief: m.Name + " 在 " + AddressOf(chat, c) + " 问主人的话，{ago}没人回：「" + playbookSlice(patrolOneLine(m.Text), 80) + "」",
				})
			}
		}
	}
	return out
}
