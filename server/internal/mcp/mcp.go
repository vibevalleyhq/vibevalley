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
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/pkg/x/str"
)

// The bearer token each session session is handed (Tokens) only says who is calling. Every tool answers in words a model acts on, a refusal too.

type Service struct {
	core    *core.Service
	tokens  *session.Service
	chat    *channel.Service
	handler http.Handler
	// nil: the farm's Tokens. Tests may put their own.
	who func(token string) string
}

func newService(cfg base.Config, core *core.Service, tokens *session.Service, chat *channel.Service) (*Service, error) {
	t := &Service{core: core, tokens: tokens, chat: chat}
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
		return fmt.Sprintf("发出去了：%s msg=%d%s", s.Target, s.Message.Seq, absent)
	}
}

var spaces = regexp.MustCompile(`\s+`)

type sayArgs struct {
	Text    string `json:"text"`
	Target  string `json:"target,omitempty"`
	Anyway  bool   `json:"anyway,omitempty" jsonschema:"看过新消息、仍要原样发"`
	Confirm bool   `json:"confirm,omitempty" jsonschema:"确实要发到田头顶层，而不是刚读的那个串"`
}

type readArgs struct {
	Target string  `json:"target,omitempty"`
	Unread bool    `json:"unread,omitempty"`
	Before float64 `json:"before,omitempty"`
	Limit  float64 `json:"limit,omitempty"`
}

func (t *Service) add(server *sdk.Server) {
	sdk.AddTool(server, &sdk.Tool{
		Name:        "channel_say",
		Description: "在农场的群聊里发一条消息。target 不填就是你自己的工单串；#<频道> 是一个频道（#" + protocol.GeneralName + " 是默认的频道田头）；#<频道>:<消息号> 是那条消息下面的串。正文里写 @w3、@管家、@主人 就是叫谁。目标里有你没看过的新消息时会先不发，把新消息给你看。",
	}, func(_ context.Context, req *sdk.CallToolRequest, p sayArgs) (*sdk.CallToolResult, any, error) {
		id, err := t.caller(req)
		if err != nil {
			return toolText("", err)
		}
		spoken, err := t.chat.Speak(id, p.Text, channel.SpeakOptions{Target: p.Target, Anyway: p.Anyway, Confirm: p.Confirm})
		if err != nil {
			return toolText("", err)
		}
		return toolText(spokenText(spoken), nil)
	})

	sdk.AddTool(server, &sdk.Tool{
		Name:        "channel_read",
		Description: "读田头或一个串。target 不填就是你自己的工单串。unread 只读你还没读过的；before:<消息号> 往前翻。读过的算你看过了。",
	}, func(_ context.Context, req *sdk.CallToolRequest, p readArgs) (*sdk.CallToolResult, any, error) {
		id, err := t.caller(req)
		if err != nil {
			return toolText("", err)
		}
		r, err := t.chat.Read(id, channel.ReadOptions{Target: p.Target, Unread: p.Unread, Before: int64(p.Before), Limit: int64(p.Limit)})
		if err != nil {
			return toolText("", err)
		}
		if len(r.Messages) == 0 {
			unread := ""
			if p.Unread {
				unread = "你没读的"
			}
			return toolText(r.Target+" 里没有"+unread+"消息", nil)
		}
		older := ""
		if r.Older {
			older = fmt.Sprintf("（更早的还有：before:%d 往前翻）", r.Messages[0].Seq)
		}
		return toolText(r.Target+older+"：\n"+protocol.InboxLines(r.Messages), nil)
	})

	sdk.AddTool(server, &sdk.Tool{
		Name:        "channel_inbox",
		Description: "列出你还没读的对话：在哪、几条、有没有提到你、最后是谁说的。",
	}, func(_ context.Context, req *sdk.CallToolRequest, _ struct{}) (*sdk.CallToolResult, any, error) {
		id, err := t.caller(req)
		if err != nil {
			return toolText("", err)
		}
		rows := t.chat.Inbox(id)
		if len(rows) == 0 {
			return toolText("没有没读的消息。", nil)
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
		return toolText(strings.Join(lines, "\n"), nil)
	})

	sdk.AddTool(server, &sdk.Tool{
		Name:        "session_list",
		Description: "地里现在有谁：每个帮工的编号、名字、农机、在哪个项目、在做什么。",
	}, func(_ context.Context, req *sdk.CallToolRequest, _ struct{}) (*sdk.CallToolResult, any, error) {
		if _, err := t.caller(req); err != nil {
			return toolText("", err)
		}
		// Listed without @: an @ wakes someone, and models copy what they read.
		lines := []string{"地里有主人、管家，和这些帮工："}
		for _, h := range t.core.State().Sessions {
			doing := "这一轮做完了"
			switch p := h.Phase.Value.(type) {
			case protocol.PhaseWorking:
				doing = "在" + protocol.ActionText[p.Doing.Action]
				if p.Doing.Label != "" {
					doing += " " + p.Doing.Label
				}
			case protocol.PhaseArriving:
				doing = "刚到"
			}
			project := "?"
			if h.Project != nil {
				project = *h.Project
			}
			task := str.Head(spaces.ReplaceAllString(h.Task, " "), 60)
			lines = append(lines, fmt.Sprintf("- %s %s（%s，在 %s；%s）工单：%s", h.ID, h.Name, h.Runtime, project, doing, task))
		}
		lines = append(lines, "要叫醒谁，就在 channel_say 的话里写 @ 加编号（如 @w3）、@管家、@主人；只是提到，不带 @。")
		return toolText(strings.Join(lines, "\n"), nil)
	})
}
