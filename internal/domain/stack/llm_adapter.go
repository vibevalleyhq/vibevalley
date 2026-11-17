package stack

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/provider"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// SettingsLookup resolves fallback provider API keys and optional custom base URLs
// (for example from settings.json or app config) when Vault and env vars have none.
type SettingsLookup func(ctx context.Context, prov provider.ProviderKind) (apiKey, baseURL string, err error)

// ModelClientDeps configures the durable.ModelClient adapter backed by internal/provider.
type ModelClientDeps struct {
	Vault           *vault.Store
	Tokens          *vault.TokenService
	EgressTransport *vault.OutboundTransport
	HTTPClient      *http.Client
	Getenv          func(string) string
	SettingsLookup  SettingsLookup
	DefaultProvider provider.ProviderKind
	DefaultModel    string
	SystemPrompt    string
	StrictKeys      bool
	BaseURLs        map[provider.ProviderKind]string
}

type durableModelAdapter struct {
	deps   ModelClientDeps
	router *provider.Router
	getenv func(string) string
}

// NewModelClient constructs a durable.ModelClient backed by internal/provider's streaming Router.
// Credential resolution order: Vault -> environment variables -> optional SettingsLookup.
func NewModelClient(deps ModelClientDeps) durable.ModelClient {
	getenv := deps.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	if strings.TrimSpace(deps.DefaultModel) == "" {
		deps.DefaultModel = "deepseek-chat"
	}

	httpClient := deps.HTTPClient
	if httpClient == nil && deps.EgressTransport != nil {
		httpClient = &http.Client{
			Transport: &vaultEgressRoundTripper{
				transport: deps.EgressTransport,
				tokens:    deps.Tokens,
			},
		}
	}

	adapter := &durableModelAdapter{
		deps:   deps,
		getenv: getenv,
	}
	adapter.router = provider.NewRouter(provider.RouterConfig{
		HTTPClient:      httpClient,
		KeyResolver:     adapter.resolveKey,
		DefaultProvider: deps.DefaultProvider,
		DefaultModel:    deps.DefaultModel,
		Strict:          deps.StrictKeys,
	})
	return adapter
}

func (a *durableModelAdapter) resolveKey(ctx context.Context, prov provider.ProviderKind) (string, string, error) {
	var apiKey string
	var baseURL string

	if override, ok := a.deps.BaseURLs[prov]; ok && strings.TrimSpace(override) != "" {
		baseURL = strings.TrimSpace(override)
	}

	// 1. Vault lookup (provider_api_key matching provider name, credential name, or ID).
	if a.deps.Vault != nil {
		if k, err := lookupVaultProviderKey(ctx, a.deps.Vault, prov); err == nil && k != "" {
			apiKey = k
		}
	}

	// 2. Environment variable lookup.
	envKey, envBase := lookupEnvProviderKey(a.getenv, prov)
	if apiKey == "" && envKey != "" {
		apiKey = envKey
	}
	if baseURL == "" && envBase != "" {
		baseURL = envBase
	}

	// 3. Optional SettingsLookup fallback.
	if a.deps.SettingsLookup != nil && (apiKey == "" || baseURL == "") {
		sKey, sBase, err := a.deps.SettingsLookup(ctx, prov)
		if err != nil {
			return "", "", err
		}
		if apiKey == "" && strings.TrimSpace(sKey) != "" {
			apiKey = strings.TrimSpace(sKey)
		}
		if baseURL == "" && strings.TrimSpace(sBase) != "" {
			baseURL = strings.TrimSpace(sBase)
		}
	}

	return apiKey, baseURL, nil
}

func (a *durableModelAdapter) Generate(ctx context.Context, req durable.ModelRequest, onDelta func(chunk string)) (durable.ModelResponse, error) {
	prov, model := parseProviderAffinity(req.ProviderAffinity, a.deps.DefaultModel)
	sysPrompt, msgs := convertTranscriptToMessages(req.Transcript, a.deps.SystemPrompt)

	var tools []provider.ToolSpec
	mcpSet := make(map[string]bool, len(req.Tools))
	if !req.ReadOnly && len(req.Tools) > 0 {
		tools = make([]provider.ToolSpec, 0, len(req.Tools))
		for _, t := range req.Tools {
			mcpSet[t.Name] = t.IsMCP
			tools = append(tools, provider.ToolSpec{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
			})
		}
	}

	var streamed []string
	resp, err := a.router.Generate(ctx, provider.Request{
		Provider: prov,
		Model:    model,
		System:   sysPrompt,
		Messages: msgs,
		Tools:    tools,
		Strict:   a.deps.StrictKeys,
	}, func(d provider.StreamDelta) {
		if d.Text == "" {
			return
		}
		streamed = append(streamed, d.Text)
		if onDelta != nil {
			onDelta(d.Text)
		}
	})
	if err != nil {
		if errors.Is(err, provider.ErrContextOverflow) {
			return durable.ModelResponse{}, fmt.Errorf("%w: %v", durable.ErrContextOverflow, err)
		}
		return durable.ModelResponse{}, err
	}

	var toolCalls []durable.ToolCall
	if len(resp.ToolCalls) > 0 {
		toolCalls = make([]durable.ToolCall, 0, len(resp.ToolCalls))
		for _, tc := range resp.ToolCalls {
			toolCalls = append(toolCalls, durable.ToolCall{
				ID:       tc.ID,
				ToolName: tc.Name,
				IsMCP:    mcpSet[tc.Name],
				ArgsJSON: tc.Arguments,
			})
		}
	}

	var usage *contract.UsageTotals
	if resp.Usage != nil {
		usage = &contract.UsageTotals{
			InputTokens:      resp.Usage.InputTokens,
			OutputTokens:     resp.Usage.OutputTokens,
			CacheReadTokens:  resp.Usage.CacheReadTokens,
			CacheWriteTokens: resp.Usage.CacheWriteTokens,
			ReasoningTokens:  resp.Usage.ReasoningTokens,
			CostMicros:       resp.Usage.CostMicros,
		}
	}

	return durable.ModelResponse{
		Text:      resp.Text,
		ToolCalls: toolCalls,
		Usage:     usage,
		Streamed:  streamed,
	}, nil
}

func lookupVaultProviderKey(ctx context.Context, st *vault.Store, prov provider.ProviderKind) (string, error) {
	metas, err := st.ListMetadata(ctx)
	if err != nil {
		return "", err
	}
	target := strings.ToLower(string(prov))
	for _, m := range metas {
		if m.Kind != vault.KindProviderAPIKey {
			continue
		}
		if strings.EqualFold(m.Provider, target) ||
			strings.EqualFold(m.Name, target) ||
			strings.EqualFold(m.ID, target) ||
			strings.EqualFold(m.ID, "provider:"+target) ||
			strings.EqualFold(m.ID, "cred-"+target) {
			cred, gErr := st.Get(ctx, m.ID)
			if gErr != nil {
				continue
			}
			if v := strings.TrimSpace(cred.Value.Reveal()); v != "" {
				return v, nil
			}
		}
	}
	return "", nil
}

func lookupEnvProviderKey(getenv func(string) string, prov provider.ProviderKind) (apiKey, baseURL string) {
	switch prov {
	case provider.ProviderDeepSeek:
		return strings.TrimSpace(getenv("DEEPSEEK_API_KEY")), strings.TrimSpace(getenv("DEEPSEEK_BASE_URL"))
	case provider.ProviderAnthropic:
		return strings.TrimSpace(getenv("ANTHROPIC_API_KEY")), strings.TrimSpace(getenv("ANTHROPIC_BASE_URL"))
	case provider.ProviderOpenAI:
		return strings.TrimSpace(getenv("OPENAI_API_KEY")), strings.TrimSpace(getenv("OPENAI_BASE_URL"))
	case provider.ProviderCustom:
		key := strings.TrimSpace(getenv("CUSTOM_LLM_API_KEY"))
		if key == "" {
			key = strings.TrimSpace(getenv("OPENAI_API_KEY"))
		}
		base := strings.TrimSpace(getenv("CUSTOM_LLM_BASE_URL"))
		if base == "" {
			base = strings.TrimSpace(getenv("OPENAI_BASE_URL"))
		}
		return key, base
	default:
		return "", ""
	}
}

func parseProviderAffinity(affinity, fallbackModel string) (provider.ProviderKind, string) {
	trimmed := strings.TrimSpace(affinity)
	if trimmed == "" || strings.EqualFold(trimmed, "default") {
		p, m := provider.ResolveProvider("", fallbackModel)
		return p, m
	}

	if strings.Contains(trimmed, ":") {
		parts := strings.Split(trimmed, ":")
		candProv := provider.ProviderKind(strings.ToLower(strings.TrimSpace(parts[0])))
		var candModel string
		if len(parts) > 1 {
			candModel = strings.TrimSpace(parts[1])
		}
		if candProv.IsValid() {
			if candModel == "" {
				candModel = fallbackModel
			}
			return candProv, candModel
		}
	}

	p, m := provider.ResolveProvider("", trimmed)
	if p != "" {
		return p, m
	}
	if m != "" {
		return "", m
	}
	return provider.ResolveProvider("", fallbackModel)
}

func convertTranscriptToMessages(tr durable.Transcript, fallbackSystem string) (string, []provider.Message) {
	var sysParts []string
	var msgs []provider.Message
	seenTurn := false

	for _, entry := range tr.Entries {
		switch entry.Kind {
		case store.EntryReset:
			sysParts = nil
			msgs = nil
			seenTurn = false

		case store.EntrySystem:
			text := extractEntryText(entry.PayloadJSON)
			if text == "" {
				continue
			}
			if !seenTurn {
				sysParts = append(sysParts, text)
			} else {
				msgs = append(msgs, provider.Message{
					Role:    provider.RoleSystem,
					Content: text,
				})
			}

		case store.EntryCompaction:
			seenTurn = true
			var cp store.CompactionPayload
			if json.Unmarshal(entry.PayloadJSON, &cp) == nil && strings.TrimSpace(cp.Summary) != "" {
				msgs = append(msgs, provider.Message{
					Role:    provider.RoleUser,
					Content: "[对话历史摘要]\n" + cp.Summary,
				})
			} else if text := extractEntryText(entry.PayloadJSON); text != "" {
				msgs = append(msgs, provider.Message{
					Role:    provider.RoleUser,
					Content: text,
				})
			}

		case store.EntryUser:
			seenTurn = true
			text := extractUserEntryText(entry.PayloadJSON)
			if text != "" {
				msgs = append(msgs, provider.Message{
					Role:    provider.RoleUser,
					Content: text,
				})
			}

		case store.EntryAssistant:
			seenTurn = true
			var ap struct {
				Text      string             `json:"text"`
				Reasoning string             `json:"reasoning"`
				ToolCalls []durable.ToolCall `json:"toolCalls"`
			}
			if json.Unmarshal(entry.PayloadJSON, &ap) == nil {
				var tcs []provider.ToolCall
				for _, tc := range ap.ToolCalls {
					tcs = append(tcs, provider.ToolCall{
						ID:        tc.ID,
						Name:      tc.ToolName,
						Arguments: tc.ArgsJSON,
					})
				}
				msgs = append(msgs, provider.Message{
					Role:             provider.RoleAssistant,
					Content:          ap.Text,
					ReasoningContent: ap.Reasoning,
					ToolCalls:        tcs,
				})
			} else if text := extractEntryText(entry.PayloadJSON); text != "" {
				msgs = append(msgs, provider.Message{
					Role:    provider.RoleAssistant,
					Content: text,
				})
			}

		case store.EntryToolResult:
			seenTurn = true
			var tp struct {
				ToolCallID string          `json:"toolCallId"`
				ToolName   string          `json:"toolName"`
				OK         *bool           `json:"ok"`
				Output     json.RawMessage `json:"output"`
				Error      string          `json:"error"`
				Content    string          `json:"content"`
			}
			if json.Unmarshal(entry.PayloadJSON, &tp) == nil && (tp.ToolCallID != "" || tp.ToolName != "" || tp.OK != nil) {
				isErr := tp.OK != nil && !*tp.OK
				var content string
				if isErr {
					errMsg := tp.Error
					if errMsg == "" {
						errMsg = "tool execution failed"
					}
					b, _ := json.Marshal(map[string]any{
						"ok":    false,
						"error": errMsg,
					})
					content = string(b)
				} else if len(tp.Output) > 0 {
					content = string(tp.Output)
				} else if tp.Content != "" {
					content = tp.Content
				} else {
					content = "{}"
				}
				msgs = append(msgs, provider.Message{
					Role:       provider.RoleTool,
					ToolCallID: tp.ToolCallID,
					ToolName:   tp.ToolName,
					Content:    content,
					IsError:    isErr,
				})
			} else if text := extractEntryText(entry.PayloadJSON); text != "" {
				msgs = append(msgs, provider.Message{
					Role:    provider.RoleTool,
					Content: text,
				})
			}
		}
	}

	if len(sysParts) == 0 && strings.TrimSpace(fallbackSystem) != "" {
		sysParts = append(sysParts, fallbackSystem)
	}
	return strings.Join(sysParts, "\n\n"), msgs
}

func extractEntryText(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var asStr string
	if json.Unmarshal(raw, &asStr) == nil {
		return asStr
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		for _, k := range []string{"text", "prompt", "content", "message", "summary"} {
			if s, ok := obj[k].(string); ok && strings.TrimSpace(s) != "" {
				return s
			}
		}
	}
	return strings.TrimSpace(string(raw))
}

func extractUserEntryText(raw []byte) string {
	if len(raw) == 0 {
		return ""
	}
	var asStr string
	if json.Unmarshal(raw, &asStr) == nil {
		return asStr
	}
	var obj map[string]any
	if json.Unmarshal(raw, &obj) == nil {
		situation, _ := obj["situation"].(string)
		for _, k := range []string{"text", "prompt", "content", "message"} {
			if s, ok := obj[k].(string); ok && strings.TrimSpace(s) != "" {
				if strings.TrimSpace(situation) != "" {
					return strings.TrimSpace(situation) + "\n\n" + s
				}
				return s
			}
		}
	}
	return strings.TrimSpace(string(raw))
}

type vaultEgressRoundTripper struct {
	transport *vault.OutboundTransport
	tokens    *vault.TokenService
}

func (rt *vaultEgressRoundTripper) RoundTrip(req *http.Request) (*http.Response, error) {
	if rt.tokens != nil && req != nil && req.URL != nil {
		if _, hasTok := vault.CapabilityTokenFromContext(req.Context()); !hasTok {
			host := req.URL.Host
			if host == "" {
				host = req.URL.Hostname()
			}
			issued, err := rt.tokens.Issue(req.Context(), vault.IssueTokenRequest{
				PrincipalID:  "stack-model-client",
				SessionID:    "stack-model",
				Capabilities: []string{vault.CapProviderCall, vault.CapHTTPEgress},
				AllowedHosts: []string{host},
				TTL:          time.Minute,
			})
			if err != nil {
				return nil, err
			}
			ctx := vault.ContextWithSessionID(req.Context(), "stack-model")
			ctx = vault.ContextWithCapabilityToken(ctx, issued.Token.Reveal())
			req = req.Clone(ctx)
		}
	}
	return rt.transport.RoundTrip(req)
}
