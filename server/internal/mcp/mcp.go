package mcp

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"regexp"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/core"
	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/ptr"
	"vibevalley/pkg/x/str"
)

// The bearer token each session session is handed (Tokens) only says who is calling. Every tool answers in words a model acts on, a refusal too.

type Service struct {
	core    *core.Service
	tokens  *session.Service
	chat    *channel.Service
	memory  *memory.Service
	handler http.Handler
	// nil: the farm's Tokens. Tests may put their own.
	who func(token string) string
}

func newService(cfg base.Config, core *core.Service, tokens *session.Service, chat *channel.Service, memory *memory.Service) (*Service, error) {
	t := &Service{core: core, tokens: tokens, chat: chat, memory: memory}
	server := sdk.NewServer(&sdk.Implementation{Name: "vibevalley", Version: cfg.Version}, nil)
	t.add(server)
	t.handler = sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, nil)
	return t, nil
}

func (*Service) OnStart(context.Context) error { return nil }
func (*Service) OnStop()                       {}

func (t *Service) Handler() http.Handler { return t.handler }

func (t *Service) caller(req *sdk.CallToolRequest) (string, error) {
	token := ""
	if req != nil && req.Extra != nil && req.Extra.Header != nil {
		if header := req.Extra.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
			token = strings.TrimPrefix(header, "Bearer ")
		}
	}
	who := ""
	if token != "" {
		if t.who != nil {
			who = t.who(token)
		} else {
			who = t.tokens.Who(token)
		}
	}
	if who == "" {
		return "", errors.New("没认出你是谁：这些工具只给农场里的帮工用")
	}
	return who, nil
}

func toolText(text string, err error) (*sdk.CallToolResult, any, error) {
	if err != nil {
		text = "没成：" + err.Error()
	}
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}, nil, nil
}

func spokenText(s channel.Spoken) string {
	switch s.Kind {
	case "held":
		more := ""
		if s.More > 0 {
			more = fmt.Sprintf("（这里是最新的 %d 条）", len(s.Shown))
		}
		return strings.Join([]string{
			fmt.Sprintf("先没发：%s 里有 %d 条你还没看过的新消息%s：", s.Target, len(s.Shown)+s.More, more),
			protocol.InboxLines(s.Shown),
			"",
			"看过了：要改就改了再发；原样发就加 anyway: true；不用发了就不发。",
		}, "\n")
	case "confirm":
		return fmt.Sprintf("先没发：你刚读的是 %s，这条却要发到 %s 顶层。要回在那个串里，就把 target 写成 %s；确实要发到田头，就加 confirm: true。", s.LastRead, s.Target, s.LastRead)
	default:
		absent := ""
		if len(s.NotOnFarm) > 0 {
			names := make([]string, len(s.NotOnFarm))
			for i, m := range s.NotOnFarm {
				names[i] = "@" + m
			}
			absent = "。" + strings.Join(names, "、") + " 不在地里，没送到"
		}
		return fmt.Sprintf("发出去了：%s msg=%d%s", s.Target, s.Message.Number, absent)
	}
}

var spaces = regexp.MustCompile(`\s+`)

type sayArgs struct {
	Text    string `json:"text"`
	Target  string `json:"target,omitempty"`
	Anyway  bool   `json:"anyway,omitempty" jsonschema:"看过新消息、仍要原样发"`
	Confirm bool   `json:"confirm,omitempty" jsonschema:"确实要发到田头顶层，而不是刚读的那个串"`
}

type memorySearchArgs struct {
	Query       string `json:"query,omitempty" jsonschema:"要找什么，几个词或一句话；不填就列出最新的"`
	AllProjects bool   `json:"all_projects,omitempty" jsonschema:"也找别的项目里记下的"`
}

type memoryAddArgs struct {
	Text        string `json:"text" jsonschema:"一句以后还用得上的话：约定、坑、命令"`
	AllProjects bool   `json:"all_projects,omitempty" jsonschema:"所有项目都用得上，不只是这个项目"`
	Agent       string `json:"agent,omitempty" jsonschema:"不用填：只能记进你自己的档案"`
}

// A session's memory is its profile's, and its project is where it works: neither is the caller's to choose.
func (t *Service) workingAs(id string) (agent, project string, err error) {
	for _, h := range t.core.State().Sessions {
		if h.ID == id {
			return h.Agent, ptr.Value(h.Project), nil
		}
	}
	return "", "", errors.New("地里没有你：记性只给在干活的帮工用")
}

type readArgs struct {
	Target string  `json:"target,omitempty"`
	Unread bool    `json:"unread,omitempty"`
	Before float64 `json:"before,omitempty"`
	Limit  float64 `json:"limit,omitempty"`
}

// Tool implementations receive an authenticated identity, never a raw transport request.
func addAuthenticatedTool[Args any](t *Service, server *sdk.Server, tool *sdk.Tool, run func(string, Args) (string, error)) {
	sdk.AddTool(server, tool, func(_ context.Context, req *sdk.CallToolRequest, args Args) (*sdk.CallToolResult, any, error) {
		id, err := t.caller(req)
		if err != nil {
			return toolText("", err)
		}
		text, err := run(id, args)
		return toolText(text, err)
	})
}

func (t *Service) add(server *sdk.Server) {
	addAuthenticatedTool(t, server, &sdk.Tool{
		Name:        "channel_say",
		Description: "在农场的群聊里发一条消息。target 不填就是你自己的工单串；#<频道> 是一个频道（#" + protocol.GeneralName + " 是默认的频道田头）；#<频道>:<消息号> 是那条消息下面的串。正文里写 @w3、@管家、@主人 就是叫谁。目标里有你没看过的新消息时会先不发，把新消息给你看。",
	}, func(id string, p sayArgs) (string, error) {
		spoken, err := t.chat.Speak(id, p.Text, channel.SpeakOptions{Target: p.Target, Anyway: p.Anyway, Confirm: p.Confirm})
		if err != nil {
			return "", err
		}
		return spokenText(spoken), nil
	})

	addAuthenticatedTool(t, server, &sdk.Tool{
		Name:        "channel_read",
		Description: "读田头或一个串。target 不填就是你自己的工单串。unread 只读你还没读过的；before:<消息号> 往前翻。读过的算你看过了。",
	}, func(id string, p readArgs) (string, error) {
		r, err := t.chat.Read(id, channel.ReadOptions{Target: p.Target, Unread: p.Unread, Before: int64(p.Before), Limit: int64(p.Limit)})
		if err != nil {
			return "", err
		}
		if len(r.Messages) == 0 {
			unread := ""
			if p.Unread {
				unread = "你没读的"
			}
			return r.Target + " 里没有" + unread + "消息", nil
		}
		older := ""
		if r.Older {
			older = fmt.Sprintf("（更早的还有：before:%d 往前翻）", r.Messages[0].Number)
		}
		return r.Target + older + "：\n" + protocol.InboxLines(r.Messages), nil
	})

	addAuthenticatedTool(t, server, &sdk.Tool{
		Name:        "channel_inbox",
		Description: "列出你还没读的对话：在哪、几条、有没有提到你、最后是谁说的。",
	}, func(id string, _ struct{}) (string, error) {
		rows := t.chat.Inbox(id)
		if len(rows) == 0 {
			return "没有没读的消息。", nil
		}
		lines := make([]string, 0, len(rows)+1)
		for _, r := range rows {
			line := fmt.Sprintf("- %s：%d 条", r.Target, r.Unread)
			if r.MentionsYou {
				line += "，提到了你"
			}
			if r.Latest != "" {
				line += "，最后是 " + r.Latest
			}
			lines = append(lines, line)
		}
		lines = append(lines, "下一步：channel_read target="+rows[0].Target+" unread=true")
		return strings.Join(lines, "\n"), nil
	})

	addAuthenticatedTool(t, server, &sdk.Tool{
		Name:        "session_list",
		Description: "地里现在有谁：每个帮工的编号、名字、农机、在哪个项目、在做什么。",
	}, func(id string, _ struct{}) (string, error) {
		// Listed without @: an @ wakes someone, and models copy what they read.
		lines := []string{"地里有主人、管家，和这些帮工："}
		for _, h := range t.core.State().Sessions {
			doing := protocol.PhaseText(h, clock.NowMs())
			project := "?"
			if h.Project != nil {
				project = *h.Project
			}
			task := str.Head(spaces.ReplaceAllString(h.Task, " "), 60)
			lines = append(lines, fmt.Sprintf("- %s %s（%s，在 %s；%s）工单：%s", h.ID, h.Name, h.Runtime, project, doing, task))
		}
		lines = append(lines, "要叫醒谁，就在 channel_say 的话里写 @ 加编号（如 @w3）、@管家、@主人；只是提到，不带 @。")
		return strings.Join(lines, "\n"), nil
	})

	addAuthenticatedTool(t, server, &sdk.Tool{
		Name:        "memory_search",
		Description: "在你的记性里找：你和主人以前替你的档案记下的话、做过的活。只找这个项目的和所有项目都用的；all_projects 也找别的项目的。干到一半想知道「这个项目的测试怎么跑」「上次这个坑怎么绕过去的」时用。",
	}, func(id string, p memorySearchArgs) (string, error) {
		agent, project, err := t.workingAs(id)
		if err != nil {
			return "", err
		}
		q := memory.SearchQuery{Agent: agent, Project: project, Text: p.Query}
		if p.AllProjects {
			q.Project = ""
		}
		return memory.FoundText(t.memory.Search(q), q), nil
	})

	addAuthenticatedTool(t, server, &sdk.Tool{
		Name:        "memory_add",
		Description: "往你的记性里记一句，你的档案以后派出去的帮工开工时会想起。记这个项目的；all_projects 记成所有项目都用的。只记以后还用得上的：约定、坑、命令，不记这一次的进度。",
	}, func(id string, p memoryAddArgs) (string, error) {
		agent, project, err := t.workingAs(id)
		if err != nil {
			return "", err
		}
		if p.Agent != "" && p.Agent != agent {
			return "", errors.New("只能记进你自己的档案（" + agent + "），" + p.Agent + " 的记性不归你写")
		}
		if p.AllProjects {
			project = ""
		}
		m, err := t.memory.Remember(agent, p.Text, project)
		if err != nil {
			return "", err
		}
		where := "所有项目"
		if m.Project != nil {
			where = "项目 " + *m.Project
		}
		return "记下了（" + where + "）〔" + m.ID + "〕", nil
	})
}
