package protocol

// Texts are measured as JavaScript does (UTF-16 units) and trimmed as its trim does.

import (
	"fmt"
	"slices"
	"strings"

	"vibevalley/pkg/x/str"
)

// More steps than this means the job should be split into tasks.
const MaxTasks = 12

const DefaultParallel = 3

const AutoRetries = 2

func TaskOf(graph TaskGraph, id string) *Task {
	for i := range graph.Tasks {
		if graph.Tasks[i].ID == id {
			return &graph.Tasks[i]
		}
	}
	return nil
}

func IsSettled(n Task) bool { return n.State == TaskStateMerged || n.State == TaskStateSkipped }

func AsksForYou(graph TaskGraph) bool {
	return graph.State == GraphStateDraft || graph.State == GraphStateRipe ||
		(IsOpen(graph) && slices.ContainsFunc(graph.Tasks, func(n Task) bool { return n.State == TaskStateFailed }))
}

func BlockedBy(graph TaskGraph, task Task) []string {
	out := []string{}
	for _, id := range task.Needs {
		if need := TaskOf(graph, id); need == nil || !IsSettled(*need) {
			out = append(out, id)
		}
	}
	return out
}

func ReadyTasks(graph TaskGraph) []Task {
	out := []Task{}
	if graph.State != GraphStateRunning {
		return out
	}
	for _, n := range graph.Tasks {
		if n.State == TaskStateWaiting && len(BlockedBy(graph, n)) == 0 {
			out = append(out, n)
		}
	}
	return out
}

func WithTask(graph TaskGraph, id string, change func(Task) Task) TaskGraph {
	tasks := make([]Task, len(graph.Tasks))
	for i, n := range graph.Tasks {
		if n.ID == id {
			n = change(n)
		}
		tasks[i] = n
	}
	graph.Tasks = tasks
	return graph
}

func GraphSpent(graph TaskGraph) *Spent {
	var total Spent
	spent, priced := false, false
	var cny float64
	for _, n := range graph.Tasks {
		if n.Spent == nil {
			continue
		}
		spent = true
		total.Tokens += n.Spent.Tokens
		if n.Spent.CNY != nil {
			priced = true
			cny += *n.Spent.CNY
		}
	}
	if !spent {
		return nil
	}
	if priced {
		total.CNY = &cny
	}
	return &total
}

var GraphStateText = map[GraphState]string{
	GraphStateSplitting: "在拆",
	GraphStateDraft:     "等你看过再开工",
	GraphStateRunning:   "在做",
	GraphStatePaused:    "暂停了",
	GraphStateRipe:      "做完了，等收获",
	GraphStateDone:      "收完了",
	GraphStateAbandoned: "放弃了",
}

// What each task action is called; the buttons and the refusals say the same word.
var GraphActionText = map[GraphAction]string{
	GraphActionStart:   "开工",
	GraphActionPause:   "暂停",
	GraphActionResume:  "继续",
	GraphActionAbandon: "放弃",
	GraphActionMerge:   "收获",
}

// The short tag beside a task's state in the list; GraphStateText is the longer sentence.
var GraphStateTag = map[GraphState]string{
	GraphStateSplitting: "在拆",
	GraphStateDraft:     "等你看",
	GraphStateRunning:   "在做",
	GraphStatePaused:    "暂停了",
	GraphStateRipe:      "可收获",
	GraphStateDone:      "收完了",
	GraphStateAbandoned: "放弃了",
}

var TaskStateText = map[TaskState]string{
	TaskStateWaiting: "等着",
	TaskStateWorking: "在做",
	TaskStateMerged:  "合进去了",
	TaskStateFailed:  "没做成",
	TaskStateSkipped: "跳过了",
}

func IsAcceptance(n Task) bool { return n.Acceptance != nil && *n.Acceptance }

func AncestorsOf(graph TaskGraph, task Task) []Task {
	seen := map[string]bool{}
	var visit func(id string)
	visit = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		if n := TaskOf(graph, id); n != nil {
			for _, need := range n.Needs {
				visit(need)
			}
		}
	}
	for _, need := range task.Needs {
		visit(need)
	}
	out := []Task{}
	for _, n := range graph.Tasks {
		if n.ID != task.ID && seen[n.ID] {
			out = append(out, n)
		}
	}
	return out
}

func AcceptancesOf(graph TaskGraph, task Task) []Task {
	out := []Task{}
	for _, n := range AncestorsOf(graph, task) {
		if IsAcceptance(n) && n.State == TaskStateMerged {
			out = append(out, n)
		}
	}
	return out
}

func IsLast(graph TaskGraph, task Task) bool {
	return !slices.ContainsFunc(graph.Tasks, func(n Task) bool { return slices.Contains(n.Needs, task.ID) })
}

func AcceptanceChecks(graph TaskGraph, task Task) []string {
	out := []string{}
	if !IsLast(graph, task) {
		return out
	}
	for _, n := range AcceptancesOf(graph, task) {
		if n.Check != nil && *n.Check != "" && !slices.Contains(out, *n.Check) && (task.Check == nil || *n.Check != *task.Check) {
			out = append(out, *n.Check)
		}
	}
	return out
}

func dagOf(tasks []Task) []DagNode {
	out := make([]DagNode, len(tasks))
	for i, n := range tasks {
		out[i] = DagNode{ID: n.ID, After: n.Needs}
	}
	return out
}

func GraphProblems(tasks []Task) []string {
	problems := []string{}
	if len(tasks) == 0 {
		problems = append(problems, "计划里一步都没有")
	}
	if len(tasks) > MaxTasks {
		problems = append(problems, fmt.Sprintf("最多 %d 步，这里有 %d 步：把小的步骤合并", MaxTasks, len(tasks)))
	}
	ids := map[string]bool{}
	for _, n := range tasks {
		if !DagIDValid(n.ID) {
			problems = append(problems, "「"+n.ID+"」不能当步骤 id：用简短的英文，比如 api")
		}
		if ids[n.ID] {
			problems = append(problems, "步骤 id「"+n.ID+"」重复了")
		}
		ids[n.ID] = true
		if str.Trim(n.Brief) == "" {
			problems = append(problems, "「"+n.ID+"」没有工单")
		}
		if IsAcceptance(n) && (n.Check == nil || str.Trim(*n.Check) == "") {
			problems = append(problems, "验收步骤「"+n.ID+"」没有检查命令：验收就是这条命令")
		}
	}
	for _, p := range DagProblems(dagOf(tasks)) {
		switch p.Kind {
		case DagSelf:
			problems = append(problems, "「"+p.ID+"」不能等自己")
		case DagMissing:
			problems = append(problems, "「"+p.ID+"」要等的「"+p.Other+"」不存在")
		case DagCircle:
			if len(problems) == 0 {
				problems = append(problems, "这几步互相等，成了一个圈："+strings.Join(p.Circle, "、"))
			}
		case DagDuplicate:
			// Said above, in the step's own place.
		}
	}
	return problems
}

func LayersOf(tasks []Task) [][]string { return DagLayers(dagOf(tasks)) }

func GraphText(graph TaskGraph) string {
	merged := 0
	for _, n := range graph.Tasks {
		if IsSettled(n) {
			merged++
		}
	}
	head := "「" + graph.Title + "」（" + graph.ID + "，项目 " + graph.Project
	if graph.Branch != nil && *graph.Branch != "" {
		head += "，分支 " + *graph.Branch
	}
	head += "）：" + GraphStateText[graph.State]
	if len(graph.Tasks) > 0 {
		head += fmt.Sprintf("，%d/%d 步做完", merged, len(graph.Tasks))
	}
	if graph.Note != nil && *graph.Note != "" {
		head += "。" + *graph.Note
	}
	lines := []string{head}
	for _, n := range graph.Tasks {
		detail := TaskStateText[n.State]
		if n.State == TaskStateWaiting {
			if waits := BlockedBy(graph, n); len(waits) > 0 {
				detail = "等 " + strings.Join(waits, "、")
			}
		}
		mark := ""
		if IsAcceptance(n) {
			mark = "（验收）"
		}
		line := "  - " + n.ID + " " + n.Title + mark + "：" + detail
		if n.Session != nil && *n.Session != "" {
			line += "（帮工 " + *n.Session + "）"
		}
		if n.Conclusion != nil && *n.Conclusion != "" {
			line += "；" + str.Slice(*n.Conclusion, 0, 80)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// GraphActions is what the task's state allows now; the frame carries it so the client does not repeat the switch.
func GraphActions(graph TaskGraph) []GraphAction {
	out := []GraphAction{}
	if graph.State == GraphStateDraft && len(GraphProblems(graph.Tasks)) == 0 {
		out = append(out, GraphActionStart)
	}
	if graph.State == GraphStateRunning {
		out = append(out, GraphActionPause)
	}
	if graph.State == GraphStatePaused {
		out = append(out, GraphActionResume)
	}
	if graph.State == GraphStateRipe && graph.Branch != nil {
		out = append(out, GraphActionMerge)
	}
	if IsOpen(graph) {
		out = append(out, GraphActionAbandon)
	}
	return out
}

// TaskActions is what the task and the node allow now: retry a failed step, skip a waiting or failed one.
func TaskActions(graph TaskGraph, task Task) []TaskAction {
	out := []TaskAction{}
	if graph.State != GraphStateRunning && graph.State != GraphStatePaused {
		return out
	}
	if task.State == TaskStateFailed {
		out = append(out, TaskActionRetry)
	}
	if task.State == TaskStateWaiting || task.State == TaskStateFailed {
		out = append(out, TaskActionSkip)
	}
	return out
}

// CanEditTask is the task's and the node's edit gate; nil means adding a step in a draft.
func CanEditTask(graph TaskGraph, task *Task) bool {
	return graph.State == GraphStateDraft ||
		((graph.State == GraphStateRunning || graph.State == GraphStatePaused) &&
			(task == nil || task.State == TaskStateWaiting || task.State == TaskStateFailed))
}

// CanRemoveTask is CanEditTask plus the one exception: a failed step is skipped, not deleted.
func CanRemoveTask(graph TaskGraph, task *Task) bool {
	return task != nil && CanEditTask(graph, task) && task.State != TaskStateFailed
}

// What each node action is called; the node buttons read this map from the frame.
var TaskActionText = map[TaskAction]string{
	TaskActionRetry: "重试",
	TaskActionSkip:  "跳过",
}
