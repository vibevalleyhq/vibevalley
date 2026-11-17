package provider

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// RouterConfig configures model routing, credential resolution, and HTTP transport.
type RouterConfig struct {
	HTTPClient      *http.Client
	KeyResolver     KeyResolver
	DefaultProvider ProviderKind
	DefaultModel    string
	Strict          bool
	CustomProtocol  string // "openai" (default) or "anthropic"
}

// Router dispatches Requests to OpenAI-compatible or Anthropic SSE clients based on
// explicit provider selection, model name prefix, and KeyResolver credentials.
type Router struct {
	cfg       RouterConfig
	openai    *OpenAIClient
	anthropic *AnthropicClient
}

// NewRouter constructs a Router with optional custom HTTP client and KeyResolver.
func NewRouter(cfg RouterConfig) *Router {
	httpClient := cfg.HTTPClient
	if httpClient == nil {
		httpClient = &http.Client{}
	}
	cfg.HTTPClient = httpClient
	return &Router{
		cfg:       cfg,
		openai:    NewOpenAIClient(WithOpenAIHTTPClient(httpClient)),
		anthropic: NewAnthropicClient(WithAnthropicHTTPClient(httpClient)),
	}
}

// ResolveProvider selects the target ProviderKind and normalized model name.
func ResolveProvider(explicit ProviderKind, model string) (ProviderKind, string) {
	trimmedModel := strings.TrimSpace(model)

	if prefix, rest, hasSlash := strings.Cut(trimmedModel, "/"); hasSlash {
		p := ProviderKind(strings.ToLower(strings.TrimSpace(prefix)))
		if p.IsValid() {
			if explicit == "" {
				explicit = p
			}
			if explicit == p && strings.TrimSpace(rest) != "" {
				trimmedModel = strings.TrimSpace(rest)
			}
		}
	}

	if explicit != "" {
		return explicit, trimmedModel
	}

	lower := strings.ToLower(trimmedModel)
	switch {
	case strings.HasPrefix(lower, "claude-") || lower == "claude":
		return ProviderAnthropic, trimmedModel
	case strings.HasPrefix(lower, "deepseek-") || lower == "deepseek":
		return ProviderDeepSeek, trimmedModel
	case strings.HasPrefix(lower, "gpt-") ||
		strings.HasPrefix(lower, "o1") ||
		strings.HasPrefix(lower, "o3") ||
		strings.HasPrefix(lower, "o4") ||
		strings.HasPrefix(lower, "chatgpt-"):
		return ProviderOpenAI, trimmedModel
	default:
		return "", trimmedModel
	}
}

// DefaultModelForProvider returns a sensible default model ID for kind.
func DefaultModelForProvider(kind ProviderKind) string {
	switch kind {
	case ProviderAnthropic:
		return "claude-sonnet-4-5"
	case ProviderOpenAI:
		return "gpt-4o"
	case ProviderDeepSeek:
		return "deepseek-chat"
	default:
		return "deepseek-chat"
	}
}

// Generate routes req to the resolved provider, checks credentials via KeyResolver, and streams deltas.
// When no API key is available, it returns either ErrMissingAPIKey (when strict) or a localized
// fallback Response without making any external network call.
func (r *Router) Generate(ctx context.Context, req Request, onDelta DeltaHandler) (Response, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return Response{}, err
	}

	prov, normModel := ResolveProvider(req.Provider, req.Model)
	if prov == "" {
		switch {
		case strings.TrimSpace(req.BaseURL) != "":
			prov = ProviderCustom
		case r.cfg.DefaultProvider.IsValid():
			prov = r.cfg.DefaultProvider
		case strings.TrimSpace(r.cfg.DefaultModel) != "":
			dp, dm := ResolveProvider("", r.cfg.DefaultModel)
			if dp != "" {
				prov = dp
			} else {
				prov = ProviderDeepSeek
			}
			if normModel == "" {
				normModel = dm
			}
		default:
			prov = ProviderDeepSeek
		}
	}
	if normModel == "" {
		if strings.TrimSpace(r.cfg.DefaultModel) != "" {
			_, dm := ResolveProvider("", r.cfg.DefaultModel)
			normModel = dm
		}
		if normModel == "" {
			normModel = DefaultModelForProvider(prov)
		}
	}

	apiKey := strings.TrimSpace(req.APIKey)
	baseURL := strings.TrimSpace(req.BaseURL)
	if r.cfg.KeyResolver != nil {
		resolvedKey, resolvedURL, err := r.cfg.KeyResolver(ctx, prov)
		if err != nil {
			return Response{}, err
		}
		if apiKey == "" {
			apiKey = strings.TrimSpace(resolvedKey)
		}
		if baseURL == "" {
			baseURL = strings.TrimSpace(resolvedURL)
		}
	}
	if baseURL == "" {
		baseURL = prov.DefaultBaseURL()
	}

	if apiKey == "" {
		strict := req.Strict || r.cfg.Strict
		msg := missingAPIKeyMessage(prov)
		if strict {
			return Response{}, &ConfigError{
				Provider: prov,
				Field:    "api_key",
				Message:  msg,
				Err:      ErrMissingAPIKey,
			}
		}
		if onDelta != nil {
			onDelta(StreamDelta{Text: msg})
		}
		return Response{
			Provider:     prov,
			Model:        normModel,
			Text:         msg,
			FinishReason: "stop",
			Fallback:     true,
		}, nil
	}

	if baseURL == "" {
		return Response{}, &ConfigError{
			Provider: prov,
			Field:    "base_url",
			Message:  fmt.Sprintf("provider %s requires a base URL", prov),
			Err:      ErrInvalidConfig,
		}
	}

	outReq := req
	outReq.Provider = prov
	outReq.Model = normModel
	outReq.APIKey = apiKey
	outReq.BaseURL = baseURL

	useAnthropic := prov == ProviderAnthropic ||
		(prov == ProviderCustom && strings.EqualFold(strings.TrimSpace(r.cfg.CustomProtocol), string(ProviderAnthropic)))

	if useAnthropic {
		return r.anthropic.Generate(ctx, outReq, onDelta)
	}
	return r.openai.Generate(ctx, outReq, onDelta)
}

func missingAPIKeyMessage(prov ProviderKind) string {
	switch prov {
	case ProviderAnthropic:
		return "还没有配置 Anthropic API Key（可设置环境变量 ANTHROPIC_API_KEY 或在设置里保存密钥），当前未发起外部模型请求。"
	case ProviderOpenAI:
		return "还没有配置 OpenAI API Key（可设置环境变量 OPENAI_API_KEY 或在设置里保存密钥），当前未发起外部模型请求。"
	case ProviderDeepSeek:
		return "还没有配置 DeepSeek API Key（可设置环境变量 DEEPSEEK_API_KEY 或在设置里保存密钥），当前未发起外部模型请求。"
	default:
		return fmt.Sprintf("还没有配置 %s 的 API Key（可设置对应环境变量或保存在密钥库），当前未发起外部模型请求。", prov)
	}
}
