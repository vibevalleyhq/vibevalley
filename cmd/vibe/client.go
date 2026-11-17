package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	"github.com/vibevalleyhq/vibevalley/internal/config"
)

const (
	defaultServerURL = "http://127.0.0.1:8787"
	maxRPCBodyBytes  = 16 << 20
)

// ServerReadyInfo represents the server.json discovery file written by VibeValley servers.
type ServerReadyInfo struct {
	URL  string `json:"url"`
	Addr string `json:"addr,omitempty"`
	PID  int    `json:"pid,omitempty"`
}

// CLIAuthState represents the persisted CLI bearer token file ($VIBEVALLEY_HOME/cli-auth.json).
type CLIAuthState struct {
	Server string `json:"server,omitempty"`
	Token  string `json:"token,omitempty"`
	Key    string `json:"key,omitempty"`
	Device string `json:"device,omitempty"`
	User   string `json:"user,omitempty"`
}

// RPCNextStep describes a suggested follow-up command returned in an API error envelope.
type RPCNextStep struct {
	Say string   `json:"say"`
	Run []string `json:"run,omitempty"`
}

// RPCErrorDetail holds optional remediation hints in an API error envelope.
type RPCErrorDetail struct {
	Next     []RPCNextStep `json:"next,omitempty"`
	Settings string        `json:"settings,omitempty"`
}

// RPCEnvelope is the standard VibeValley /api/v1/* wire response envelope.
type RPCEnvelope struct {
	BizCode int             `json:"bizCode"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
	Error   *RPCErrorDetail `json:"error,omitempty"`
}

// APIError represents a structured non-zero bizCode or HTTP refusal from the control plane.
type APIError struct {
	Op          string
	HTTPStatus  int
	BizCode     int
	Message     string
	ErrorDetail *RPCErrorDetail
}

func (e *APIError) Error() string {
	var b strings.Builder
	if e.Op != "" {
		b.WriteString(e.Op)
		b.WriteString(": ")
	}
	if e.BizCode != 0 {
		fmt.Fprintf(&b, "[bizCode %d", e.BizCode)
		if e.HTTPStatus != 0 {
			fmt.Fprintf(&b, " / HTTP %d", e.HTTPStatus)
		}
		b.WriteString("] ")
	} else if e.HTTPStatus != 0 {
		fmt.Fprintf(&b, "[HTTP %d] ", e.HTTPStatus)
	}
	if e.Message != "" {
		b.WriteString(e.Message)
	} else {
		b.WriteString("request failed")
	}
	if e.ErrorDetail != nil && len(e.ErrorDetail.Next) > 0 {
		b.WriteString(" (next: ")
		for i, step := range e.ErrorDetail.Next {
			if i > 0 {
				b.WriteString("; ")
			}
			b.WriteString(step.Say)
			if len(step.Run) > 0 {
				b.WriteString(" -> vibe ")
				b.WriteString(strings.Join(step.Run, " "))
			}
		}
		b.WriteString(")")
	}
	return b.String()
}

func (e *APIError) isNotFound() bool {
	return e.HTTPStatus == http.StatusNotFound || e.BizCode == 100005
}

// Client invokes VibeValley HTTP RPC and OpenAI-compatible chat endpoints.
type Client struct {
	BaseURL string
	Token   string
	HTTP    *http.Client
}

func normalizeBaseURL(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimRight(trimmed, "/")
	if trimmed == "" {
		return defaultServerURL
	}
	if !strings.Contains(trimmed, "://") {
		trimmed = "http://" + trimmed
	}
	return trimmed
}

func originOf(raw string) string {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Scheme == "" || u.Host == "" {
		return strings.TrimRight(strings.TrimSpace(raw), "/")
	}
	return strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host)
}

func serverJSONPath(homeDir string) string {
	return filepath.Join(homeDir, "server.json")
}

func cliAuthPath(homeDir string) string {
	return filepath.Join(homeDir, "cli-auth.json")
}

func readServerJSON(homeDir string) (ServerReadyInfo, bool, error) {
	if strings.TrimSpace(homeDir) == "" {
		return ServerReadyInfo{}, false, nil
	}
	data, err := os.ReadFile(serverJSONPath(homeDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return ServerReadyInfo{}, false, nil
		}
		return ServerReadyInfo{}, false, err
	}
	var info ServerReadyInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return ServerReadyInfo{}, true, err
	}
	if strings.TrimSpace(info.URL) == "" && strings.TrimSpace(info.Addr) != "" {
		info.URL = normalizeBaseURL(info.Addr)
	}
	return info, true, nil
}

func readCLIAuth(homeDir string) (CLIAuthState, bool, error) {
	if strings.TrimSpace(homeDir) == "" {
		return CLIAuthState{}, false, nil
	}
	data, err := os.ReadFile(cliAuthPath(homeDir))
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return CLIAuthState{}, false, nil
		}
		return CLIAuthState{}, false, err
	}
	var st CLIAuthState
	if err := json.Unmarshal(data, &st); err != nil {
		return CLIAuthState{}, true, err
	}
	if strings.TrimSpace(st.Token) == "" {
		st.Token = st.Key
	}
	return st, true, nil
}

func writeCLIAuth(homeDir string, st CLIAuthState) error {
	if strings.TrimSpace(homeDir) == "" {
		return errors.New("cannot persist cli-auth.json: empty home directory")
	}
	if err := os.MkdirAll(homeDir, 0o700); err != nil {
		return err
	}
	if st.Token != "" && st.Key == "" {
		st.Key = st.Token
	}
	if st.Key != "" && st.Token == "" {
		st.Token = st.Key
	}
	data, err := json.MarshalIndent(st, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	tmp := cliAuthPath(homeDir) + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, cliAuthPath(homeDir))
}

func removeCLIAuth(homeDir string) error {
	if strings.TrimSpace(homeDir) == "" {
		return nil
	}
	err := os.Remove(cliAuthPath(homeDir))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	return err
}

// discoverServerURL resolves the control-plane URL using:
// --server flag -> VIBEVALLEY_SERVER_URL -> $VIBEVALLEY_HOME/server.json -> http://127.0.0.1:8787.
func discoverServerURL(flagVal string, getenv func(string) string, homeDir string, cfg *config.AppConfig) (string, string) {
	if v := strings.TrimSpace(flagVal); v != "" {
		return normalizeBaseURL(v), "flag"
	}
	if getenv != nil {
		if v := strings.TrimSpace(getenv("VIBEVALLEY_SERVER_URL")); v != "" {
			return normalizeBaseURL(v), "VIBEVALLEY_SERVER_URL"
		}
		if v := strings.TrimSpace(getenv("VIBEVALLEY_SERVER")); v != "" {
			return normalizeBaseURL(v), "VIBEVALLEY_SERVER"
		}
	}
	if info, ok, err := readServerJSON(homeDir); ok && err == nil && strings.TrimSpace(info.URL) != "" {
		return normalizeBaseURL(info.URL), "server.json"
	}
	if cfg != nil {
		if v := strings.TrimSpace(cfg.Desktop.ServerURL); v != "" {
			return normalizeBaseURL(v), "config"
		}
		if v := strings.TrimSpace(cfg.Machine.ServerURL); v != "" {
			return normalizeBaseURL(v), "config"
		}
	}
	return defaultServerURL, "default"
}

// discoverToken resolves the bearer token using:
// --token flag -> VIBEVALLEY_TOKEN -> $VIBEVALLEY_HOME/cli-auth.json.
func discoverToken(flagVal string, getenv func(string) string, homeDir, serverURL string) (string, string) {
	if v := strings.TrimSpace(flagVal); v != "" {
		return v, "flag"
	}
	if getenv != nil {
		if v := strings.TrimSpace(getenv("VIBEVALLEY_TOKEN")); v != "" {
			return v, "VIBEVALLEY_TOKEN"
		}
	}
	if st, ok, err := readCLIAuth(homeDir); ok && err == nil && strings.TrimSpace(st.Token) != "" {
		if st.Server == "" || originOf(st.Server) == originOf(serverURL) {
			return strings.TrimSpace(st.Token), "cli-auth.json"
		}
	}
	return "", "none"
}

func (c *Client) http() *http.Client {
	if c.HTTP != nil {
		return c.HTTP
	}
	return http.DefaultClient
}

func opPath(op string) string {
	return "/api/v1/" + strings.ReplaceAll(strings.TrimPrefix(op, "/"), ".", "/")
}

// CallRaw sends POST /api/v1/<op> and decodes the {"bizCode":0,"message":"ok","data":...} envelope.
func (c *Client) CallRaw(ctx context.Context, op string, reqBody any) (json.RawMessage, error) {
	var bodyReader io.Reader
	if reqBody != nil {
		encoded, err := json.Marshal(reqBody)
		if err != nil {
			return nil, fmt.Errorf("%s: encode request: %w", op, err)
		}
		bodyReader = bytes.NewReader(encoded)
	}
	endpoint := strings.TrimRight(normalizeBaseURL(c.BaseURL), "/") + opPath(op)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bodyReader)
	if err != nil {
		return nil, fmt.Errorf("%s: build request: %w", op, err)
	}
	req.Header.Set("Accept", "application/json")
	if reqBody != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	resp, err := c.http().Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s: request %s: %w", op, endpoint, err)
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRPCBodyBytes))
	if err != nil {
		return nil, fmt.Errorf("%s: read response: %w", op, err)
	}

	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) > 0 {
		var env RPCEnvelope
		if jErr := json.Unmarshal(trimmed, &env); jErr == nil {
			if env.BizCode != 0 {
				return nil, &APIError{
					Op:          op,
					HTTPStatus:  resp.StatusCode,
					BizCode:     env.BizCode,
					Message:     env.Message,
					ErrorDetail: env.Error,
				}
			}
			if resp.StatusCode >= 400 {
				msg := env.Message
				if msg == "" {
					msg = resp.Status
				}
				return nil, &APIError{
					Op:         op,
					HTTPStatus: resp.StatusCode,
					Message:    msg,
				}
			}
			return env.Data, nil
		}
	}

	if resp.StatusCode >= 400 {
		msg := strings.TrimSpace(string(trimmed))
		if msg == "" {
			msg = resp.Status
		}
		return nil, &APIError{
			Op:         op,
			HTTPStatus: resp.StatusCode,
			Message:    msg,
		}
	}
	if len(trimmed) == 0 {
		return nil, nil
	}
	return nil, fmt.Errorf("%s: invalid JSON response from %s", op, endpoint)
}

// Call invokes POST /api/v1/<op> and unmarshals data into dst (when non-nil).
func (c *Client) Call(ctx context.Context, op string, reqBody any, dst any) (json.RawMessage, error) {
	raw, err := c.CallRaw(ctx, op, reqBody)
	if err != nil {
		return nil, err
	}
	if dst != nil && len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, dst); err != nil {
			return nil, fmt.Errorf("%s: decode response data: %w", op, err)
		}
	}
	return raw, nil
}

// CallWithFallback invokes primaryOp, falling back to fallbackOp only when primaryOp returns 404/RouteNotFound.
func (c *Client) CallWithFallback(ctx context.Context, primaryOp, fallbackOp string, primaryBody, fallbackBody, dst any) (json.RawMessage, error) {
	raw, err := c.Call(ctx, primaryOp, primaryBody, dst)
	if err == nil {
		return raw, nil
	}
	var apiErr *APIError
	if fallbackOp != "" && errors.As(err, &apiErr) && apiErr.isNotFound() {
		return c.Call(ctx, fallbackOp, fallbackBody, dst)
	}
	return nil, err
}

// Healthz checks GET /healthz and falls back to POST /api/v1/server/health/get if /healthz is 404.
func (c *Client) Healthz(ctx context.Context) (json.RawMessage, error) {
	base := strings.TrimRight(normalizeBaseURL(c.BaseURL), "/")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, base+"/healthz", nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	resp, err := c.http().Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	if resp.StatusCode == http.StatusNotFound {
		return c.CallRaw(ctx, "server.health.get", nil)
	}
	if resp.StatusCode >= 400 {
		return nil, &APIError{
			Op:         "healthz",
			HTTPStatus: resp.StatusCode,
			Message:    strings.TrimSpace(string(raw)),
		}
	}
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return json.RawMessage(`{"ok":true}`), nil
	}
	return json.RawMessage(trimmed), nil
}

// ChatCompletionMessage represents a message in /v1/chat/completions requests.
type ChatCompletionMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// ChatCompletionRequest configures a /v1/chat/completions call.
type ChatCompletionRequest struct {
	Model    string                  `json:"model,omitempty"`
	Stream   bool                    `json:"stream"`
	Messages []ChatCompletionMessage `json:"messages"`
}

func (c *Client) chatHTTPClient() *http.Client {
	if c.HTTP != nil && c.HTTP.Transport != nil {
		return &http.Client{Transport: c.HTTP.Transport}
	}
	return &http.Client{}
}

// ChatCompletions invokes POST /v1/chat/completions in non-streaming mode.
func (c *Client) ChatCompletions(ctx context.Context, reqBody ChatCompletionRequest) (string, json.RawMessage, error) {
	reqBody.Stream = false
	encoded, err := json.Marshal(reqBody)
	if err != nil {
		return "", nil, err
	}
	endpoint := strings.TrimRight(normalizeBaseURL(c.BaseURL), "/") + "/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return "", nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	resp, err := c.http().Do(req)
	if err != nil {
		return "", nil, err
	}
	defer resp.Body.Close()

	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxRPCBodyBytes))
	if err != nil {
		return "", nil, err
	}
	if resp.StatusCode >= 400 {
		return "", nil, formatChatHTTPError(resp.StatusCode, raw)
	}
	var parsed struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", nil, fmt.Errorf("chat/completions: decode response: %w", err)
	}
	var text string
	if len(parsed.Choices) > 0 {
		text = parsed.Choices[0].Message.Content
	}
	return text, json.RawMessage(bytes.TrimSpace(raw)), nil
}

// StreamChatCompletions invokes POST /v1/chat/completions with stream=true and emits SSE content deltas.
func (c *Client) StreamChatCompletions(ctx context.Context, reqBody ChatCompletionRequest, onDelta func(string) error) (string, error) {
	reqBody.Stream = true
	encoded, err := json.Marshal(reqBody)
	if err != nil {
		return "", err
	}
	endpoint := strings.TrimRight(normalizeBaseURL(c.BaseURL), "/") + "/v1/chat/completions"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(encoded))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream")
	if c.Token != "" {
		req.Header.Set("Authorization", "Bearer "+c.Token)
	}

	resp, err := c.chatHTTPClient().Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		return "", formatChatHTTPError(resp.StatusCode, raw)
	}

	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)
	var full strings.Builder
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, ":") {
			continue
		}
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" {
			continue
		}
		if payload == "[DONE]" {
			break
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
			Error *struct {
				Message string `json:"message"`
			} `json:"error,omitempty"`
		}
		if err := json.Unmarshal([]byte(payload), &chunk); err != nil {
			continue
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			return full.String(), errors.New(chunk.Error.Message)
		}
		if len(chunk.Choices) > 0 && chunk.Choices[0].Delta.Content != "" {
			delta := chunk.Choices[0].Delta.Content
			full.WriteString(delta)
			if onDelta != nil {
				if err := onDelta(delta); err != nil {
					return full.String(), err
				}
			}
		}
	}
	if err := scanner.Err(); err != nil {
		return full.String(), err
	}
	return full.String(), nil
}

func formatChatHTTPError(status int, raw []byte) error {
	var apiErrEnv RPCEnvelope
	if json.Unmarshal(raw, &apiErrEnv) == nil && apiErrEnv.BizCode != 0 {
		return &APIError{
			Op:          "chat.completions",
			HTTPStatus:  status,
			BizCode:     apiErrEnv.BizCode,
			Message:     apiErrEnv.Message,
			ErrorDetail: apiErrEnv.Error,
		}
	}
	var openAIErr struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(raw, &openAIErr) == nil && openAIErr.Error.Message != "" {
		return &APIError{
			Op:         "chat.completions",
			HTTPStatus: status,
			Message:    openAIErr.Error.Message,
		}
	}
	return &APIError{
		Op:         "chat.completions",
		HTTPStatus: status,
		Message:    strings.TrimSpace(string(raw)),
	}
}
