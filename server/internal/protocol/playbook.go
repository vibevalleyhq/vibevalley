package protocol

// Texts are measured as JavaScript does (UTF-16 units) and trimmed as its trim does.

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

	"vibevalley/pkg/x/str"
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

// What each plan action is called; the buttons and the refusals say the same word.
var PlaybookActionText = map[PlaybookAction]string{
	PlaybookActionStart:   "开工",
	PlaybookActionPause:   "暂停",
	PlaybookActionResume:  "继续",
	PlaybookActionAbandon: "放弃",
	PlaybookActionMerge:   "收获",
}

// The short tag beside a plan's state in the list; PlaybookStateText is the longer sentence.
var PlaybookStateTag = map[PlaybookState]string{
	PlaybookStatePlanning:  "在拆",
	PlaybookStateDraft:     "等你看",
	PlaybookStateRunning:   "在做",
	PlaybookStatePaused:    "暂停了",
	PlaybookStateRipe:      "可收获",
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
		if str.Trim(n.Task) == "" {
			problems = append(problems, "「"+n.ID+"」没有工单")
		}
		if IsAcceptance(n) && (n.Check == nil || str.Trim(*n.Check) == "") {
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
