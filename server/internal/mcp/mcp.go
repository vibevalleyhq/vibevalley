package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	sdk "github.com/modelcontextprotocol/go-sdk/mcp"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/session"
	"vibevalley/internal/tool"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/x/ptr"
)

// The bearer token each session is handed (Tokens) only says who is calling. The tools are tool.Service's; this package
// serves them over MCP and says which session is calling. Every tool answers in words a model acts on, a refusal too.

type Service struct {
	core    *core.Service
	tokens  *session.Service
	handler http.Handler
	// nil: the farm's Tokens. Tests may put their own.
	who func(token string) string
}

func newService(cfg base.Config, core *core.Service, tokens *session.Service, tools *tool.Service) (*Service, error) {
	t := &Service{core: core, tokens: tokens}
	server := sdk.NewServer(&sdk.Implementation{Name: "vibevalley", Version: cfg.Version}, nil)
	for _, each := range tools.Session(caller) {
		t.add(server, each)
	}
	t.handler = sdk.NewStreamableHTTPHandler(func(*http.Request) *sdk.Server { return server }, nil)
	return t, nil
}

func (*Service) OnStart(context.Context) error { return nil }
func (*Service) OnStop()                       {}

func (t *Service) Handler() http.Handler { return t.handler }

type callerKey struct{}

// The caller the handler authenticated, carried to the tool in the call's context.
func caller(ctx context.Context) (tool.Caller, error) {
	c, ok := ctx.Value(callerKey{}).(tool.Caller)
	if !ok {
		return tool.Caller{}, errors.New("没认出你是谁：这些工具只给农场里的帮工用")
	}
	return c, nil
}

func (t *Service) session(req *sdk.CallToolRequest) (string, error) {
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

// A session's profile and project are where it works: neither is the caller's to choose. A session no longer in the
// fields still talks; its profile and project are empty.
func (t *Service) callerOf(id string) tool.Caller {
	for _, h := range t.core.State().Sessions {
		if h.ID == id {
			return tool.Caller{Agent: h.Agent, Session: id, Project: ptr.Value(h.Project)}
		}
	}
	return tool.Caller{Session: id}
}

// Tool implementations receive an authenticated identity, never a raw transport request.
func (t *Service) add(server *sdk.Server, each agentcore.AgentTool) {
	server.AddTool(&sdk.Tool{Name: each.Name, Description: each.Description, InputSchema: map[string]any(each.Parameters)},
		func(ctx context.Context, req *sdk.CallToolRequest) (*sdk.CallToolResult, error) {
			id, err := t.session(req)
			if err != nil {
				return toolText("", err), nil
			}
			args := json.RawMessage("{}")
			if req.Params != nil && len(req.Params.Arguments) > 0 {
				args = req.Params.Arguments
			}
			args, err = agentcore.DecodeArguments(each, args)
			if err != nil {
				return toolText("", err), nil
			}
			r, err := each.Execute(context.WithValue(ctx, callerKey{}, t.callerOf(id)), "", args, nil)
			if err != nil {
				return toolText("", err), nil
			}
			return toolText(agentcore.ResultText(r.Content), nil), nil
		})
}

func toolText(text string, err error) *sdk.CallToolResult {
	if err != nil {
		text = "没成：" + err.Error()
	}
	return &sdk.CallToolResult{Content: []sdk.Content{&sdk.TextContent{Text: text}}}
}
