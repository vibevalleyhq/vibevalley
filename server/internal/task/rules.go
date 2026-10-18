package task

// A task's own rules: reading one from a splitter's answer, editing its steps, what each step is told, and which steps start.

import (
	"encoding/json"
	"fmt"
	"regexp"
	"slices"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

// The farm's limits come on top.
func startable(graph protocol.TaskGraph) []protocol.Task {
	var working int64
	for _, n := range graph.Tasks {
		if n.State == protocol.TaskStateWorking {
			working++
		}
	}
	ready := protocol.ReadyTasks(graph)
	return ready[:min(int64(len(ready)), max(0, graph.Parallel-working))]
}

func allSettled(graph protocol.TaskGraph) bool {
	return len(graph.Tasks) > 0 && !slices.ContainsFunc(graph.Tasks, func(n protocol.Task) bool { return !protocol.IsSettled(n) })
}

func frozenOf(graph protocol.TaskGraph, task protocol.Task) []string {
	out := []string{}
	for _, n := range protocol.AcceptancesOf(graph, task) {
		for _, f := range n.Frozen {
			if !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

func frozenTouched(graph protocol.TaskGraph, task protocol.Task, changed []string) []string {
	frozen := frozenOf(graph, task)
	out := []string{}
	for _, f := range changed {
		if slices.Contains(frozen, f) {
			out = append(out, f)
		}
	}
	return out
}

type taskDraft struct {
	ID         string   `json:"id"`
	Title      *string  `json:"title,omitzero"`
	Brief      string   `json:"brief"`
	Needs      []string `json:"needs,omitzero"`
	Agent      *string  `json:"agent,omitzero"`
	Check      *string  `json:"check,omitzero"`
	Scope      []string `json:"scope,omitzero"`
	Acceptance bool     `json:"acceptance,omitzero"`
}

type splitDraft struct {
	Title *string     `json:"title,omitzero"`
	Tasks []taskDraft `json:"tasks"`
}

func freshTask(draft taskDraft) protocol.Task {
	id := str.Trim(draft.ID)
	title := id
	if draft.Title != nil && str.Trim(*draft.Title) != "" {
		title = str.Trim(*draft.Title)
	}
	needs := make([]string, len(draft.Needs))
	for i, x := range draft.Needs {
		needs[i] = str.Trim(x)
	}
	n := protocol.Task{ID: id, Title: title, Brief: str.Trim(draft.Brief), Needs: needs, State: protocol.TaskStateWaiting, Tries: 0}
	if draft.Agent != nil && str.Trim(*draft.Agent) != "" {
		agent := str.Trim(*draft.Agent)
		n.Agent = &agent
	}
	if draft.Check != nil && str.Trim(*draft.Check) != "" {
		check := str.Trim(*draft.Check)
		n.Check = &check
	}
	if len(draft.Scope) > 0 {
		n.Scope = draft.Scope
	}
	if draft.Acceptance {
		yes := true
		n.Acceptance = &yes
	}
	return n
}

type parsedSplit struct {
	OK       bool
	Title    *string
	Tasks    []protocol.Task
	Problems []string
}

var taskBlock = regexp.MustCompile("```(?:json)?[^\\n]*\\n([\\s\\S]*?)```")

// The words for a block that is not JSON or not a task are Go's, not JavaScript's.
func parseSplit(text string) parsedSplit {
	matches := taskBlock.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return parsedSplit{Problems: []string{"没找到计划：要用一个 json 代码块给出"}}
	}
	lastProblem := ""
	for i := len(matches) - 1; i >= 0; i-- {
		var raw any
		if err := json.Unmarshal([]byte(matches[i][1]), &raw); err != nil {
			lastProblem = "json 读不了：" + err.Error()
			continue
		}
		task, err := decodeSplitDraft(raw)
		if err != "" {
			lastProblem = "计划的格式不对：" + err
			continue
		}
		nodes := make([]protocol.Task, len(task.Tasks))
		for j, d := range task.Tasks {
			nodes[j] = freshTask(d)
		}
		if problems := protocol.GraphProblems(nodes); len(problems) > 0 {
			return parsedSplit{Problems: problems}
		}
		out := parsedSplit{OK: true, Tasks: nodes}
		if task.Title != nil && str.Trim(*task.Title) != "" {
			title := str.Trim(*task.Title)
			out.Title = &title
		}
		return out
	}
	return parsedSplit{Problems: []string{lastProblem}}
}

// Optional fields may be missing but never null; other keys are ignored.
func decodeSplitDraft(raw any) (splitDraft, string) {
	var task splitDraft
	obj, ok := raw.(map[string]any)
	if !ok {
		return task, "要一个对象"
	}
	if v, ok := obj["title"]; ok {
		s, ok := v.(string)
		if !ok {
			return task, `["title"] 要是字符串`
		}
		task.Title = &s
	}
	list, ok := obj["tasks"].([]any)
	if !ok {
		return task, `["tasks"] 要是数组`
	}
	task.Tasks = make([]taskDraft, 0, len(list))
	for i, item := range list {
		at := fmt.Sprintf(`["tasks"][%d]`, i)
		o, ok := item.(map[string]any)
		if !ok {
			return task, at + " 要是对象"
		}
		var d taskDraft
		str := func(key string, required bool) (*string, string) {
			v, ok := o[key]
			if !ok {
				if required {
					return nil, at + `["` + key + `"] 缺了`
				}
				return nil, ""
			}
			s, ok := v.(string)
			if !ok {
				return nil, at + `["` + key + `"] 要是字符串`
			}
			return &s, ""
		}
		strs := func(key string) ([]string, string) {
			v, ok := o[key]
			if !ok {
				return nil, ""
			}
			a, ok := v.([]any)
			if !ok {
				return nil, at + `["` + key + `"] 要是数组`
			}
			out := make([]string, len(a))
			for j, x := range a {
				s, ok := x.(string)
				if !ok {
					return nil, fmt.Sprintf(`%s["%s"][%d] 要是字符串`, at, key, j)
				}
				out[j] = s
			}
			return out, ""
		}
		id, err := str("id", true)
		if err != "" {
			return task, err
		}
		d.ID = *id
		if d.Title, err = str("title", false); err != "" {
			return task, err
		}
		brief, err := str("brief", true)
		if err != "" {
			return task, err
		}
		d.Brief = *brief
		if d.Needs, err = strs("needs"); err != "" {
			return task, err
		}
		if d.Agent, err = str("agent", false); err != "" {
			return task, err
		}
		if d.Check, err = str("check", false); err != "" {
			return task, err
		}
		if d.Scope, err = strs("scope"); err != "" {
			return task, err
		}
		if v, ok := o["acceptance"]; ok {
			b, ok := v.(bool)
			if !ok {
				return task, at + `["acceptance"] 要是布尔值`
			}
			d.Acceptance = b
		}
		task.Tasks = append(task.Tasks, d)
	}
	return task, ""
}

type editResult struct {
	OK        bool
	TaskGraph protocol.TaskGraph
	Problem   string
}

func editable(graph protocol.TaskGraph, task *protocol.Task) bool {
	return protocol.CanEditTask(graph, task)
}

func checkedTask(graph protocol.TaskGraph) editResult {
	if problems := protocol.GraphProblems(graph.Tasks); len(problems) > 0 {
		return editResult{Problem: problems[0]}
	}
	return editResult{OK: true, TaskGraph: graph}
}

// Needs and Scope count as given when not nil, as an empty JSON array decodes.
func editTask(graph protocol.TaskGraph, id string, edit protocol.TaskEdit) editResult {
	task := protocol.TaskOf(graph, id)
	if !editable(graph, task) {
		if task != nil {
			return editResult{Problem: "「" + task.Title + "」" + protocol.TaskStateText[task.State] + "，不能改了"}
		}
		return editResult{Problem: "计划" + protocol.GraphStateText[graph.State] + "，不能加步骤了"}
	}
	base := protocol.Task{ID: id, Title: id, Brief: "", Needs: []string{}, State: protocol.TaskStateWaiting, Tries: 0}
	if task != nil {
		base = *task
	}
	agent, check, scope := base.Agent, base.Check, base.Scope
	if edit.Agent != nil {
		a := str.Trim(*edit.Agent)
		agent = &a
	}
	if edit.Check != nil {
		c := str.Trim(*edit.Check)
		check = &c
	}
	if edit.Scope != nil {
		scope = edit.Scope
	}
	next := base
	next.Agent, next.Check, next.Scope = nil, nil, nil
	if edit.Title != nil {
		next.Title = str.Trim(*edit.Title)
		if next.Title == "" {
			next.Title = id
		}
	}
	if edit.Brief != nil {
		next.Brief = str.Trim(*edit.Brief)
	}
	if edit.Needs != nil {
		next.Needs = edit.Needs
	}
	if agent != nil && *agent != "" {
		next.Agent = agent
	}
	if check != nil && *check != "" {
		next.Check = check
	}
	if len(scope) > 0 {
		next.Scope = scope
	}
	if task != nil {
		return checkedTask(protocol.WithTask(graph, id, func(protocol.Task) protocol.Task { return next }))
	}
	graph.Tasks = append(slices.Clip(graph.Tasks), next)
	return checkedTask(graph)
}

func removeTask(graph protocol.TaskGraph, id string) editResult {
	task := protocol.TaskOf(graph, id)
	if task == nil {
		return editResult{Problem: "计划里没有「" + id + "」这一步"}
	}
	if !protocol.CanRemoveTask(graph, task) {
		return editResult{Problem: "「" + task.Title + "」" + protocol.TaskStateText[task.State] + "，不能删了：可以跳过它"}
	}
	nodes := []protocol.Task{}
	for _, n := range graph.Tasks {
		if n.ID == id {
			continue
		}
		n.Needs = slices.DeleteFunc(slices.Clone(n.Needs), func(x string) bool { return x == id })
		if n.Needs == nil {
			n.Needs = []string{}
		}
		nodes = append(nodes, n)
	}
	graph.Tasks = nodes
	return checkedTask(graph)
}

func taskBrief(graph protocol.TaskGraph, task protocol.Task) string {
	index := slices.IndexFunc(graph.Tasks, func(n protocol.Task) bool { return n.ID == task.ID }) + 1
	lines := []string{
		fmt.Sprintf("这是种植计划「%s」里的一步：%s（步骤 %s，第 %d/%d 步）。", graph.Title, task.Title, task.ID, index, len(graph.Tasks)),
		"整个计划要做的：" + graph.Goal,
		"",
		"你这一步的工单：",
		task.Brief,
	}
	if len(task.Scope) > 0 {
		lines = append(lines, "", "只改这些地方："+strings.Join(task.Scope, "、")+"。别的步骤可能同时在改别处。")
	}
	var before []protocol.Task
	for _, id := range task.Needs {
		if n := protocol.TaskOf(graph, id); n != nil {
			before = append(before, *n)
		}
	}
	if len(before) > 0 {
		lines = append(lines, "", "前面已经做完、合进你分支里的步骤：")
		for _, n := range before {
			commits := ""
			if len(n.Commits) > 0 {
				commits = "（" + strings.Join(n.Commits, "、") + "）"
			}
			said := "做完了"
			if n.State == protocol.TaskStateSkipped {
				said = "跳过了，没有做"
			} else if n.Conclusion != nil {
				said = *n.Conclusion
			}
			lines = append(lines, "- "+n.Title+commits+"："+said)
		}
	}
	if protocol.IsAcceptance(task) {
		check := ""
		if task.Check != nil {
			check = *task.Check
		}
		lines = append(lines, "",
			"这是一步验收：只写能复现问题、或说明要做成什么样的测试，不要去修、去实现。",
			"做完以后会在你的分支上跑 `"+check+"`，它这时要**不通过**：通过了就说明它没抓住问题。",
			"你留下的文件会冻结，后面的步骤不能改；收尾的那步要让它通过。")
	} else if task.Check != nil && *task.Check != "" {
		lines = append(lines, "", "做完以后会在你的分支上跑 `"+*task.Check+"`，要能通过。")
	}
	if frozen := frozenOf(graph, task); len(frozen) > 0 {
		lines = append(lines, "", "前面的验收留下的这些文件是冻结的，不能改："+strings.Join(frozen, "、")+"。验收不过就改代码，不改验收。")
	}
	if checks := protocol.AcceptanceChecks(graph, task); len(checks) > 0 {
		quoted := make([]string, len(checks))
		for i, c := range checks {
			quoted[i] = "`" + c + "`"
		}
		lines = append(lines, "", "你是收尾的一步：做完以后还会跑前面的验收，要能通过："+strings.Join(quoted, "、")+"。")
	}
	lines = append(lines, "", "做完提交。农场会把你的分支合回计划分支，给后面的步骤用；结论里写清楚你留下了什么（接口、文件位置），后面的步骤要接着用。")
	return strings.Join(lines, "\n")
}

func checkFailedText(check, output string) string {
	out := str.Trim(output)
	if out == "" {
		out = "（没有输出）"
	}
	return "做完以后跑 `" + check + "` 没通过，输出的结尾：\n" + out + "\n\n修好，再提交。"
}

func acceptancePassedText(check string) string {
	return "验收写好了，可 `" + check + "` 现在就通过了：它没抓住要修的问题，或要做的事。改成现在会失败的验收，再提交；别去修问题本身。"
}

func frozenTouchedText(files []string) string {
	return "你改了前面的验收留下的文件：" + strings.Join(files, "、") + "。验收是冻结的：把它们恢复成计划分支上的样子，从代码上修，再提交。"
}

func retryText(task protocol.Task) string {
	return "上一轮没做成。看一下报错，接着把这一步做完：" + task.Title + "。"
}

func changeOf(e protocol.GraphEvent) protocol.GraphChange {
	return protocol.GraphChange{Graph: e.Graph, Task: e.Task, Kind: e.Kind, Session: e.Session, Detail: e.Detail, Changes: e.Changes, Commits: e.Commits}
}
