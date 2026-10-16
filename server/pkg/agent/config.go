package agent

// Where the model and the MCP servers come from. DeepSeek's key from the environment (DEEPSEEK_API_KEY), else the
// one pi already has (~/.pi/agent/models.json), so a machine set up for vibevalley's manager needs nothing more.
// MCP servers in the shape Claude Code and Cursor use: { "mcpServers": { name: { command, args, env } | { url } } }.

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"vibevalley/pkg/ai"
)

const DEFAULT_MODEL = "deepseek-flash"

var envNamePattern = regexp.MustCompile(`^\$?\{?([A-Z][A-Z0-9_]*)\}?$`)

// DefaultModelID is the model vibevalley's own agent runs on when none is named: VIBEVALLEY_AGENT_MODEL, else DEFAULT_MODEL.
func DefaultModelID() string {
	if name := os.Getenv("VIBEVALLEY_AGENT_MODEL"); name != "" {
		return name
	}
	return DEFAULT_MODEL
}

// ErrNoDeepSeekKey: no DeepSeek key in settings, the environment or pi. Said for the command line; the farm says where
// to put one in the app.
var ErrNoDeepSeekKey = errors.New("没有 DeepSeek 的密钥：设 DEEPSEEK_API_KEY，或者先在 pi 里配好 deepseek。")

// EnvName is the environment variable a pi key names instead of being one: DEEPSEEK_API_KEY, $DEEPSEEK_API_KEY or
// ${DEEPSEEK_API_KEY}; "" for a key itself.
func EnvName(key string) string {
	if m := envNamePattern.FindStringSubmatch(key); m != nil {
		return m[1]
	}
	return ""
}

type piDeepseek struct {
	baseURL string
	key     string
}

// fromPi is pi's DeepSeek: its base URL and key (a key that names an environment variable is read from there).
func fromPi() *piDeepseek {
	home, _ := os.UserHomeDir()
	data, err := os.ReadFile(filepath.Join(home, ".pi", "agent", "models.json"))
	if err != nil {
		return nil
	}
	var config struct {
		Providers map[string]struct {
			BaseURL string `json:"baseUrl"`
			APIKey  string `json:"apiKey"`
		} `json:"providers"`
	}
	if json.Unmarshal(data, &config) != nil {
		return nil
	}
	p, ok := config.Providers["deepseek"]
	if !ok {
		return nil
	}
	key := p.APIKey
	if name := EnvName(key); key != "" && name != "" {
		key = os.Getenv(name)
	}
	if key == "" {
		return nil
	}
	return &piDeepseek{baseURL: p.BaseURL, key: key}
}

// PiDeepseekKey is pi's DeepSeek key, if pi has one: so a host can say where the key it will use comes from.
func PiDeepseekKey() string {
	if p := fromPi(); p != nil {
		return p.key
	}
	return ""
}

// LLM is a model to talk to and the options for every request (the key).
type LLM struct {
	Model         ai.Model
	StreamOptions ai.StreamOptions
}

var trailingV1 = regexp.MustCompile(`/v1/?$`)

// Deepseek is a DeepSeek model to talk to, and the key (given, else DEEPSEEK_API_KEY, else pi's): the model by id
// (id "", then VIBEVALLEY_AGENT_MODEL, then deepseek-flash).
func Deepseek(id, given string) (LLM, error) {
	// A key the host was given (vibevalley's settings) first, then the environment's, then pi's.
	key := given
	if key == "" {
		key = os.Getenv("DEEPSEEK_API_KEY")
	}
	var pi *piDeepseek
	if key == "" {
		pi = fromPi()
		if pi != nil {
			key = pi.key
		}
	}
	if key == "" {
		return LLM{}, ErrNoDeepSeekKey
	}
	name := id
	if name == "" {
		name = DefaultModelID()
	}
	model, known := ai.GetModel("deepseek", name)
	if !known {
		// A model this package does not list: DeepSeek's defaults, its own id.
		model, _ = ai.GetModel("deepseek", DEFAULT_MODEL)
		model.ID = name
		model.Name = name
	}
	baseURL := os.Getenv("DEEPSEEK_BASE_URL")
	if baseURL == "" && pi != nil {
		baseURL = pi.baseURL
	}
	if baseURL == "" {
		baseURL = "https://api.deepseek.com"
	}
	model.BaseURL = trailingV1.ReplaceAllString(baseURL, "")
	return LLM{Model: model, StreamOptions: ai.StreamOptions{APIKey: key}}, nil
}

// McpServer is an MCP server: a URL (Streamable HTTP) with headers, or a command (stdio).
type McpServer struct {
	Name    string
	URL     string
	Headers map[string]string
	Command string
	Args    []string
	Env     map[string]string
	Cwd     string
}

// ReadMcpConfig is the MCP servers in a config file's `mcpServers`; a file that is not there has none.
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
