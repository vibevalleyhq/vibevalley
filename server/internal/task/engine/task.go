package engine

import (
	"errors"
	"fmt"
	"slices"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

// An agent's own task of work: tasks it does itself or hands to a helper, each waiting for others. The edges' rules
// are protocol's (DagProblems), shared with a task's steps; what a task's states mean is this package's.

type By string

const (
	BySelf   By = "self"
	ByHelper By = "helper"
)

type State string

const (
	Waiting State = "waiting"
	Working State = "working"
	Done    State = "done"
	Failed  State = "failed"
	Skipped State = "skipped"
)

type Task struct {
	// The model's own short id: "read", "fix-auth".
	ID    string `json:"id"`
	Title string `json:"title"`
	// What to do, where, what counts as done, what to report.
	Brief string `json:"brief"`
	// Ids that must be done or skipped first.
	After  []string `json:"after"`
	By     By       `json:"by"`
	State  State    `json:"state"`
	Result string   `json:"result,omitempty"`
	Tries  int      `json:"tries,omitempty"`
}

// A graph past this is a project, not one piece of work: it belongs in issues.
const MaxTasks = 30

// Done or skipped: what lets the tasks after it start.
func settled(t Task) bool { return t.State == Done || t.State == Skipped }

func find(g []Task, id string) int {
	return slices.IndexFunc(g, func(t Task) bool { return t.ID == id })
}

// Waiting, and every task it waits for settled.
func ready(g []Task, t Task) bool {
	if t.State != Waiting {
		return false
	}
	for _, x := range t.After {
		if i := find(g, x); i < 0 || !settled(g[i]) {
			return false
		}
	}
	return true
}

func Ready(g []Task) []Task {
	var out []Task
	for _, t := range g {
		if ready(g, t) {
			out = append(out, t)
		}
	}
	return out
}

// Each task's state, in order: to tell whether a change changed anything.
func States(g []Task) []State {
	out := make([]State, len(g))
	for i, t := range g {
		out[i] = t.State
	}
	return out
}

// Every task settled: the graph is finished and can be put away.
func Finished(g []Task) bool {
	return len(g) > 0 && !slices.ContainsFunc(g, func(t Task) bool { return !settled(t) })
}

func dag(g []Task) []protocol.DagNode {
	out := make([]protocol.DagNode, len(g))
	for i, t := range g {
		out[i] = protocol.DagNode{ID: t.ID, After: t.After}
	}
	return out
}

// The edges' problems, in words a model fixes them by.
func edgeProblems(g []Task) []string {
	var out []string
	for _, p := range protocol.DagProblems(dag(g)) {
		switch p.Kind {
		case protocol.DagDuplicate:
			out = append(out, "id「"+p.ID+"」重复了")
		case protocol.DagSelf:
			out = append(out, "「"+p.ID+"」不能等自己")
		case protocol.DagMissing:
			out = append(out, "「"+p.ID+"」要等的「"+p.Other+"」不存在")
		case protocol.DagCircle:
			out = append(out, "这几件互相等，成了一个圈："+strings.Join(p.Circle, "、"))
		}
	}
	return out
}

// Adds tasks to the graph, all or none: a batch with any problem changes nothing, and the problems say why.
func Add(g []Task, more []Task) ([]Task, []string) {
	var problems []string
	if len(more) == 0 {
		problems = append(problems, "一件任务都没有")
	}
	next := slices.Clone(g)
	for _, t := range more {
		t.ID = str.Trim(t.ID)
		t.Brief = str.Trim(t.Brief)
		t.Title = str.Trim(t.Title)
		if !protocol.DagIDValid(t.ID) {
			problems = append(problems, "「"+t.ID+"」不能当 id：用简短的英文，比如 read、fix-auth")
		}
		if t.Brief == "" {
			problems = append(problems, "「"+t.ID+"」没有写要做什么（brief）")
		}
		if t.Title == "" {
			t.Title = str.Head(t.Brief, 20)
		}
		if t.By == "" {
			t.By = BySelf
		}
		if t.After == nil {
			t.After = []string{}
		}
		t.State, t.Result, t.Tries = Waiting, "", 0
		next = append(next, t)
	}
	if len(next) > MaxTasks {
		problems = append(problems, fmt.Sprintf("最多 %d 件，这里有 %d 件：把小的合并，或者先做完一部分", MaxTasks, len(next)))
	}
	if len(problems) == 0 {
		problems = edgeProblems(next)
	}
	if len(problems) > 0 {
		return g, problems
	}
	return next, nil
}

// What a model may change on one task; nil leaves it.
type Change struct {
	State  *State
	Result *string
	Brief  *string
	After  *[]string
}

func Update(g []Task, id string, c Change) ([]Task, error) {
	i := find(g, id)
	if i < 0 {
		return g, errors.New("没有「" + id + "」这件任务")
	}
	next := slices.Clone(g)
	t := next[i]
	open := t.State == Waiting || t.State == Failed
	if (c.Brief != nil || c.After != nil) && !open {
		return g, errors.New("「" + id + "」已经" + stateWords[t.State] + "，不能再改要做什么或等谁")
	}
	if c.Brief != nil {
		if str.Trim(*c.Brief) == "" {
			return g, errors.New("brief 是空的")
		}
		t.Brief = str.Trim(*c.Brief)
	}
	if c.After != nil {
		t.After = slices.Clone(*c.After)
	}
	if c.Result != nil {
		t.Result = str.Trim(*c.Result)
	}
	if c.State != nil {
		switch to := *c.State; {
		case to == t.State:
		case to == Waiting && (t.State == Failed || t.State == Skipped):
			t.Tries++
			t.State = Waiting
		case (to == Done || to == Failed || to == Skipped) && (t.State == Waiting || t.State == Working):
			t.State = to
		default:
			return g, errors.New("「" + id + "」" + stateWords[t.State] + "，不能改成" + stateWords[to])
		}
	}
	next[i] = t
	if c.After != nil {
		if problems := edgeProblems(next); len(problems) > 0 {
			return g, errors.New(strings.Join(problems, "；"))
		}
	}
	return next, nil
}

var stateWords = map[State]string{Waiting: "还没做", Working: "在做", Done: "做完了", Failed: "没做成", Skipped: "跳过了"}

// The whole graph as the model reads it: what each task is at, who does it, what it waits for, what it came to.
func Text(g []Task) string {
	if len(g) == 0 {
		return "现在没有任务。"
	}
	can := len(Ready(g))
	lines := []string{fmt.Sprintf("任务（%d 件，%d 件可以做）：", len(g), can)}
	for _, t := range g {
		mark := stateWords[t.State]
		if t.State == Waiting {
			mark = "等着"
			if ready(g, t) {
				mark = "可以做"
			}
		}
		line := "- [" + mark + "] " + t.ID + " " + t.Title
		if t.By == ByHelper {
			line += "（帮手做）"
		}
		if len(t.After) > 0 && !settled(t) {
			line += "（等 " + strings.Join(t.After, "、") + "）"
		}
		if t.Result != "" {
			line += " → " + str.Head(strings.Join(strings.Fields(t.Result), " "), 80)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

// A helper takes it: waiting to working.
func Begin(g []Task, id string) []Task {
	next := slices.Clone(g)
	if i := find(next, id); i >= 0 && next[i].State == Waiting {
		next[i].State = Working
	}
	return next
}

// Retries a helper's task gets after its first failure.
const Retries = 1

// A helper came back: done with what it said, or failed with why. A failure within Retries goes back to waiting.
func Settle(g []Task, id, result string, failed bool) []Task {
	next := slices.Clone(g)
	i := find(next, id)
	if i < 0 || next[i].State != Working {
		return next
	}
	next[i].Result = str.Trim(result)
	switch {
	case !failed:
		next[i].State = Done
	case next[i].Tries < Retries:
		next[i].Tries++
		next[i].State = Waiting
	default:
		next[i].State = Failed
	}
	return next
}

// Helpers that stopped before coming back (the agent was stopped, or the process went): their tasks wait again.
func Requeue(g []Task, ids []string) []Task {
	next := slices.Clone(g)
	for i := range next {
		if next[i].State == Working && (ids == nil || slices.Contains(ids, next[i].ID)) {
			next[i].State = Waiting
		}
	}
	return next
}
