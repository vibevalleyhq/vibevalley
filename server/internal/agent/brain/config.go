package brain

// MCP servers in the shape Claude Code and Cursor use: { "mcpServers": { name: { command, args, env } | { url } } }.

import (
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sort"
	"strings"

	"vibevalley/pkg/ai"
)

const DEFAULT_MODEL = "deepseek-flash"

// Said for the command line; the farm says where to put one in the app.
var ErrNoDeepSeekKey = errors.New("没有 DeepSeek 的密钥：设 DEEPSEEK_API_KEY，或者写进 vibevalley.yaml 的 deepseek.api_key。")

type LLM struct {
	Model         ai.Model
	StreamOptions ai.StreamOptions
}

// id empty is DEFAULT_MODEL; the key is the caller's to find.
func Deepseek(id, key string) (LLM, error) {
	if key == "" {
		return LLM{}, ErrNoDeepSeekKey
	}
	name := cmp.Or(id, DEFAULT_MODEL)
	model, known := ai.GetModel("deepseek", name)
	if !known {
		model, _ = ai.GetModel("deepseek", DEFAULT_MODEL)
		model.ID = name
		model.Name = name
	}
	model.BaseURL = "https://api.deepseek.com"
	return LLM{Model: model, StreamOptions: ai.StreamOptions{APIKey: key}}, nil
}

type McpServer struct {
	Name    string
	URL     string
	Headers map[string]string
	Command string
	Args    []string
	Env     map[string]string
	Cwd     string
}

func ReadMcpConfig(path string) ([]McpServer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		data = []byte("{}")
	}
	var config struct {
		McpServers map[string]struct {
			Command  string            `json:"command"`
			Args     []string          `json:"args"`
			Env      map[string]string `json:"env"`
			Cwd      string            `json:"cwd"`
			URL      string            `json:"url"`
			Headers  map[string]string `json:"headers"`
			Disabled bool              `json:"disabled"`
		} `json:"mcpServers"`
	}
	if strings.TrimSpace(string(data)) == "" || json.Unmarshal(data, &config) != nil {
		return nil, fmt.Errorf("%s 不是 JSON", path)
	}
	names := make([]string, 0, len(config.McpServers))
	for name := range config.McpServers {
		names = append(names, name)
	}
	sort.Strings(names)
	out := []McpServer{}
	for _, name := range names {
		e := config.McpServers[name]
		switch {
		case e.Disabled:
		case e.URL != "":
			out = append(out, McpServer{Name: name, URL: e.URL, Headers: e.Headers})
		case e.Command != "":
			out = append(out, McpServer{Name: name, Command: e.Command, Args: e.Args, Env: e.Env, Cwd: e.Cwd})
		}
	}
	return out, nil
}
