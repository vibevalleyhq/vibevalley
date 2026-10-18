package protocol

// What changed in a task, step by step, and how each change is said.

import (
	"fmt"
	"slices"
	"strings"

	"vibevalley/pkg/x/ptr"
)

type GraphChange struct {
	Graph   string            `json:"graph"`
	Task    *string           `json:"task,omitzero"`
	Kind    GraphEventKind    `json:"kind"`
	Session *string           `json:"session,omitzero"`
	Detail  *string           `json:"detail,omitzero"`
	Changes []TaskFieldChange `json:"changes,omitzero"`
	Commits []string          `json:"commits,omitzero"`
}

var taskFields = []struct {
	field string
	text  func(Task) string
}{
	{"标题", func(n Task) string { return n.Title }},
	{"工单", func(n Task) string { return n.Brief }},
	{"要等的", func(n Task) string { return strings.Join(n.Needs, "、") }},
	{"谁来做", func(n Task) string { return ptr.Value(n.Agent) }},
	{"检查", func(n Task) string { return ptr.Value(n.Check) }},
	{"该改的地方", func(n Task) string { return strings.Join(n.Scope, "、") }},
}

func TaskFieldChanges(was, now Task) []TaskFieldChange {
	out := []TaskFieldChange{}
	for _, f := range taskFields {
		if from, to := f.text(was), f.text(now); from != to {
			out = append(out, TaskFieldChange{Field: f.field, From: from, To: to})
		}
	}
	return out
}

// Every write of a task goes through here, so its history misses nothing.
func GraphChanges(before *TaskGraph, after TaskGraph) []GraphChange {
	out := []GraphChange{}
	task := func(kind GraphEventKind, detail *string) {
		c := GraphChange{Graph: after.ID, Kind: kind}
		if detail != nil && *detail != "" {
			c.Detail = detail
		}
		out = append(out, c)
	}
	if before == nil {
		task(GraphEventKindSplitting, &after.Goal)
		return out
	}
	if before.State != after.State {
		switch after.State {
		case GraphStateSplitting:
		case GraphStateDraft:
			steps := fmt.Sprintf("%d 步", len(after.Tasks))
			task(GraphEventKindDrafted, &steps)
		case GraphStateRunning:
			if before.State == GraphStatePaused {
				task(GraphEventKindResumed, nil)
			} else {
				task(GraphEventKindStarted, after.Branch)
			}
		case GraphStatePaused:
			task(GraphEventKindPaused, after.Note)
		case GraphStateRipe:
			task(GraphEventKindRipe, nil)
		case GraphStateDone:
			task(GraphEventKindMerged, nil)
		case GraphStateAbandoned:
			task(GraphEventKindAbandoned, after.Note)
		}
	} else if after.Note != nil && *after.Note != "" && (before.Note == nil || *before.Note != *after.Note) {
		task(GraphEventKindNoted, after.Note)
	}
	if before.State == GraphStateSplitting || after.State == GraphStateAbandoned {
		return out
	}

	step := func(n Task, kind GraphEventKind, extra GraphChange) {
		id := n.ID
		extra.Graph, extra.Task, extra.Kind = after.ID, &id, kind
		out = append(out, extra)
	}
	for _, n := range after.Tasks {
		was := TaskOf(*before, n.ID)
		if was == nil {
			title := n.Title
			step(n, GraphEventKindTaskAdded, GraphChange{Detail: &title})
			continue
		}
		if changes := TaskFieldChanges(*was, n); len(changes) > 0 {
			step(n, GraphEventKindTaskEdited, GraphChange{Changes: changes})
		}
		if was.State == n.State {
			if n.State == TaskStateWorking && n.Tries > was.Tries {
				var who GraphChange
				if n.Session != nil && *n.Session != "" {
					who.Session = n.Session
				}
				step(n, GraphEventKindTaskSentBack, who)
			}
			continue
		}
		session := n.Session
		if session == nil {
			session = was.Session
		}
		var who GraphChange
		if session != nil && *session != "" {
			who.Session = session
		}
		switch n.State {
		case TaskStateWorking:
			if was.State == TaskStateFailed {
				step(n, GraphEventKindTaskRetried, who)
			} else {
				step(n, GraphEventKindTaskStarted, who)
			}
		case TaskStateMerged:
			if n.Conclusion != nil && *n.Conclusion != "" {
				who.Detail = n.Conclusion
			}
			if len(n.Commits) > 0 {
				who.Commits = n.Commits
			}
			step(n, GraphEventKindTaskMerged, who)
		case TaskStateFailed:
			if n.Conclusion != nil && *n.Conclusion != "" {
				who.Detail = n.Conclusion
			}
			step(n, GraphEventKindTaskFailed, who)
		case TaskStateWaiting:
			if was.State == TaskStateFailed {
				step(n, GraphEventKindTaskRetried, who)
			} else {
				step(n, GraphEventKindTaskRequeued, who)
			}
		case TaskStateSkipped:
			step(n, GraphEventKindTaskSkipped, GraphChange{})
		}
	}
	for _, was := range before.Tasks {
		if !slices.ContainsFunc(after.Tasks, func(n Task) bool { return n.ID == was.ID }) {
			id, title := was.ID, was.Title
			out = append(out, GraphChange{Graph: after.ID, Task: &id, Kind: GraphEventKindTaskRemoved, Detail: &title})
		}
	}
	return out
}

var ActorText = map[GraphActor]string{GraphActorUser: "主人", GraphActorManager: "管家", GraphActorSystem: "农场"}

func GraphEventText(e GraphChange, titleOf func(node string) string) string {
	if titleOf == nil {
		titleOf = func(id string) string { return id }
	}
	step := "「」"
	if e.Task != nil && *e.Task != "" {
		step = "「" + titleOf(*e.Task) + "」"
	}
	by, why, detail := "", "", ""
	if e.Session != nil && *e.Session != "" {
		by = "（" + *e.Session + "）"
	}
	if e.Detail != nil && *e.Detail != "" {
		detail = *e.Detail
		why = "：" + detail
	}
	switch e.Kind {
	case GraphEventKindSplitting:
		return "要拆一张计划" + why
	case GraphEventKindDrafted:
		if detail != "" {
			return "拆好了，" + detail + "，等主人看"
		}
		return "拆好了，等主人看"
	case GraphEventKindStarted:
		if detail != "" {
			return "开工了，分支 " + detail
		}
		return "开工了"
	case GraphEventKindPaused:
		return "暂停了" + why
	case GraphEventKindResumed:
		return "接着做了"
	case GraphEventKindRipe:
		return "都做完了，等收获"
	case GraphEventKindMerged:
		return "收进了主分支"
	case GraphEventKindAbandoned:
		return "放弃了" + why
	case GraphEventKindNoted:
		return ptr.Value(e.Detail)
	case GraphEventKindTaskStarted:
		return step + "开工" + by
	case GraphEventKindTaskSentBack:
		return step + "退回去重做" + by + why
	case GraphEventKindTaskMerged:
		commits := ""
		if len(e.Commits) > 0 {
			commits = "（" + strings.Join(e.Commits, "、") + "）"
		}
		return step + "合进了计划分支" + commits + why
	case GraphEventKindTaskFailed:
		return step + "没做成" + why
	case GraphEventKindTaskRetried:
		return step + "重试"
	case GraphEventKindTaskRequeued:
		return step + "没有帮工在做了，重新排上"
	case GraphEventKindTaskSkipped:
		return step + "跳过了，后面的照做"
	case GraphEventKindTaskEdited:
		fields := make([]string, len(e.Changes))
		for i, c := range e.Changes {
			fields[i] = c.Field
		}
		return "改了" + step + "的" + strings.Join(fields, "、")
	case GraphEventKindTaskAdded:
		return "加了一步" + step
	case GraphEventKindTaskRemoved:
		name := ""
		if e.Detail != nil {
			name = *e.Detail
		} else if e.Task != nil {
			name = *e.Task
		}
		return "删了一步「" + name + "」"
	}
	return ""
}
