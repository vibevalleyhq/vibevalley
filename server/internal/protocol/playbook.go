package protocol

// Texts are measured as JavaScript does (UTF-16 units) and trimmed as its trim does.

import (
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"unicode/utf16"
)

// More steps than this means the job should be split into playbooks.
const MaxNodes = 12

const DefaultParallel = 3

const AutoRetries = 2

func NodeOf(pb Playbook, id string) *PlaybookNode {
	for i := range pb.Nodes {
		if pb.Nodes[i].ID == id {
			return &pb.Nodes[i]
		}
	}
	return nil
}

// An id's number is read as JavaScript's Number reads it.
func NextPlaybookID(ids []string) string {
	top := 0.0
	for _, id := range ids {
		units := utf16.Encode([]rune(id))
		if n := playbookNumber(string(utf16.Decode(units[min(1, len(units)):]))); n > top {
			top = n
		}
	}
	return "p" + playbookNumberText(top+1)
}

func IsSettled(n PlaybookNode) bool { return n.State == NodeStateMerged || n.State == NodeStateSkipped }

func AsksForYou(pb Playbook) bool {
	return pb.State == PlaybookStateDraft || pb.State == PlaybookStateRipe ||
		(IsOpen(pb) && slices.ContainsFunc(pb.Nodes, func(n PlaybookNode) bool { return n.State == NodeStateFailed }))
}

func BlockedBy(pb Playbook, node PlaybookNode) []string {
	out := []string{}
	for _, id := range node.Needs {
		if need := NodeOf(pb, id); need == nil || !IsSettled(*need) {
			out = append(out, id)
		}
	}
	return out
}

func ReadyNodes(pb Playbook) []PlaybookNode {
	out := []PlaybookNode{}
	if pb.State != PlaybookStateRunning {
		return out
	}
	for _, n := range pb.Nodes {
		if n.State == NodeStateWaiting && len(BlockedBy(pb, n)) == 0 {
			out = append(out, n)
		}
	}
	return out
}

// The farm's limits come on top.
func Startable(pb Playbook) []PlaybookNode {
	var working int64
	for _, n := range pb.Nodes {
		if n.State == NodeStateWorking {
			working++
		}
	}
	ready := ReadyNodes(pb)
	return ready[:min(int64(len(ready)), max(0, pb.Parallel-working))]
}

func AllSettled(pb Playbook) bool {
	return len(pb.Nodes) > 0 && !slices.ContainsFunc(pb.Nodes, func(n PlaybookNode) bool { return !IsSettled(n) })
}

func WithNode(pb Playbook, id string, change func(PlaybookNode) PlaybookNode) Playbook {
	nodes := make([]PlaybookNode, len(pb.Nodes))
	for i, n := range pb.Nodes {
		if n.ID == id {
			n = change(n)
		}
		nodes[i] = n
	}
	pb.Nodes = nodes
	return pb
}

func PlaybookSpent(pb Playbook) *Spent {
	var total Spent
	spent, priced := false, false
	var cny float64
	for _, n := range pb.Nodes {
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

var PlaybookStateText = map[PlaybookState]string{
	PlaybookStatePlanning:  "在拆",
	PlaybookStateDraft:     "等你看过再开工",
	PlaybookStateRunning:   "在做",
	PlaybookStatePaused:    "暂停了",
	PlaybookStateRipe:      "做完了，等收获",
	PlaybookStateDone:      "收完了",
	PlaybookStateAbandoned: "放弃了",
}

var NodeStateText = map[NodeState]string{
	NodeStateWaiting: "等着",
	NodeStateWorking: "在做",
	NodeStateMerged:  "合进去了",
	NodeStateFailed:  "没做成",
	NodeStateSkipped: "跳过了",
}

func IsAcceptance(n PlaybookNode) bool { return n.Acceptance != nil && *n.Acceptance }

func AncestorsOf(pb Playbook, node PlaybookNode) []PlaybookNode {
	seen := map[string]bool{}
	var visit func(id string)
	visit = func(id string) {
		if seen[id] {
			return
		}
		seen[id] = true
		if n := NodeOf(pb, id); n != nil {
			for _, need := range n.Needs {
				visit(need)
			}
		}
	}
	for _, need := range node.Needs {
		visit(need)
	}
	out := []PlaybookNode{}
	for _, n := range pb.Nodes {
		if n.ID != node.ID && seen[n.ID] {
			out = append(out, n)
		}
	}
	return out
}

func AcceptancesOf(pb Playbook, node PlaybookNode) []PlaybookNode {
	out := []PlaybookNode{}
	for _, n := range AncestorsOf(pb, node) {
		if IsAcceptance(n) && n.State == NodeStateMerged {
			out = append(out, n)
		}
	}
	return out
}

func IsLast(pb Playbook, node PlaybookNode) bool {
	return !slices.ContainsFunc(pb.Nodes, func(n PlaybookNode) bool { return slices.Contains(n.Needs, node.ID) })
}

func AcceptanceChecks(pb Playbook, node PlaybookNode) []string {
	out := []string{}
	if !IsLast(pb, node) {
		return out
	}
	for _, n := range AcceptancesOf(pb, node) {
		if n.Check != nil && *n.Check != "" && !slices.Contains(out, *n.Check) && (node.Check == nil || *n.Check != *node.Check) {
			out = append(out, *n.Check)
		}
	}
	return out
}

func frozenOf(pb Playbook, node PlaybookNode) []string {
	out := []string{}
	for _, n := range AcceptancesOf(pb, node) {
		for _, f := range n.Frozen {
			if !slices.Contains(out, f) {
				out = append(out, f)
			}
		}
	}
	return out
}

func FrozenTouched(pb Playbook, node PlaybookNode, changed []string) []string {
	frozen := frozenOf(pb, node)
	out := []string{}
	for _, f := range changed {
		if slices.Contains(frozen, f) {
			out = append(out, f)
		}
	}
	return out
}

type NodeDraft struct {
	ID         string   `json:"id"`
	Title      *string  `json:"title,omitzero"`
	Task       string   `json:"task"`
	Needs      []string `json:"needs,omitzero"`
	Agent      *string  `json:"agent,omitzero"`
	Check      *string  `json:"check,omitzero"`
	Scope      []string `json:"scope,omitzero"`
	Acceptance bool     `json:"acceptance,omitzero"`
}

type PlanDraft struct {
	Title *string     `json:"title,omitzero"`
	Nodes []NodeDraft `json:"nodes"`
}

// Step ids are ASCII only: no case folding, so 'ſ' or the Kelvin sign is no 's' or 'k' here, as in JavaScript.
var stepID = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$`)

func PlanProblems(nodes []PlaybookNode) []string {
	problems := []string{}
	if len(nodes) == 0 {
		problems = append(problems, "计划里一步都没有")
	}
	if len(nodes) > MaxNodes {
		problems = append(problems, fmt.Sprintf("最多 %d 步，这里有 %d 步：把小的步骤合并", MaxNodes, len(nodes)))
	}
	ids := map[string]bool{}
	for _, n := range nodes {
		if !stepID.MatchString(n.ID) {
			problems = append(problems, "「"+n.ID+"」不能当步骤 id：用简短的英文，比如 api")
		}
		if ids[n.ID] {
			problems = append(problems, "步骤 id「"+n.ID+"」重复了")
		}
		ids[n.ID] = true
		if coreTrim(n.Task) == "" {
			problems = append(problems, "「"+n.ID+"」没有工单")
		}
		if IsAcceptance(n) && (n.Check == nil || coreTrim(*n.Check) == "") {
			problems = append(problems, "验收步骤「"+n.ID+"」没有检查命令：验收就是这条命令")
		}
	}
	for _, n := range nodes {
		for _, need := range n.Needs {
			if need == n.ID {
				problems = append(problems, "「"+n.ID+"」不能等自己")
			} else if !ids[need] {
				problems = append(problems, "「"+n.ID+"」要等的「"+need+"」不存在")
			}
		}
	}
	if len(problems) == 0 {
		laid := map[string]bool{}
		for _, layer := range LayersOf(nodes) {
			for _, id := range layer {
				laid[id] = true
			}
		}
		var circle []string
		for _, n := range nodes {
			if !laid[n.ID] {
				circle = append(circle, n.ID)
			}
		}
		if len(circle) > 0 {
			problems = append(problems, "这几步互相等，成了一个圈："+strings.Join(circle, "、"))
		}
	}
	return problems
}

// A step caught in a circle is in no layer.
func LayersOf(nodes []PlaybookNode) [][]string {
	known := map[string]bool{}
	for _, n := range nodes {
		known[n.ID] = true
	}
	depth := map[string]int{}
	// Longest path from a step with no needs; at most one pass per step.
	changed := true
	for pass := 0; changed && pass <= len(nodes); pass++ {
		changed = false
		for _, n := range nodes {
			if _, ok := depth[n.ID]; ok {
				continue
			}
			d, ready := 0, true
			for _, x := range n.Needs {
				if !known[x] || x == n.ID {
					continue
				}
				nd, ok := depth[x]
				if !ok {
					ready = false
					break
				}
				d = max(d, nd+1)
			}
			if !ready {
				continue
			}
			depth[n.ID] = d
			changed = true
		}
	}
	var layers [][]string
	for _, n := range nodes {
		d, ok := depth[n.ID]
		if !ok {
			continue
		}
		for len(layers) <= d {
			layers = append(layers, nil)
		}
		layers[d] = append(layers[d], n.ID)
	}
	out := [][]string{}
	for _, l := range layers {
		if l != nil {
			out = append(out, l)
		}
	}
	return out
}

func freshNode(draft NodeDraft) PlaybookNode {
	id := coreTrim(draft.ID)
	title := id
	if draft.Title != nil && coreTrim(*draft.Title) != "" {
		title = coreTrim(*draft.Title)
	}
	needs := make([]string, len(draft.Needs))
	for i, x := range draft.Needs {
		needs[i] = coreTrim(x)
	}
	n := PlaybookNode{ID: id, Title: title, Task: coreTrim(draft.Task), Needs: needs, State: NodeStateWaiting, Tries: 0}
	if draft.Agent != nil && coreTrim(*draft.Agent) != "" {
		agent := coreTrim(*draft.Agent)
		n.Agent = &agent
	}
	if draft.Check != nil && coreTrim(*draft.Check) != "" {
		check := coreTrim(*draft.Check)
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

type ParsedPlan struct {
	OK       bool
	Title    *string
	Nodes    []PlaybookNode
	Problems []string
}

var planBlock = regexp.MustCompile("```(?:json)?[^\\n]*\\n([\\s\\S]*?)```")

// The words for a block that is not JSON or not a plan are Go's, not JavaScript's.
func ParsePlan(text string) ParsedPlan {
	matches := planBlock.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return ParsedPlan{Problems: []string{"没找到计划：要用一个 json 代码块给出"}}
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
		nodes := make([]PlaybookNode, len(plan.Nodes))
		for j, d := range plan.Nodes {
			nodes[j] = freshNode(d)
		}
		if problems := PlanProblems(nodes); len(problems) > 0 {
			return ParsedPlan{Problems: problems}
		}
		out := ParsedPlan{OK: true, Nodes: nodes}
		if plan.Title != nil && coreTrim(*plan.Title) != "" {
			title := coreTrim(*plan.Title)
			out.Title = &title
		}
		return out
	}
	return ParsedPlan{Problems: []string{lastProblem}}
}

// Optional fields may be missing but never null; other keys are ignored.
func decodePlanDraft(raw any) (PlanDraft, string) {
	var plan PlanDraft
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
	plan.Nodes = make([]NodeDraft, 0, len(list))
	for i, item := range list {
		at := fmt.Sprintf(`["nodes"][%d]`, i)
		o, ok := item.(map[string]any)
		if !ok {
			return plan, at + " 要是对象"
		}
		var d NodeDraft
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

type Edited struct {
	OK       bool
	Playbook Playbook
	Problem  string
}

func editable(pb Playbook, node *PlaybookNode) bool {
	return pb.State == PlaybookStateDraft ||
		((pb.State == PlaybookStateRunning || pb.State == PlaybookStatePaused) &&
			(node == nil || node.State == NodeStateWaiting || node.State == NodeStateFailed))
}

func checkedPlaybook(pb Playbook) Edited {
	if problems := PlanProblems(pb.Nodes); len(problems) > 0 {
		return Edited{Problem: problems[0]}
	}
	return Edited{OK: true, Playbook: pb}
}

// Needs and Scope count as given when not nil, as an empty JSON array decodes.
func EditNode(pb Playbook, id string, edit NodeEdit) Edited {
	node := NodeOf(pb, id)
	if !editable(pb, node) {
		if node != nil {
			return Edited{Problem: "「" + node.Title + "」" + NodeStateText[node.State] + "，不能改了"}
		}
		return Edited{Problem: "计划" + PlaybookStateText[pb.State] + "，不能加步骤了"}
	}
	base := PlaybookNode{ID: id, Title: id, Task: "", Needs: []string{}, State: NodeStateWaiting, Tries: 0}
	if node != nil {
		base = *node
	}
	agent, check, scope := base.Agent, base.Check, base.Scope
	if edit.Agent != nil {
		a := coreTrim(*edit.Agent)
		agent = &a
	}
	if edit.Check != nil {
		c := coreTrim(*edit.Check)
		check = &c
	}
	if edit.Scope != nil {
		scope = edit.Scope
	}
	next := base
	next.Agent, next.Check, next.Scope = nil, nil, nil
	if edit.Title != nil {
		next.Title = coreTrim(*edit.Title)
		if next.Title == "" {
			next.Title = id
		}
	}
	if edit.Task != nil {
		next.Task = coreTrim(*edit.Task)
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
		return checkedPlaybook(WithNode(pb, id, func(PlaybookNode) PlaybookNode { return next }))
	}
	pb.Nodes = append(slices.Clip(pb.Nodes), next)
	return checkedPlaybook(pb)
}

func RemoveNode(pb Playbook, id string) Edited {
	node := NodeOf(pb, id)
	if node == nil {
		return Edited{Problem: "计划里没有「" + id + "」这一步"}
	}
	if !editable(pb, node) || node.State == NodeStateFailed {
		return Edited{Problem: "「" + node.Title + "」" + NodeStateText[node.State] + "，不能删了：可以跳过它"}
	}
	nodes := []PlaybookNode{}
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

func NodeTask(pb Playbook, node PlaybookNode) string {
	index := slices.IndexFunc(pb.Nodes, func(n PlaybookNode) bool { return n.ID == node.ID }) + 1
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
	var before []PlaybookNode
	for _, id := range node.Needs {
		if n := NodeOf(pb, id); n != nil {
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
			if n.State == NodeStateSkipped {
				said = "跳过了，没有做"
			} else if n.Conclusion != nil {
				said = *n.Conclusion
			}
			lines = append(lines, "- "+n.Title+commits+"："+said)
		}
	}
	if IsAcceptance(node) {
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
	if checks := AcceptanceChecks(pb, node); len(checks) > 0 {
		quoted := make([]string, len(checks))
		for i, c := range checks {
			quoted[i] = "`" + c + "`"
		}
		lines = append(lines, "", "你是收尾的一步：做完以后还会跑前面的验收，要能通过："+strings.Join(quoted, "、")+"。")
	}
	lines = append(lines, "", "做完提交。农场会把你的分支合回计划分支，给后面的步骤用；结论里写清楚你留下了什么（接口、文件位置），后面的步骤要接着用。")
	return strings.Join(lines, "\n")
}

func CheckFailedText(check, output string) string {
	out := coreTrim(output)
	if out == "" {
		out = "（没有输出）"
	}
	return "做完以后跑 `" + check + "` 没通过，输出的结尾：\n" + out + "\n\n修好，再提交。"
}

func AcceptancePassedText(check string) string {
	return "验收写好了，可 `" + check + "` 现在就通过了：它没抓住要修的问题，或要做的事。改成现在会失败的验收，再提交；别去修问题本身。"
}

func FrozenTouchedText(files []string) string {
	return "你改了前面的验收留下的文件：" + strings.Join(files, "、") + "。验收是冻结的：把它们恢复成计划分支上的样子，从代码上修，再提交。"
}

func RetryText(node PlaybookNode) string {
	return "上一轮没做成。看一下报错，接着把这一步做完：" + node.Title + "。"
}

func PlaybookText(pb Playbook) string {
	merged := 0
	for _, n := range pb.Nodes {
		if IsSettled(n) {
			merged++
		}
	}
	head := "「" + pb.Title + "」（" + pb.ID + "，项目 " + pb.Project
	if pb.Branch != nil && *pb.Branch != "" {
		head += "，分支 " + *pb.Branch
	}
	head += "）：" + PlaybookStateText[pb.State]
	if len(pb.Nodes) > 0 {
		head += fmt.Sprintf("，%d/%d 步做完", merged, len(pb.Nodes))
	}
	if pb.Note != nil && *pb.Note != "" {
		head += "。" + *pb.Note
	}
	lines := []string{head}
	for _, n := range pb.Nodes {
		detail := NodeStateText[n.State]
		if n.State == NodeStateWaiting {
			if waits := BlockedBy(pb, n); len(waits) > 0 {
				detail = "等 " + strings.Join(waits, "、")
			}
		}
		mark := ""
		if IsAcceptance(n) {
			mark = "（验收）"
		}
		line := "  - " + n.ID + " " + n.Title + mark + "：" + detail
		if n.Helper != nil && *n.Helper != "" {
			line += "（帮工 " + *n.Helper + "）"
		}
		if n.Conclusion != nil && *n.Conclusion != "" {
			line += "；" + playbookSlice(*n.Conclusion, 80)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

type PlaybookChange struct {
	Playbook string            `json:"playbook"`
	Node     *string           `json:"node,omitzero"`
	Kind     PlaybookEventKind `json:"kind"`
	Helper   *string           `json:"helper,omitzero"`
	Detail   *string           `json:"detail,omitzero"`
	Changes  []NodeFieldChange `json:"changes,omitzero"`
	Commits  []string          `json:"commits,omitzero"`
}

func ChangeOf(e PlaybookEvent) PlaybookChange {
	return PlaybookChange{Playbook: e.Playbook, Node: e.Node, Kind: e.Kind, Helper: e.Helper, Detail: e.Detail, Changes: e.Changes, Commits: e.Commits}
}

var nodeFields = []struct {
	field string
	text  func(PlaybookNode) string
}{
	{"标题", func(n PlaybookNode) string { return n.Title }},
	{"工单", func(n PlaybookNode) string { return n.Task }},
	{"要等的", func(n PlaybookNode) string { return strings.Join(n.Needs, "、") }},
	{"谁来做", func(n PlaybookNode) string { return playbookOr(n.Agent) }},
	{"检查", func(n PlaybookNode) string { return playbookOr(n.Check) }},
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
			plan(PlaybookEventKindHarvested, nil)
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
				if n.Helper != nil && *n.Helper != "" {
					who.Helper = n.Helper
				}
				step(n, PlaybookEventKindNodeSentBack, who)
			}
			continue
		}
		helper := n.Helper
		if helper == nil {
			helper = was.Helper
		}
		var who PlaybookChange
		if helper != nil && *helper != "" {
			who.Helper = helper
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

var ActorText = map[PlaybookActor]string{PlaybookActorUser: "主人", PlaybookActorForeman: "管家", PlaybookActorFarm: "农场"}

func PlaybookEventText(e PlaybookChange, titleOf func(node string) string) string {
	if titleOf == nil {
		titleOf = func(id string) string { return id }
	}
	step := "「」"
	if e.Node != nil && *e.Node != "" {
		step = "「" + titleOf(*e.Node) + "」"
	}
	by, why, detail := "", "", ""
	if e.Helper != nil && *e.Helper != "" {
		by = "（" + *e.Helper + "）"
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
	case PlaybookEventKindHarvested:
		return "收进了主分支"
	case PlaybookEventKindAbandoned:
		return "放弃了" + why
	case PlaybookEventKindNoted:
		return playbookOr(e.Detail)
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

func playbookOr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// playbookSlice is JavaScript's s.slice(0, n): the first n UTF-16 units. A pair cut in half leaves U+FFFD.
func playbookSlice(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

// playbookNumber is JavaScript's Number(s); NaN when it is not one.
func playbookNumber(s string) float64 {
	t := coreTrim(s)
	if t == "" {
		return 0
	}
	switch t {
	case "Infinity", "+Infinity":
		return math.Inf(1)
	case "-Infinity":
		return math.Inf(-1)
	}
	if len(t) > 2 && t[0] == '0' {
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[t[1]]
		if base != 0 {
			if strings.ContainsAny(t[2:], "_+-") {
				return math.NaN()
			}
			n, err := strconv.ParseUint(t[2:], base, 64)
			if err != nil {
				return math.NaN()
			}
			return float64(n)
		}
	}
	// Go reads more than JavaScript does: inf, nan, underscores, hex floats.
	for _, r := range t {
		if !strings.ContainsRune("0123456789+-.eE", r) {
			return math.NaN()
		}
	}
	n, err := strconv.ParseFloat(t, 64)
	if err != nil {
		if ne, ok := err.(*strconv.NumError); ok && ne.Err == strconv.ErrRange {
			return n
		}
		return math.NaN()
	}
	return n
}

// playbookNumberText is JavaScript's String(n).
func playbookNumberText(n float64) string {
	switch {
	case math.IsNaN(n):
		return "NaN"
	case math.IsInf(n, 1):
		return "Infinity"
	case math.IsInf(n, -1):
		return "-Infinity"
	case n == 0:
		return "0"
	}
	if a := math.Abs(n); a >= 1e21 || a < 1e-6 {
		s := strconv.FormatFloat(n, 'e', -1, 64)
		mant, exp, _ := strings.Cut(s, "e")
		if exp[0] == '+' {
			exp = exp[1:]
		}
		exp = strings.TrimLeft(exp, "0")
		if strings.HasPrefix(exp, "-") {
			exp = "-" + strings.TrimLeft(exp[1:], "0")
			return mant + "e" + exp
		}
		return mant + "e+" + exp
	}
	return strconv.FormatFloat(n, 'f', -1, 64)
}
