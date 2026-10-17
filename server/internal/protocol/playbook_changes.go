package protocol

// What changed in a playbook, step by step, and how each change is said.

import (
	"fmt"
	"slices"
	"strings"

	"vibevalley/pkg/x/ptr"
)

type PlaybookChange struct {
	Playbook string            `json:"playbook"`
	Node     *string           `json:"node,omitzero"`
	Kind     PlaybookEventKind `json:"kind"`
	Worker   *string           `json:"worker,omitzero"`
	Detail   *string           `json:"detail,omitzero"`
	Changes  []NodeFieldChange `json:"changes,omitzero"`
	Commits  []string          `json:"commits,omitzero"`
}

var nodeFields = []struct {
	field string
	text  func(PlaybookNode) string
}{
	{"标题", func(n PlaybookNode) string { return n.Title }},
	{"工单", func(n PlaybookNode) string { return n.Task }},
	{"要等的", func(n PlaybookNode) string { return strings.Join(n.Needs, "、") }},
	{"谁来做", func(n PlaybookNode) string { return ptr.Value(n.Agent) }},
	{"检查", func(n PlaybookNode) string { return ptr.Value(n.Check) }},
	{"该改的地方", func(n PlaybookNode) string { return strings.Join(n.Scope, "、") }},
}

func NodeFieldChanges(was, now PlaybookNode) []NodeFieldChange {
	out := []NodeFieldChange{}
	for _, f := range nodeFields {
		if from, to := f.text(was), f.text(now); from != to {
			out = append(out, NodeFieldChange{Field: f.field, From: from, To: to})
		}
	}
	return out
}

// Every write of a playbook goes through here, so its history misses nothing.
func PlaybookChanges(before *Playbook, after Playbook) []PlaybookChange {
	out := []PlaybookChange{}
	plan := func(kind PlaybookEventKind, detail *string) {
		c := PlaybookChange{Playbook: after.ID, Kind: kind}
		if detail != nil && *detail != "" {
			c.Detail = detail
		}
		out = append(out, c)
	}
	if before == nil {
		plan(PlaybookEventKindPlanning, &after.Goal)
		return out
	}
	if before.State != after.State {
		switch after.State {
		case PlaybookStatePlanning:
		case PlaybookStateDraft:
			steps := fmt.Sprintf("%d 步", len(after.Nodes))
			plan(PlaybookEventKindDrafted, &steps)
		case PlaybookStateRunning:
			if before.State == PlaybookStatePaused {
				plan(PlaybookEventKindResumed, nil)
			} else {
				plan(PlaybookEventKindStarted, after.Branch)
			}
		case PlaybookStatePaused:
			plan(PlaybookEventKindPaused, after.Note)
		case PlaybookStateRipe:
			plan(PlaybookEventKindRipe, nil)
		case PlaybookStateDone:
			plan(PlaybookEventKindMerged, nil)
		case PlaybookStateAbandoned:
			plan(PlaybookEventKindAbandoned, after.Note)
		}
	} else if after.Note != nil && *after.Note != "" && (before.Note == nil || *before.Note != *after.Note) {
		plan(PlaybookEventKindNoted, after.Note)
	}
	if before.State == PlaybookStatePlanning || after.State == PlaybookStateAbandoned {
		return out
	}

	step := func(n PlaybookNode, kind PlaybookEventKind, extra PlaybookChange) {
		id := n.ID
		extra.Playbook, extra.Node, extra.Kind = after.ID, &id, kind
		out = append(out, extra)
	}
	for _, n := range after.Nodes {
		was := NodeOf(*before, n.ID)
		if was == nil {
			title := n.Title
			step(n, PlaybookEventKindNodeAdded, PlaybookChange{Detail: &title})
			continue
		}
		if changes := NodeFieldChanges(*was, n); len(changes) > 0 {
			step(n, PlaybookEventKindNodeEdited, PlaybookChange{Changes: changes})
		}
		if was.State == n.State {
			if n.State == NodeStateWorking && n.Tries > was.Tries {
				var who PlaybookChange
				if n.Worker != nil && *n.Worker != "" {
					who.Worker = n.Worker
				}
				step(n, PlaybookEventKindNodeSentBack, who)
			}
			continue
		}
		worker := n.Worker
		if worker == nil {
			worker = was.Worker
		}
		var who PlaybookChange
		if worker != nil && *worker != "" {
			who.Worker = worker
		}
		switch n.State {
		case NodeStateWorking:
			if was.State == NodeStateFailed {
				step(n, PlaybookEventKindNodeRetried, who)
			} else {
				step(n, PlaybookEventKindNodeStarted, who)
			}
		case NodeStateMerged:
			if n.Conclusion != nil && *n.Conclusion != "" {
				who.Detail = n.Conclusion
			}
			if len(n.Commits) > 0 {
				who.Commits = n.Commits
			}
			step(n, PlaybookEventKindNodeMerged, who)
		case NodeStateFailed:
			if n.Conclusion != nil && *n.Conclusion != "" {
				who.Detail = n.Conclusion
			}
			step(n, PlaybookEventKindNodeFailed, who)
		case NodeStateWaiting:
			if was.State == NodeStateFailed {
				step(n, PlaybookEventKindNodeRetried, who)
			} else {
				step(n, PlaybookEventKindNodeRequeued, who)
			}
		case NodeStateSkipped:
			step(n, PlaybookEventKindNodeSkipped, PlaybookChange{})
		}
	}
	for _, was := range before.Nodes {
		if !slices.ContainsFunc(after.Nodes, func(n PlaybookNode) bool { return n.ID == was.ID }) {
			id, title := was.ID, was.Title
			out = append(out, PlaybookChange{Playbook: after.ID, Node: &id, Kind: PlaybookEventKindNodeRemoved, Detail: &title})
		}
	}
	return out
}

var ActorText = map[PlaybookActor]string{PlaybookActorUser: "主人", PlaybookActorManager: "管家", PlaybookActorSystem: "农场"}

func PlaybookEventText(e PlaybookChange, titleOf func(node string) string) string {
	if titleOf == nil {
		titleOf = func(id string) string { return id }
	}
	step := "「」"
	if e.Node != nil && *e.Node != "" {
		step = "「" + titleOf(*e.Node) + "」"
	}
	by, why, detail := "", "", ""
	if e.Worker != nil && *e.Worker != "" {
		by = "（" + *e.Worker + "）"
	}
	if e.Detail != nil && *e.Detail != "" {
		detail = *e.Detail
		why = "：" + detail
	}
	switch e.Kind {
	case PlaybookEventKindPlanning:
		return "要拆一张计划" + why
	case PlaybookEventKindDrafted:
		if detail != "" {
			return "拆好了，" + detail + "，等主人看"
		}
		return "拆好了，等主人看"
	case PlaybookEventKindStarted:
		if detail != "" {
			return "开工了，分支 " + detail
		}
		return "开工了"
	case PlaybookEventKindPaused:
		return "暂停了" + why
	case PlaybookEventKindResumed:
		return "接着做了"
	case PlaybookEventKindRipe:
		return "都做完了，等收获"
	case PlaybookEventKindMerged:
		return "收进了主分支"
	case PlaybookEventKindAbandoned:
		return "放弃了" + why
	case PlaybookEventKindNoted:
		return ptr.Value(e.Detail)
	case PlaybookEventKindNodeStarted:
		return step + "开工" + by
	case PlaybookEventKindNodeSentBack:
		return step + "退回去重做" + by + why
	case PlaybookEventKindNodeMerged:
		commits := ""
		if len(e.Commits) > 0 {
			commits = "（" + strings.Join(e.Commits, "、") + "）"
		}
		return step + "合进了计划分支" + commits + why
	case PlaybookEventKindNodeFailed:
		return step + "没做成" + why
	case PlaybookEventKindNodeRetried:
		return step + "重试"
	case PlaybookEventKindNodeRequeued:
		return step + "没有帮工在做了，重新排上"
	case PlaybookEventKindNodeSkipped:
		return step + "跳过了，后面的照做"
	case PlaybookEventKindNodeEdited:
		fields := make([]string, len(e.Changes))
		for i, c := range e.Changes {
			fields[i] = c.Field
		}
		return "改了" + step + "的" + strings.Join(fields, "、")
	case PlaybookEventKindNodeAdded:
		return "加了一步" + step
	case PlaybookEventKindNodeRemoved:
		name := ""
		if e.Detail != nil {
			name = *e.Detail
		} else if e.Node != nil {
			name = *e.Node
		}
		return "删了一步「" + name + "」"
	}
	return ""
}
