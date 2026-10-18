package manager

import (
	"fmt"
	"slices"
	"strings"

	"vibevalley/internal/protocol"
)

// conversation is where the input it goes with will be answered. Said last and on a line of its own, so that answering in
// another channel changes one line of it.
func (fm *manager) situation(conversation string) string {
	var sessions []string
	for _, a := range fm.agentsWithIssues() {
		// 职责 is the profile's Role; 适合的活 its Tags, which ChooseAgent matches and the prompt tells it to pick by.
		line := fmt.Sprintf("- %s（id %s，%s）", a.Agent.Name, a.Agent.ID, protocol.RuntimeLabel(a.Agent.Runtime))
		if a.Agent.Role != "" {
			line += "职责：" + a.Agent.Role
		}
		if len(a.Agent.Tags) > 0 {
			if a.Agent.Role != "" {
				line += "；"
			}
			line += "适合的活：" + strings.Join(a.Agent.Tags, "、")
		}
		switch {
		case a.Usable():
			line += "；" + managerQuota(a.Info)
		case len(a.Blocking) > 0:
			line += "；现在派不了：" + a.Blocking[0].Text
		default:
			line += "；现在派不了：停用了"
		}
		sessions = append(sessions, line)
	}
	roster := fm.run.Roster()
	here := fm.chat.ChannelOf(conversation)
	var byChannel []string
	for _, c := range fm.chat.Channels() {
		var theirs []string
		for _, w := range roster {
			channel := fm.chat.General()
			if w.Session.Channel != nil {
				channel = *w.Session.Channel
			}
			if channel == c.ID {
				theirs = append(theirs, fm.tool.SessionLine(w))
			}
		}
		head := "#" + c.Name
		if c.Description != "" {
			head += "：" + c.Description
		}
		if c.Project != "" {
			head += "；默认项目 " + c.Project
		}
		body := "  （没有帮工）"
		if len(theirs) > 0 {
			body = strings.Join(theirs, "\n")
		}
		byChannel = append(byChannel, head+"\n"+body)
	}
	folders := "（还没有）"
	if all := fm.projects.List(); len(all) > 0 {
		names := make([]string, len(all))
		for i, p := range all {
			names[i] = p.Name
		}
		folders = strings.Join(names, "、")
	}
	tasks := ""
	var open []string
	for _, graph := range protocol.GraphsOf(fm.core.State()) {
		if protocol.IsOpen(graph) {
			open = append(open, protocol.GraphText(graph))
		}
	}
	if len(open) > 0 {
		tasks = "\n种植计划：\n" + strings.Join(open, "\n")
	}
	return "【农场现状】\n项目（工作目录 " + fm.projects.Root() + " 下的文件夹）：" + folders + "\n可以派的帮工：\n" + strings.Join(sessions, "\n") +
		"\n各频道和地里的帮工：\n" + strings.Join(byChannel, "\n") + tasks + "\n你正在回话的频道：#" + here.Name
}

type situationLine struct{ head, line string }

// An item ("- …", or indented) is known by the head above it too: the same "（没有帮工）" under two channels is two lines.
func situationLines(text string) []situationLine {
	var out []situationLine
	head := ""
	for _, l := range strings.Split(text, "\n") {
		if strings.HasPrefix(l, "- ") || strings.HasPrefix(l, " ") {
			out = append(out, situationLine{head, l})
			continue
		}
		head = l
		out = append(out, situationLine{"", l})
	}
	return out
}

// What changed from before to now, line by line: + for a line now has and before had not, − for one gone, each item after
// the head it is under. The whole of now when more than half its lines changed, where a list of changes reads worse than
// the thing; "" when nothing did.
func situationDelta(before, now string) string {
	was, is := situationLines(before), situationLines(now)
	type change struct {
		situationLine
		mark string
	}
	var changes []change
	for _, l := range is {
		if !slices.Contains(was, l) {
			changes = append(changes, change{l, "+ "})
		}
	}
	for _, l := range was {
		if !slices.Contains(is, l) {
			changes = append(changes, change{l, "− "})
		}
	}
	if len(changes) == 0 {
		return ""
	}
	if len(changes)*2 > len(is) {
		return now
	}
	out := []string{"【农场变了】"}
	head := ""
	for _, c := range changes {
		switch {
		case c.head == "":
			head = c.line
		case c.head != head:
			out = append(out, c.head)
			head = c.head
		}
		out = append(out, c.mark+c.line)
	}
	return strings.Join(out, "\n")
}
