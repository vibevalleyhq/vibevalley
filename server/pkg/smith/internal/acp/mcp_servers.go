package acp

import (
	"sort"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// SessionOptions.MCPServers on an ACP runtime (mcp-servers.ts): the
// `mcpServers` param of `session/new`, `session/load` and `session/resume`,
// in ACP's shape (stdio `{name, command, args, env: [{name, value}]}`, http
// `{type: "http", name, url, headers: [{name, value}]}`). Given on every
// open: no measured agent remembers them across a resume. Every list is sent
// whole, `args`, `env` and `headers` included when empty, because opencode
// 1.18.30 reads them unguarded.
//
// Go note: oar.McpServer keeps env and headers in a map, so the pairs go out
// sorted by name (TS: insertion order).

type pair struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

func pairs(values map[string]string) []pair {
	out := make([]pair, 0, len(values))
	for name, value := range values {
		out = append(out, pair{name, value})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

type stdioServer struct {
	Name    string   `json:"name"`
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Env     []pair   `json:"env"`
}

type httpServer struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	URL     string `json:"url"`
	Headers []pair `json:"headers"`
}

// McpServer is one entry in ACP's McpServer shape.
func McpServer(server oar.McpServer) any {
	if server.IsHTTP() {
		return httpServer{Type: "http", Name: server.Name, URL: server.URL, Headers: pairs(server.Headers)}
	}
	args := append([]string{}, server.Args...)
	return stdioServer{Name: server.Name, Command: server.Command, Args: args, Env: pairs(server.Env)}
}

// McpServersParam is the `mcpServers` param for an open, given the agent's
// `initialize` answer: an http entry is refused (UnsupportedOptionError on
// mcpServers) unless the agent declares
// `agentCapabilities.mcpCapabilities.http`, which ACP requires before a
// client sends one. Stdio needs no capability.
func McpServersParam(servers []oar.McpServer, initialized jsonx.Record) ([]any, error) {
	given := shared.GivenMcpServers(servers)
	out := []any{}
	if given == nil {
		return out, nil
	}
	http, _ := jsonx.Get(initialized, "agentCapabilities", "mcpCapabilities", "http").(bool)
	for _, server := range given {
		if server.IsHTTP() && !http {
			return nil, &oar.UnsupportedOptionError{Option: "mcpServers", Message: "the agent's initialize declares no mcpCapabilities.http, so it attaches no http MCP server (" + jsonText(server.Name) + ")"}
		}
	}
	for _, server := range given {
		out = append(out, McpServer(server))
	}
	return out, nil
}

// McpOpenGuard is, for an open given these entries: an error now, before
// the agent starts, on an empty or repeated name; and otherwise what a
// failed open's error becomes, the same error without the credentials the
// entries carry. redact nil uses the entries' own credential redactor.
func McpOpenGuard(servers []oar.McpServer, redact func(string) string) (func(error) error, error) {
	if redact == nil {
		redact = shared.McpCredentialRedactor(servers)
	}
	if err := shared.CheckMcpServerNames(servers); err != nil {
		return nil, err
	}
	return func(err error) error { return shared.RedactError(err, redact) }, nil
}
