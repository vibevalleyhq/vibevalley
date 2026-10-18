package brain

// Only initialize, tools/list (every page) and tools/call: no resources, prompts or sampling. A server that cannot be reached is left out and said
// why; the others still come.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"

	"vibevalley/pkg/agentcore"
)

// Also for connecting.
const CALL_TIMEOUT = 120 * time.Second

func McpContentText(content []mcp.Content) string {
	parts := make([]string, 0, len(content))
	for _, block := range content {
		switch block := block.(type) {
		case *mcp.TextContent:
			parts = append(parts, block.Text)
		case *mcp.ImageContent:
			parts = append(parts, "[image]")
		case *mcp.AudioContent:
			parts = append(parts, "[audio]")
		case *mcp.ResourceLink:
			parts = append(parts, "[resource_link]")
		case *mcp.EmbeddedResource:
			switch {
			case block.Resource != nil && block.Resource.Text != "":
				parts = append(parts, block.Resource.Text)
			case block.Resource != nil && block.Resource.URI != "":
				parts = append(parts, "["+block.Resource.URI+"]")
			default:
				parts = append(parts, "[资源]")
			}
		}
	}
	return strings.TrimSpace(strings.Join(parts, "\n"))
}

var notFunctionName = regexp.MustCompile(`[^A-Za-z0-9_-]`)

// The server's name first, only the characters function names allow.
func McpToolName(server, tool string) string {
	name := notFunctionName.ReplaceAllString(server+"__"+tool, "_")
	if len(name) > 64 {
		name = name[:64]
	}
	return name
}

type headerTransport struct {
	headers map[string]string
	base    http.RoundTripper
}

func (t headerTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	for k, v := range t.headers {
		r.Header.Set(k, v)
	}
	return t.base.RoundTrip(r)
}

// Keeps the end of a server's stderr, to say why it went.
type lastLine struct {
	mu   sync.Mutex
	text string
}

func (l *lastLine) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.text += string(p)
	if r := []rune(l.text); len(r) > 2000 {
		l.text = string(r[len(r)-2000:])
	}
	return len(p), nil
}

func (l *lastLine) last() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	lines := strings.Split(strings.TrimSpace(l.text), "\n")
	return lines[len(lines)-1]
}

type McpConnection struct {
	Tools   []agentcore.AgentTool
	session *mcp.ClientSession
}

func (c *McpConnection) Close() {
	if c != nil && c.session != nil {
		_ = c.session.Close()
	}
}

func ConnectMcp(ctx context.Context, server McpServer) (*McpConnection, error) {
	fail := func(err error, stderr *lastLine) error {
		why := err.Error()
		if stderr != nil {
			if last := stderr.last(); last != "" {
				why += "：" + last
			}
		}
		return fmt.Errorf("连不上 MCP 服务 %s：%s", server.Name, why)
	}
	var transport mcp.Transport
	var stderr *lastLine
	if server.URL != "" {
		client := &http.Client{Transport: headerTransport{headers: server.Headers, base: http.DefaultTransport}}
		transport = &mcp.StreamableClientTransport{Endpoint: server.URL, HTTPClient: client, MaxRetries: -1}
	} else {
		cmd := exec.Command(server.Command, server.Args...)
		cmd.Dir = server.Cwd
		cmd.Env = os.Environ()
		for k, v := range server.Env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		stderr = &lastLine{}
		cmd.Stderr = stderr
		transport = &mcp.CommandTransport{Command: cmd, TerminateDuration: 2 * time.Second}
	}
	connectCtx, cancel := context.WithTimeout(ctx, CALL_TIMEOUT)
	defer cancel()
	client := mcp.NewClient(&mcp.Implementation{Name: "vibevalley-agent", Version: "0.1.0"}, nil)
	session, err := client.Connect(connectCtx, transport, nil)
	if err != nil {
		return nil, fail(err, stderr)
	}
	connection := &McpConnection{session: session}
	for t, err := range session.Tools(connectCtx, nil) {
		if err != nil {
			connection.Close()
			return nil, fail(err, stderr)
		}
		connection.Tools = append(connection.Tools, mcpTool(session, server.Name, t))
	}
	return connection, nil
}

func mcpTool(session *mcp.ClientSession, server string, t *mcp.Tool) agentcore.AgentTool {
	parameters := agentcore.JsonSchemaObject{"type": "object", "properties": map[string]any{}}
	if t.InputSchema != nil {
		var schema map[string]any
		if raw, err := json.Marshal(t.InputSchema); err == nil && json.Unmarshal(raw, &schema) == nil && schema != nil {
			parameters = schema
		}
	}
	description := t.Description
	if description == "" {
		description = t.Name
	}
	return JsonTool(JsonToolSpec{
		Name:        McpToolName(server, t.Name),
		Label:       server + " · " + t.Name,
		Description: "（" + server + "）" + description,
		Parameters:  parameters,
		Run: func(ctx context.Context, params json.RawMessage, _ ToolContext) (string, error) {
			ctx, cancel := context.WithTimeout(ctx, CALL_TIMEOUT)
			defer cancel()
			var arguments any = map[string]any{}
			if len(params) > 0 && string(params) != "null" {
				arguments = params
			}
			r, err := session.CallTool(ctx, &mcp.CallToolParams{Name: t.Name, Arguments: arguments})
			if err != nil {
				return "", fmt.Errorf("%s 的 %s 出错：%s", server, t.Name, err.Error())
			}
			text := McpContentText(r.Content)
			if text == "" {
				if r.StructuredContent != nil {
					raw, _ := json.Marshal(r.StructuredContent)
					text = string(raw)
				} else {
					text = "（没有内容）"
				}
			}
			if r.IsError {
				return "", fmt.Errorf("%s", text)
			}
			return text, nil
		},
	})
}

type McpConnections struct {
	Tools       []agentcore.AgentTool
	Failed      []string
	connections []*McpConnection
}

func (c *McpConnections) Close() {
	for _, connection := range c.connections {
		connection.Close()
	}
}

func ConnectAll(ctx context.Context, servers []McpServer) *McpConnections {
	type outcome struct {
		connection *McpConnection
		err        error
	}
	outcomes := make([]outcome, len(servers))
	var wg sync.WaitGroup
	for i, s := range servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := ConnectMcp(ctx, s)
			outcomes[i] = outcome{c, err}
		}()
	}
	wg.Wait()
	all := &McpConnections{Tools: []agentcore.AgentTool{}, Failed: []string{}}
	for _, o := range outcomes {
		if o.err != nil {
			all.Failed = append(all.Failed, o.err.Error())
			continue
		}
		all.connections = append(all.connections, o.connection)
		all.Tools = append(all.Tools, o.connection.Tools...)
	}
	return all
}
