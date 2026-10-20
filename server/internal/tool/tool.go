package tool

import (
	"bytes"
	"context"
	"encoding/json"
	"slices"
	"strings"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/x/str"
)

// Every tool answers in a sentence, a refusal included: the model acts on it.

// Who a tool's words and arguments are written for. A tool both kinds share is one tool; where the kinds really differ
// (the manager writes another profile's memory, a session only its own), the variant is chosen here, in one place.
type kind int

const (
	forManager kind = iota
	forSession
)

// The manager's tools, in the order its prompt has always listed them: the order is part of the prompt's prefix.
func (s *Service) Manager(who Who) []agentcore.AgentTool {
	return []agentcore.AgentTool{
		s.dispatch(who), s.projectsTool(), s.channelsTool(), s.scheduleTool(who), s.listSchedules(), s.cancelSchedule(), s.openChannel(),
		s.channelSettings(), s.merge(who), s.accept(), s.changes(), s.roster(), s.check(), s.tell(who), s.readChat(who), s.stop(), s.dismiss(),
		s.graphSplit(), s.graphsTool(), s.taskEdit(), s.graphAction(who), s.taskAction(), s.memorySearch(who, forManager),
		s.memoryAdd(who, forManager),
	}
}

// A session's tools, served on /mcp.
func (s *Service) Session(who Who) []agentcore.AgentTool {
	return []agentcore.AgentTool{
		s.channelSay(who), s.readChat(who), s.channelInbox(who), s.sessionList(), s.memorySearch(who, forSession), s.memoryAdd(who, forSession),
		s.docRead(who), s.docAppend(who), s.docUpdate(who),
	}
}

var labels = map[string]string{
	"dispatch":         "派活",
	"projects":         "项目",
	"channels":         "频道",
	"open_channel":     "开频道",
	"channel_settings": "改频道",
	"schedule":         "定时",
	"list_schedules":   "看定时",
	"cancel_schedule":  "取消定时",
	"merge":            "收获",
	"accept":           "验收",
	"changes":          "看改动",
	"roster":           "花名册",
	"check":            "看进度",
	"tell":             "带话",
	"read_chat":        "看对话",
	"stop":             "叫停",
	"dismiss":          "收工",
	"graph_split":      "拆计划",
	"graphs":           "看计划",
	"task_edit":        "改计划",
	"graph_action":     "计划",
	"task_action":      "计划的一件",
	"remember":         "记一条",
	"rewrite_memory":   "整理记性",
	"search_archive":   "翻旧账",
	"memory_search":    "翻记性",
	"memory_add":       "替帮工记",
	"doc_read":         "读文档",
	"doc_append":       "往文档里加一块",
	"doc_update":       "改文档的一块",
}

var named = []string{"agent", "session", "project", "name", "query", "note", "goal"}

// How a tool call reads in the manager's trajectory: its label and the first naming argument.
func (*Service) Start(name string, args json.RawMessage) session.ToolStart {
	var fields map[string]any
	_ = json.Unmarshal(args, &fields)
	about := ""
	for _, k := range named {
		if v, ok := fields[k].(string); ok && strings.TrimSpace(v) != "" {
			about = v
			break
		}
	}
	label := labels[name]
	if label == "" {
		label = name
	}
	text := label
	if about != "" {
		if str.Units(about) > 40 {
			about = str.Head(about, 40) + "…"
		}
		text = label + "：" + about
	}
	input := "{}"
	if len(args) > 0 {
		var b bytes.Buffer
		if err := json.Compact(&b, args); err == nil {
			input = b.String()
		} else {
			input = string(args)
		}
	}
	return session.ToolStart{Text: text, Action: protocol.ToolActionOther, Tool: name, Input: input}
}

type sessionArgs struct {
	Session string `json:"session" jsonschema:"帮工的名字或 id"`
}

type none struct{}

func answered(text string, err error) (string, error) {
	if err != nil {
		return "没成：" + err.Error(), nil
	}
	return text, nil
}

// The manager may name a session by its id, its name, or words that contain its name.
func (s *Service) findSession(key string) *session.Roster {
	all := s.run.Roster()
	for _, pick := range []func(w session.Roster) bool{
		func(w session.Roster) bool { return w.Session.ID == key },
		func(w session.Roster) bool { return w.Session.Name == key },
		func(w session.Roster) bool { return strings.Contains(key, w.Session.Name) },
	} {
		if i := slices.IndexFunc(all, pick); i >= 0 {
			return &all[i]
		}
	}
	return nil
}

func (s *Service) withSession(key string, run func(w session.Roster) string) (string, error) {
	w := s.findSession(key)
	if w == nil {
		return "没有叫 " + key + " 的帮工", nil
	}
	return run(*w), nil
}

func (s *Service) sessionTool(name, description string, run func(w session.Roster) string) agentcore.AgentTool {
	return brain.TextTool(brain.TextToolSpec[sessionArgs]{
		Name: name, Label: labels[name], Description: description, Parameters: schemaOf[sessionArgs](),
		Run: func(_ context.Context, p sessionArgs, _ brain.ToolContext) (string, error) {
			return s.withSession(p.Session, run)
		},
	})
}
