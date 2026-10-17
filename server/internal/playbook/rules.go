package playbook

// A plan's own rules: reading one from a planner's answer, editing its steps, what each step is told, and which steps start.

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
func startable(pb protocol.Playbook) []protocol.PlaybookNode {
	var working int64
	for _, n := range pb.Nodes {
		if n.State == protocol.NodeStateWorking {
			working++
		}
	}
	ready := protocol.ReadyNodes(pb)
	return ready[:min(int64(len(ready)), max(0, pb.Parallel-working))]
}

func allSettled(pb protocol.Playbook) bool {
	return len(pb.Nodes) > 0 && !slices.ContainsFunc(pb.Nodes, func(n protocol.PlaybookNode) bool { return !protocol.IsSettled(n) })
}

func frozenOf(pb protocol.Playbook, node protocol.PlaybookNode) []string {
	out := []string{}
	for _, n := range protocol.AcceptancesOf(pb, node) {
		for _, f := range n.Frozen {
			if !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

func frozenTouched(pb protocol.Playbook, node protocol.PlaybookNode, changed []string) []string {
	frozen := frozenOf(pb, node)
	out := []string{}
	for _, f := range changed {
		if slices.Contains(frozen, f) {
			out = append(out, f)
		}
	}
	return out
}

type nodeDraft struct {
	ID         string   `json:"id"`
	Title      *string  `json:"title,omitzero"`
	Task       string   `json:"task"`
	Needs      []string `json:"needs,omitzero"`
	Agent      *string  `json:"agent,omitzero"`
	Check      *string  `json:"check,omitzero"`
	Scope      []string `json:"scope,omitzero"`
	Acceptance bool     `json:"acceptance,omitzero"`
}

type planDraft struct {
	Title *string     `json:"title,omitzero"`
	Nodes []nodeDraft `json:"nodes"`
}

func freshNode(draft nodeDraft) protocol.PlaybookNode {
	id := str.Trim(draft.ID)
	title := id
	if draft.Title != nil && str.Trim(*draft.Title) != "" {
		title = str.Trim(*draft.Title)
	}
	needs := make([]string, len(draft.Needs))
	for i, x := range draft.Needs {
		needs[i] = str.Trim(x)
	}
	n := protocol.PlaybookNode{ID: id, Title: title, Task: str.Trim(draft.Task), Needs: needs, State: protocol.NodeStateWaiting, Tries: 0}
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

type parsedPlan struct {
	OK       bool
	Title    *string
	Nodes    []protocol.PlaybookNode
	Problems []string
}

var planBlock = regexp.MustCompile("```(?:json)?[^\\n]*\\n([\\s\\S]*?)```")

// The words for a block that is not JSON or not a plan are Go's, not JavaScript's.
func parsePlan(text string) parsedPlan {
	matches := planBlock.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return parsedPlan{Problems: []string{"没找到计划：要用一个 json 代码块给出"}}
	}
	lastProblem := ""
	for i := len(matches) - 1; i >= 0; i-- {
		var raw any
		if err := json.Unmarshal([]byte(matches[i][1]), &raw); err != nil {
			lastProblem = "json 读不了：" + err.Error()
			continue
		}
		plan, err := decodePlanDraft(raw)
		if err != "" {
			lastProblem = "计划的格式不对：" + err
			continue
		}
		nodes := make([]protocol.PlaybookNode, len(plan.Nodes))
		for j, d := range plan.Nodes {
			nodes[j] = freshNode(d)
		}
		if problems := protocol.PlanProblems(nodes); len(problems) > 0 {
			return parsedPlan{Problems: problems}
		}
		out := parsedPlan{OK: true, Nodes: nodes}
		if plan.Title != nil && str.Trim(*plan.Title) != "" {
			title := str.Trim(*plan.Title)
			out.Title = &title
		}
		return out
	}
	return parsedPlan{Problems: []string{lastProblem}}
}

// Optional fields may be missing but never null; other keys are ignored.
func decodePlanDraft(raw any) (planDraft, string) {
	var plan planDraft
	obj, ok := raw.(map[string]any)
	if !ok {
		return plan, "要一个对象"
	}
	if v, ok := obj["title"]; ok {
		s, ok := v.(string)
		if !ok {
			return plan, `["title"] 要是字符串`
		}
		plan.Title = &s
	}
	list, ok := obj["nodes"].([]any)
	if !ok {
		return plan, `["nodes"] 要是数组`
	}
	plan.Nodes = make([]nodeDraft, 0, len(list))
	for i, item := range list {
		at := fmt.Sprintf(`["nodes"][%d]`, i)
		o, ok := item.(map[string]any)
		if !ok {
			return plan, at + " 要是对象"
		}
		var d nodeDraft
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
			return plan, err
		}
		d.ID = *id
		if d.Title, err = str("title", false); err != "" {
			return plan, err
		}
		task, err := str("task", true)
		if err != "" {
			return plan, err
		}
		d.Task = *task
		if d.Needs, err = strs("needs"); err != "" {
			return plan, err
		}
		if d.Agent, err = str("agent", false); err != "" {
			return plan, err
		}
		if d.Check, err = str("check", false); err != "" {
			return plan, err
		}
		if d.Scope, err = strs("scope"); err != "" {
			return plan, err
		}
		if v, ok := o["acceptance"]; ok {
			b, ok := v.(bool)
			if !ok {
				return plan, at + `["acceptance"] 要是布尔值`
			}
			d.Acceptance = b
		}
		plan.Nodes = append(plan.Nodes, d)
	}
	return plan, ""
}

type editResult struct {
	OK       bool
	Playbook protocol.Playbook
	Problem  string
}

func editable(pb protocol.Playbook, node *protocol.PlaybookNode) bool {
	return protocol.CanEditNode(pb, node)
}

func checkedPlaybook(pb protocol.Playbook) editResult {
	if problems := protocol.PlanProblems(pb.Nodes); len(problems) > 0 {
		return editResult{Problem: problems[0]}
	}
	return editResult{OK: true, Playbook: pb}
}

// Needs and Scope count as given when not nil, as an empty JSON array decodes.
func editNode(pb protocol.Playbook, id string, edit protocol.NodeEdit) editResult {
	node := protocol.NodeOf(pb, id)
	if !editable(pb, node) {
		if node != nil {
			return editResult{Problem: "「" + node.Title + "」" + protocol.NodeStateText[node.State] + "，不能改了"}
		}
		return editResult{Problem: "计划" + protocol.PlaybookStateText[pb.State] + "，不能加步骤了"}
	}
	base := protocol.PlaybookNode{ID: id, Title: id, Task: "", Needs: []string{}, State: protocol.NodeStateWaiting, Tries: 0}
	if node != nil {
		base = *node
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
	if edit.Task != nil {
		next.Task = str.Trim(*edit.Task)
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
	if node != nil {
		return checkedPlaybook(protocol.WithNode(pb, id, func(protocol.PlaybookNode) protocol.PlaybookNode { return next }))
	}
	pb.Nodes = append(slices.Clip(pb.Nodes), next)
	return checkedPlaybook(pb)
}

func removeNode(pb protocol.Playbook, id string) editResult {
	node := protocol.NodeOf(pb, id)
	if node == nil {
		return editResult{Problem: "计划里没有「" + id + "」这一步"}
	}
	if !protocol.CanRemoveNode(pb, node) {
		return editResult{Problem: "「" + node.Title + "」" + protocol.NodeStateText[node.State] + "，不能删了：可以跳过它"}
	}
	nodes := []protocol.PlaybookNode{}
	for _, n := range pb.Nodes {
		if n.ID == id {
			continue
		}
		n.Needs = slices.DeleteFunc(slices.Clone(n.Needs), func(x string) bool { return x == id })
		if n.Needs == nil {
			n.Needs = []string{}
		}
		nodes = append(nodes, n)
	}
	pb.Nodes = nodes
	return checkedPlaybook(pb)
}

func nodeTask(pb protocol.Playbook, node protocol.PlaybookNode) string {
	index := slices.IndexFunc(pb.Nodes, func(n protocol.PlaybookNode) bool { return n.ID == node.ID }) + 1
	lines := []string{
		fmt.Sprintf("这是种植计划「%s」里的一步：%s（步骤 %s，第 %d/%d 步）。", pb.Title, node.Title, node.ID, index, len(pb.Nodes)),
		"整个计划要做的：" + pb.Goal,
		"",
		"你这一步的工单：",
		node.Task,
	}
	if len(node.Scope) > 0 {
		lines = append(lines, "", "只改这些地方："+strings.Join(node.Scope, "、")+"。别的步骤可能同时在改别处。")
	}
	var before []protocol.PlaybookNode
	for _, id := range node.Needs {
		if n := protocol.NodeOf(pb, id); n != nil {
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
			if n.State == protocol.NodeStateSkipped {
				said = "跳过了，没有做"
			} else if n.Conclusion != nil {
				said = *n.Conclusion
			}
			lines = append(lines, "- "+n.Title+commits+"："+said)
		}
	}
	if protocol.IsAcceptance(node) {
		check := ""
		if node.Check != nil {
			check = *node.Check
		}
		lines = append(lines, "",
			"这是一步验收：只写能复现问题、或说明要做成什么样的测试，不要去修、去实现。",
			"做完以后会在你的分支上跑 `"+check+"`，它这时要**不通过**：通过了就说明它没抓住问题。",
			"你留下的文件会冻结，后面的步骤不能改；收尾的那步要让它通过。")
	} else if node.Check != nil && *node.Check != "" {
		lines = append(lines, "", "做完以后会在你的分支上跑 `"+*node.Check+"`，要能通过。")
	}
	if frozen := frozenOf(pb, node); len(frozen) > 0 {
		lines = append(lines, "", "前面的验收留下的这些文件是冻结的，不能改："+strings.Join(frozen, "、")+"。验收不过就改代码，不改验收。")
	}
	if checks := protocol.AcceptanceChecks(pb, node); len(checks) > 0 {
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

func retryText(node protocol.PlaybookNode) string {
	return "上一轮没做成。看一下报错，接着把这一步做完：" + node.Title + "。"
}

func changeOf(e protocol.PlaybookEvent) protocol.PlaybookChange {
	return protocol.PlaybookChange{Playbook: e.Playbook, Node: e.Node, Kind: e.Kind, Session: e.Session, Detail: e.Detail, Changes: e.Changes, Commits: e.Commits}
}
