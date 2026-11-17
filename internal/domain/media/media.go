package media

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"
)

var (
	// ErrVendorConfig indicates missing or malformed vendor endpoint configuration or request fields.
	ErrVendorConfig = errors.New("media: invalid vendor configuration")
	// ErrVendorRequest indicates an upstream HTTP error or transport failure from a media vendor.
	ErrVendorRequest = errors.New("media: vendor request failed")
	// ErrVendorResponse indicates an unreadable, empty, or malformed vendor response payload.
	ErrVendorResponse = errors.New("media: invalid vendor response")
)

// VendorConfig configures an OpenAI-compatible, DashScope, or MOSS HTTP media endpoint.
type VendorConfig struct {
	BaseURL    string            `json:"baseUrl"`
	APIKey     string            `json:"-"`
	Model      string            `json:"model,omitempty"`
	Voice      string            `json:"voice,omitempty"`
	Timeout    time.Duration     `json:"timeout,omitempty"`
	HTTPClient *http.Client      `json:"-"`
	Headers    map[string]string `json:"-"`
}

// VendorRunner executes image generation, multimodal understanding, and speech synthesis against
// OpenAI-compatible, DashScope, and MOSS HTTP endpoints.
type VendorRunner struct {
	Config     VendorConfig
	HTTPClient *http.Client
}

// NewVendorRunner constructs a VendorRunner from cfg.
func NewVendorRunner(cfg VendorConfig) *VendorRunner {
	return &VendorRunner{
		Config:     cfg,
		HTTPClient: cfg.HTTPClient,
	}
}

// ImageRequest configures a `POST /images/generations` request.
type ImageRequest struct {
	Prompt         string `json:"prompt"`
	Model          string `json:"model,omitempty"`
	Size           string `json:"size,omitempty"`
	Width          int    `json:"width,omitempty"`
	Height         int    `json:"height,omitempty"`
	N              int    `json:"n,omitempty"`
	Quality        string `json:"quality,omitempty"`
	Style          string `json:"style,omitempty"`
	ResponseFormat string `json:"response_format,omitempty"`
}

// ImageResult holds the generated image payload, resolved MIME type, and vendor metadata.
type ImageResult struct {
	Bytes         []byte        `json:"-"`
	MimeType      string        `json:"mimeType"`
	RevisedPrompt string        `json:"revisedPrompt,omitempty"`
	URL           string        `json:"url,omitempty"`
	Model         string        `json:"model,omitempty"`
	Duration      time.Duration `json:"duration"`
}

// MediaInputPart represents one multimodal content element for chat/completions understanding.
type MediaInputPart struct {
	Kind     string `json:"kind"` // "text", "image", "image_url", "audio", "input_audio"
	Text     string `json:"text,omitempty"`
	Data     []byte `json:"-"`
	MimeType string `json:"mimeType,omitempty"`
	URL      string `json:"url,omitempty"`
	Format   string `json:"format,omitempty"`
}

// UnderstandingRequest configures a multimodal `POST /chat/completions` request.
type UnderstandingRequest struct {
	Model       string           `json:"model,omitempty"`
	System      string           `json:"system,omitempty"`
	Prompt      string           `json:"prompt,omitempty"`
	Parts       []MediaInputPart `json:"parts,omitempty"`
	MaxTokens   int              `json:"maxTokens,omitempty"`
	Temperature *float64         `json:"temperature,omitempty"`
	Stream      *bool            `json:"stream,omitempty"`
}

// UnderstandingUsage captures token counts reported by the understanding endpoint.
type UnderstandingUsage struct {
	PromptTokens     int `json:"promptTokens"`
	CompletionTokens int `json:"completionTokens"`
	TotalTokens      int `json:"totalTokens"`
}

// UnderstandingResult returns the assembled understanding text, token usage, and elapsed time.
type UnderstandingResult struct {
	Text         string             `json:"text"`
	Model        string             `json:"model,omitempty"`
	FinishReason string             `json:"finishReason,omitempty"`
	Usage        UnderstandingUsage `json:"usage,omitempty"`
	Duration     time.Duration      `json:"duration"`
}

// SpeechRequest configures a `POST /audio/speech` text-to-speech synthesis request.
type SpeechRequest struct {
	Input          string  `json:"input"`
	Text           string  `json:"text,omitempty"`
	Model          string  `json:"model,omitempty"`
	Voice          string  `json:"voice,omitempty"`
	ResponseFormat string  `json:"response_format,omitempty"`
	Speed          float64 `json:"speed,omitempty"`
}

// SpeechResult returns synthesized audio bytes, resolved MIME type, format, and elapsed time.
type SpeechResult struct {
	Bytes    []byte        `json:"-"`
	MimeType string        `json:"mimeType"`
	Format   string        `json:"format"`
	Duration time.Duration `json:"duration"`
}

func (r *VendorRunner) httpClient() *http.Client {
	if r.HTTPClient != nil {
		return r.HTTPClient
	}
	if r.Config.HTTPClient != nil {
		return r.Config.HTTPClient
	}
	return http.DefaultClient
}

func (r *VendorRunner) withTimeout(ctx context.Context) (context.Context, context.CancelFunc) {
	if ctx == nil {
		ctx = context.Background()
	}
	if r.Config.Timeout > 0 {
		return context.WithTimeout(ctx, r.Config.Timeout)
	}
	return ctx, func() {}
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if s := strings.TrimSpace(v); s != "" {
			return s
		}
	}
	return ""
}
