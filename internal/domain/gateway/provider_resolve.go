package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/connector"
	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
	"github.com/vibevalleyhq/vibevalley/internal/domain/setting"
	"github.com/vibevalleyhq/vibevalley/internal/domain/voice"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	defaultOpenAIBaseURL       = "https://api.openai.com/v1"
	defaultMOSSBaseURL         = "https://api.mosi.cn/v1"
	defaultMOSSRealtimeWSURL   = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0"
	defaultOpenAIRealtimeWSURL = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview"
)

type settingsProviderFile struct {
	Providers *struct {
		Revision    int `json:"revision"`
		Connections []struct {
			ID      string `json:"id"`
			Name    string `json:"name"`
			Adapter string `json:"adapter"`
			Enabled bool   `json:"enabled"`
			Key     string `json:"key"`
			BaseURL string `json:"baseUrl,omitempty"`
		} `json:"connections"`
		Image         *setting.ProviderBinding `json:"image"`
		Speech        *setting.ProviderBinding `json:"speech"`
		Understanding *setting.ProviderBinding `json:"understanding"`
		Live          *setting.ProviderBinding `json:"live"`
		Vision        *setting.ProviderBinding `json:"vision"`
	} `json:"providers"`
}

type resolvedMediaConfig struct {
	cfg        media.VendorConfig
	connection string
	adapter    string
	revision   int
}

func defaultBaseURLForAdapter(adapter string) string {
	switch strings.ToLower(strings.TrimSpace(adapter)) {
	case "moss":
		return firstNonEmpty(os.Getenv("MOSS_BASE_URL"), defaultMOSSBaseURL)
	default:
		return firstNonEmpty(os.Getenv("OPENAI_BASE_URL"), defaultOpenAIBaseURL)
	}
}

func (h *Handler) loadSettingsProvidersFile() *settingsProviderFile {
	if h == nil || h.st == nil || h.st.Setting == nil {
		return nil
	}
	fp := strings.TrimSpace(h.st.Setting.FilePath())
	if fp == "" {
		return nil
	}
	raw, err := os.ReadFile(fp)
	if err != nil {
		return nil
	}
	var parsed settingsProviderFile
	if json.Unmarshal(raw, &parsed) != nil {
		return nil
	}
	return &parsed
}

func (h *Handler) resolveMediaVendor(use, connID, modelOverride string) (*media.VendorRunner, resolvedMediaConfig, bool) {
	if h == nil {
		return nil, resolvedMediaConfig{}, false
	}
	if h.mediaRunner != nil {
		cfg := h.mediaRunner.Config
		if modelOverride != "" {
			cfg.Model = modelOverride
		}
		return h.mediaRunner, resolvedMediaConfig{
			cfg:        cfg,
			connection: firstNonEmpty(connID, "configured"),
			adapter:    "custom",
		}, true
	}
	if cfg, ok := h.mediaConfigs[use]; ok && strings.TrimSpace(cfg.BaseURL) != "" {
		if modelOverride != "" {
			cfg.Model = modelOverride
		}
		return media.NewVendorRunner(cfg), resolvedMediaConfig{
			cfg:        cfg,
			connection: firstNonEmpty(connID, "configured"),
			adapter:    "custom",
		}, true
	}

	if parsed := h.loadSettingsProvidersFile(); parsed != nil && parsed.Providers != nil {
		var binding *setting.ProviderBinding
		switch use {
		case "image":
			binding = parsed.Providers.Image
		case "speech":
			binding = parsed.Providers.Speech
		case "understanding":
			binding = parsed.Providers.Understanding
		case "live":
			binding = parsed.Providers.Live
		case "vision":
			binding = parsed.Providers.Vision
		}
		targetConn := strings.TrimSpace(connID)
		if targetConn == "" && binding != nil {
			targetConn = binding.Connection
		}
		model := strings.TrimSpace(modelOverride)
		if model == "" && binding != nil {
			model = binding.Model
		}
		for _, c := range parsed.Providers.Connections {
			if !c.Enabled || strings.TrimSpace(c.Key) == "" {
				continue
			}
			if targetConn != "" && c.ID != targetConn {
				continue
			}
			base := firstNonEmpty(
				strings.TrimSpace(c.BaseURL),
				strings.TrimSpace(os.Getenv("VIBEVALLEY_MEDIA_BASE_URL")),
				defaultBaseURLForAdapter(c.Adapter),
			)
			cfg := media.VendorConfig{
				BaseURL: base,
				APIKey:  c.Key,
				Model:   model,
			}
			return media.NewVendorRunner(cfg), resolvedMediaConfig{
				cfg:        cfg,
				connection: c.ID,
				adapter:    c.Adapter,
				revision:   parsed.Providers.Revision,
			}, true
		}
	}

	// Check env or ResolveAPIKey fallback.
	var key, adapter, base string
	if h.st != nil && h.st.Setting != nil {
		if k, _, ok := h.st.Setting.ResolveAPIKey("openai"); ok && strings.TrimSpace(k) != "" {
			key = k
			adapter = "openai"
		}
	}
	if key == "" {
		if k := strings.TrimSpace(os.Getenv("VIBEVALLEY_MEDIA_API_KEY")); k != "" {
			key = k
			adapter = "openai"
		} else if k := strings.TrimSpace(os.Getenv("MOSS_API_KEY")); k != "" {
			key = k
			adapter = "moss"
		}
	}
	if key != "" {
		base = firstNonEmpty(
			strings.TrimSpace(os.Getenv("VIBEVALLEY_MEDIA_BASE_URL")),
			defaultBaseURLForAdapter(adapter),
		)
		cfg := media.VendorConfig{
			BaseURL: base,
			APIKey:  key,
			Model:   strings.TrimSpace(modelOverride),
		}
		return media.NewVendorRunner(cfg), resolvedMediaConfig{
			cfg:        cfg,
			connection: adapter,
			adapter:    adapter,
		}, true
	}

	return nil, resolvedMediaConfig{}, false
}

func httpBaseToWSRealtime(baseURL, model string) string {
	trimmed := strings.TrimRight(strings.TrimSpace(baseURL), "/")
	if trimmed == "" {
		return ""
	}
	wsBase := trimmed
	switch {
	case strings.HasPrefix(trimmed, "https://"):
		wsBase = "wss://" + strings.TrimPrefix(trimmed, "https://")
	case strings.HasPrefix(trimmed, "http://"):
		wsBase = "ws://" + strings.TrimPrefix(trimmed, "http://")
	}
	u, err := url.Parse(wsBase)
	if err != nil {
		return ""
	}
	if !strings.HasSuffix(u.Path, "/realtime") {
		u.Path = strings.TrimRight(u.Path, "/") + "/realtime"
	}
	if model != "" {
		q := u.Query()
		if q.Get("model") == "" {
			q.Set("model", model)
			u.RawQuery = q.Encode()
		}
	}
	return u.String()
}

func (h *Handler) resolveRealtimeRelayConfig(kind string) (voice.RelayConfig, bool) {
	if h == nil {
		return voice.RelayConfig{}, false
	}
	if cfg, ok := h.realtimeConfigs[kind]; ok && strings.TrimSpace(cfg.UpstreamURL) != "" {
		return cfg, true
	}
	if kind != "live" {
		if cfg, ok := h.realtimeConfigs["live"]; ok && strings.TrimSpace(cfg.UpstreamURL) != "" {
			return cfg, true
		}
	}

	if parsed := h.loadSettingsProvidersFile(); parsed != nil && parsed.Providers != nil {
		binding := parsed.Providers.Live
		if kind == "vision" {
			binding = parsed.Providers.Vision
		}
		if binding != nil {
			for _, c := range parsed.Providers.Connections {
				if c.ID == binding.Connection && c.Enabled && strings.TrimSpace(c.Key) != "" {
					wsURL := strings.TrimSpace(os.Getenv("VIBEVALLEY_VOICE_REALTIME_URL"))
					if kind == "vision" {
						wsURL = firstNonEmpty(strings.TrimSpace(os.Getenv("VIBEVALLEY_VISION_REALTIME_URL")), wsURL)
					}
					if wsURL == "" && strings.TrimSpace(c.BaseURL) != "" {
						wsURL = httpBaseToWSRealtime(c.BaseURL, binding.Model)
					}
					if wsURL == "" {
						if strings.EqualFold(c.Adapter, "openai") {
							wsURL = defaultOpenAIRealtimeWSURL
						} else {
							wsURL = defaultMOSSRealtimeWSURL
						}
					}
					return voice.RelayConfig{
						UpstreamURL: wsURL,
						APIKey:      c.Key,
					}, true
				}
			}
		}
	}

	if wsURL := strings.TrimSpace(os.Getenv("VIBEVALLEY_VOICE_REALTIME_URL")); wsURL != "" {
		key := firstNonEmpty(os.Getenv("MOSS_API_KEY"), os.Getenv("OPENAI_API_KEY"), os.Getenv("VIBEVALLEY_OPENAI_API_KEY"))
		if key != "" {
			return voice.RelayConfig{UpstreamURL: wsURL, APIKey: key}, true
		}
	}
	if mossKey := strings.TrimSpace(os.Getenv("MOSS_API_KEY")); mossKey != "" {
		wsURL := firstNonEmpty(strings.TrimSpace(os.Getenv("MOSS_REALTIME_URL")), defaultMOSSRealtimeWSURL)
		return voice.RelayConfig{UpstreamURL: wsURL, APIKey: mossKey}, true
	}
	if h.st != nil && h.st.Setting != nil {
		if k, _, ok := h.st.Setting.ResolveAPIKey("openai"); ok && strings.TrimSpace(k) != "" {
			wsURL := defaultOpenAIRealtimeWSURL
			if base := strings.TrimSpace(os.Getenv("OPENAI_BASE_URL")); base != "" {
				wsURL = httpBaseToWSRealtime(base, "gpt-4o-realtime-preview")
			}
			return voice.RelayConfig{UpstreamURL: wsURL, APIKey: k}, true
		}
	}
	return voice.RelayConfig{}, false
}

func (h *Handler) handleVoiceRealtimeWS(w http.ResponseWriter, r *http.Request, kind string) {
	if offlineMediaEnabled() {
		h.handleOfflineVoiceWS(w, r, kind)
		return
	}
	if !isTrustedVoiceOrigin(r) {
		writePlainError(w, http.StatusForbidden, "not the farm's page")
		return
	}
	if cfg, ok := h.resolveRealtimeRelayConfig(kind); ok {
		_ = voice.ServeRealtimeWS(w, r, cfg)
		return
	}
	if kind == "live" && h.st != nil && h.st.Voice != nil {
		_ = h.st.Voice.ServeMOSSRelay(w, r)
		return
	}
	writePlainError(w, http.StatusConflict, "realtime upstream credentials are not configured")
}

func (h *Handler) mediaInputBytes(rec *mediaInputRecord) []byte {
	if rec == nil {
		return nil
	}
	if len(rec.Bytes) > 0 {
		return rec.Bytes
	}
	if rec.BlobPath != "" && h.hub != nil && h.hub.sqlStore != nil {
		if data, err := h.hub.sqlStore.readMediaBlob(rec.BlobPath); err == nil {
			return data
		}
	}
	return nil
}

func (h *Handler) runLiveImageCreate(ctx context.Context, req struct {
	ID             string   `json:"id"`
	Prompt         string   `json:"prompt"`
	Format         string   `json:"format"`
	Width          int      `json:"width"`
	Height         int      `json:"height"`
	Seed           *int     `json:"seed"`
	Steps          *int     `json:"steps"`
	Guidance       *float64 `json:"guidance"`
	NegativePrompt string   `json:"negativePrompt"`
	Enhance        bool     `json:"enhance"`
	Watermark      bool     `json:"watermark"`
}) (json.RawMessage, bool, error) {
	runner, resolved, ok := h.resolveMediaVendor("image", "", "")
	if !ok || runner == nil {
		return nil, false, nil
	}
	size := ""
	if req.Width > 0 && req.Height > 0 {
		size = fmt.Sprintf("%dx%d", req.Width, req.Height)
	}
	res, err := runner.GenerateImage(ctx, media.ImageRequest{
		Prompt:         req.Prompt,
		Model:          resolved.cfg.Model,
		Size:           size,
		Width:          req.Width,
		Height:         req.Height,
		ResponseFormat: firstNonEmpty(req.Format, "b64_json"),
	})
	if err != nil {
		return nil, true, newBizError(BizMediaRefused, err.Error())
	}
	ext := "png"
	if strings.Contains(res.MimeType, "jpeg") || strings.Contains(res.MimeType, "jpg") {
		ext = "jpg"
	} else if strings.Contains(res.MimeType, "webp") {
		ext = "webp"
	}
	att, aErr := h.st.Attachments.PutBytes(ctx, req.ID+"."+ext, firstNonEmpty(res.MimeType, "image/png"), res.Bytes)
	if aErr != nil {
		return nil, true, aErr
	}
	now := h.hub.nowMs()
	job := map[string]any{
		"kind":             "image",
		"id":               req.ID,
		"prompt":           req.Prompt,
		"model":            firstNonEmpty(res.Model, resolved.cfg.Model, "gpt-image-1"),
		"connection":       resolved.connection,
		"revision":         resolved.revision,
		"source":           map[string]any{"kind": "user"},
		"phase":            "ready",
		"phaseText":        "Ready",
		"problem":          "",
		"canCancel":        false,
		"canRetryDownload": false,
		"attachment":       att,
		"resultInput":      h.registerResultMediaInput("image", req.ID+"."+ext, firstNonEmpty(res.MimeType, "image/png"), res.Bytes),
		"usage": map[string]any{
			"images": 1,
			"width":  req.Width,
			"height": req.Height,
		},
		"createdAt": now,
		"updatedAt": now,
	}
	h.addGeneratedLibraryItem(ctx, att.ID, req.ID, "image")
	raw, err := h.saveMediaJob("image", job)
	return raw, true, err
}

func (h *Handler) runLiveUnderstandingSubmit(ctx context.Context, req struct {
	ID              string   `json:"id"`
	Prompt          string   `json:"prompt"`
	Inputs          []string `json:"inputs"`
	Connection      string   `json:"connection"`
	Revision        int      `json:"revision"`
	AllowUpload     bool     `json:"allowUpload"`
	MaxOutputTokens int      `json:"maxOutputTokens"`
	Channel         string   `json:"channel"`
}, authorizeOnly bool) (json.RawMessage, bool, error) {
	runner, resolved, ok := h.resolveMediaVendor("understanding", req.Connection, "")
	if !ok || runner == nil {
		return nil, false, nil
	}
	h.hub.mu.RLock()
	inputRefs := make([]map[string]any, 0, len(req.Inputs))
	parts := make([]media.MediaInputPart, 0, len(req.Inputs))
	for _, inID := range req.Inputs {
		rec := h.hub.state.MediaInputs[inID]
		if rec == nil || rec.Hash == nil {
			h.hub.mu.RUnlock()
			return nil, true, newBizError(BizMediaRefused, "media input not found or not ready")
		}
		rawBytes := h.mediaInputBytes(rec)
		kind := rec.Kind
		if kind == "" {
			if strings.HasPrefix(rec.Mime, "audio/") {
				kind = "audio"
			} else {
				kind = "image"
			}
		}
		inputRefs = append(inputRefs, map[string]any{
			"id":   rec.ID,
			"kind": rec.Kind,
			"name": rec.Name,
			"mime": rec.Mime,
			"size": rec.Size,
			"hash": *rec.Hash,
		})
		parts = append(parts, media.MediaInputPart{
			Kind:     kind,
			Data:     rawBytes,
			MimeType: rec.Mime,
		})
	}
	h.hub.mu.RUnlock()

	now := h.hub.nowMs()
	var authObj any
	if authorizeOnly {
		authObj = map[string]any{
			"channel":   req.Channel,
			"expiresAt": now + 3600_000,
		}
	}
	job := map[string]any{
		"kind":             "understanding",
		"id":               req.ID,
		"prompt":           req.Prompt,
		"inputs":           inputRefs,
		"inputIds":         req.Inputs,
		"maxOutputTokens":  req.MaxOutputTokens,
		"model":            firstNonEmpty(resolved.cfg.Model, "gpt-4o-mini"),
		"connection":       resolved.connection,
		"revision":         resolved.revision,
		"source":           map[string]any{"kind": "user"},
		"authorization":    authObj,
		"phase":            "generating",
		"phaseText":        "Understanding",
		"problem":          "",
		"result":           nil,
		"cleanup":          "pending",
		"cleanupText":      "Pending",
		"canCancel":        true,
		"canCleanup":       false,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
	}
	if authorizeOnly {
		job["phase"] = "authorized"
		job["phaseText"] = "Authorized"
		job["cleanup"] = "done"
		job["cleanupText"] = "Done"
		raw, err := h.saveMediaJob("understanding", job)
		return raw, true, err
	}

	res, err := runner.UnderstandMedia(ctx, media.UnderstandingRequest{
		Model:     resolved.cfg.Model,
		Prompt:    req.Prompt,
		Parts:     parts,
		MaxTokens: req.MaxOutputTokens,
	}, nil)
	if err != nil {
		return nil, true, newBizError(BizMediaRefused, err.Error())
	}
	job["phase"] = "ready"
	job["phaseText"] = "Ready"
	job["cleanup"] = "done"
	job["cleanupText"] = "Done"
	job["canCancel"] = false
	job["result"] = map[string]any{
		"model":  firstNonEmpty(res.Model, resolved.cfg.Model),
		"text":   res.Text,
		"status": "completed",
		"usage": map[string]any{
			"inputTokens":  res.Usage.PromptTokens,
			"outputTokens": res.Usage.CompletionTokens,
			"totalTokens":  res.Usage.TotalTokens,
		},
	}
	job["updatedAt"] = h.hub.nowMs()
	raw, err := h.saveMediaJob("understanding", job)
	return raw, true, err
}

func (h *Handler) runLiveUnderstandingStart(ctx context.Context, id string) (json.RawMessage, bool, error) {
	h.hub.mu.RLock()
	rec := h.hub.state.MediaJobs[id]
	if rec == nil || rec.Kind != "understanding" {
		h.hub.mu.RUnlock()
		return nil, false, nil
	}
	var m map[string]any
	if err := json.Unmarshal(rec.Raw, &m); err != nil {
		h.hub.mu.RUnlock()
		return nil, false, nil
	}
	connID, _ := m["connection"].(string)
	modelID, _ := m["model"].(string)
	prompt, _ := m["prompt"].(string)
	rawInputs, _ := m["inputs"].([]any)
	parts := make([]media.MediaInputPart, 0, len(rawInputs))
	for _, entry := range rawInputs {
		entryMap, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		inID, _ := entryMap["id"].(string)
		if mr := h.hub.state.MediaInputs[inID]; mr != nil {
			parts = append(parts, media.MediaInputPart{
				Kind:     firstNonEmpty(mr.Kind, "image"),
				Data:     h.mediaInputBytes(mr),
				MimeType: mr.Mime,
			})
		}
	}
	h.hub.mu.RUnlock()

	runner, resolved, ok := h.resolveMediaVendor("understanding", connID, modelID)
	if !ok || runner == nil {
		return nil, false, nil
	}

	maxTok := 0
	if mt, ok := m["maxOutputTokens"].(float64); ok {
		maxTok = int(mt)
	}
	res, err := runner.UnderstandMedia(ctx, media.UnderstandingRequest{
		Model:     firstNonEmpty(modelID, resolved.cfg.Model),
		Prompt:    prompt,
		Parts:     parts,
		MaxTokens: maxTok,
	}, nil)
	if err != nil {
		return nil, true, newBizError(BizMediaRefused, err.Error())
	}

	m["phase"] = "ready"
	m["phaseText"] = "Ready"
	m["cleanup"] = "done"
	m["cleanupText"] = "Done"
	m["canCancel"] = false
	m["result"] = map[string]any{
		"model":  firstNonEmpty(res.Model, modelID, resolved.cfg.Model),
		"text":   res.Text,
		"status": "completed",
		"usage": map[string]any{
			"inputTokens":  res.Usage.PromptTokens,
			"outputTokens": res.Usage.CompletionTokens,
			"totalTokens":  res.Usage.TotalTokens,
		},
	}
	m["updatedAt"] = h.hub.nowMs()
	raw, err := h.saveMediaJob("understanding", m)
	return raw, true, err
}

func (h *Handler) runLiveSpeechCreate(ctx context.Context, req struct {
	ID           string `json:"id"`
	Text         string `json:"text"`
	Voice        string `json:"voice"`
	Format       string `json:"format"`
	Asynchronous bool   `json:"asynchronous"`
	Streaming    bool   `json:"streaming"`
	Connection   string `json:"connection"`
	Revision     int    `json:"revision"`
}) (json.RawMessage, bool, error) {
	runner, resolved, ok := h.resolveMediaVendor("speech", req.Connection, "")
	if !ok || runner == nil {
		return nil, false, nil
	}
	now := h.hub.nowMs()
	format := firstNonEmpty(req.Format, "mp3")
	voiceName := firstNonEmpty(req.Voice, resolved.cfg.Voice, "alloy")
	job := map[string]any{
		"kind":             "speech",
		"id":               req.ID,
		"prompt":           req.Text,
		"model":            firstNonEmpty(resolved.cfg.Model, "gpt-4o-mini-tts"),
		"connection":       resolved.connection,
		"revision":         resolved.revision,
		"source":           map[string]any{"kind": "user"},
		"voice":            voiceName,
		"format":           format,
		"canRelease":       false,
		"phase":            "streaming",
		"phaseText":        "Streaming",
		"problem":          "",
		"resultInput":      nil,
		"canCancel":        true,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
	}
	if req.Streaming {
		raw, err := h.saveMediaJob("speech", job)
		return raw, true, err
	}

	res, err := runner.SynthesizeSpeech(ctx, media.SpeechRequest{
		Input:          req.Text,
		Model:          firstNonEmpty(resolved.cfg.Model, "gpt-4o-mini-tts"),
		Voice:          voiceName,
		ResponseFormat: format,
	}, nil)
	if err != nil {
		return nil, true, newBizError(BizMediaRefused, err.Error())
	}
	mime := firstNonEmpty(res.MimeType, "audio/mpeg")
	ext := firstNonEmpty(res.Format, format)
	att, aErr := h.st.Attachments.PutBytes(ctx, req.ID+"."+ext, mime, res.Bytes)
	if aErr != nil {
		return nil, true, aErr
	}
	job["phase"] = "ready"
	job["phaseText"] = "Ready"
	job["format"] = ext
	job["contentType"] = mime
	job["canCancel"] = false
	job["canRelease"] = true
	job["attachment"] = att
	job["resultInput"] = h.registerResultMediaInput("audio", req.ID+"."+ext, mime, res.Bytes)
	job["updatedAt"] = h.hub.nowMs()
	h.addGeneratedLibraryItem(ctx, att.ID, req.ID, "speech")
	raw, err := h.saveMediaJob("speech", job)
	return raw, true, err
}

func (h *Handler) runLiveSpeechStream(w http.ResponseWriter, r *http.Request, id string) bool {
	if offlineMediaEnabled() {
		return false
	}
	h.hub.mu.RLock()
	rec := h.hub.state.MediaJobs[id]
	h.hub.mu.RUnlock()
	if rec == nil || rec.Kind != "speech" {
		return false
	}
	var m map[string]any
	if json.Unmarshal(rec.Raw, &m) != nil {
		return false
	}
	connID, _ := m["connection"].(string)
	modelID, _ := m["model"].(string)
	runner, resolved, ok := h.resolveMediaVendor("speech", connID, modelID)
	if !ok || runner == nil {
		return false
	}
	prompt, _ := m["prompt"].(string)
	voiceName, _ := m["voice"].(string)
	format, _ := m["format"].(string)

	flusher, canFlush := w.(http.Flusher)
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	writeLine := func(v any) {
		b, _ := json.Marshal(v)
		_, _ = w.Write(append(b, '\n'))
		if canFlush {
			flusher.Flush()
		}
	}

	writeLine(map[string]any{"type": "format", "sampleRate": 24000, "channels": 1, "bitDepth": 16, "format": firstNonEmpty(format, "mp3")})

	var seq int
	res, err := runner.SynthesizeSpeech(r.Context(), media.SpeechRequest{
		Input:          prompt,
		Model:          firstNonEmpty(modelID, resolved.cfg.Model, "gpt-4o-mini-tts"),
		Voice:          firstNonEmpty(voiceName, resolved.cfg.Voice, "alloy"),
		ResponseFormat: firstNonEmpty(format, "mp3"),
	}, func(chunk []byte) {
		if len(chunk) == 0 {
			return
		}
		writeLine(map[string]any{
			"type":     "audio",
			"sequence": seq,
			"audio":    base64.StdEncoding.EncodeToString(chunk),
		})
		seq++
	})
	if err != nil {
		writeLine(map[string]any{"type": "error", "error": err.Error()})
		return true
	}

	mime := firstNonEmpty(res.MimeType, "audio/mpeg")
	ext := firstNonEmpty(res.Format, format, "mp3")
	if h.st != nil && h.st.Attachments != nil && len(res.Bytes) > 0 {
		if att, aErr := h.st.Attachments.PutBytes(r.Context(), id+"."+ext, mime, res.Bytes); aErr == nil {
			ri := h.registerResultMediaInput("audio", id+"."+ext, mime, res.Bytes)
			h.hub.mu.Lock()
			if cur := h.hub.state.MediaJobs[id]; cur != nil {
				m["phase"] = "ready"
				m["phaseText"] = "Ready"
				m["canCancel"] = false
				m["canRelease"] = true
				m["contentType"] = mime
				m["attachment"] = att
				m["resultInput"] = ri
				m["updatedAt"] = h.hub.nowMs()
				raw, _ := json.Marshal(m)
				cur.Raw = raw
			}
			h.hub.mu.Unlock()
			h.addGeneratedLibraryItem(r.Context(), att.ID, id, "speech")
			_ = h.hub.persist()
			h.hub.notifyAllState()
		}
	}
	writeLine(map[string]any{"type": "done"})
	return true
}

type connectorReplyRoute struct {
	connectorID    connector.ConnectorID
	externalChatID string
	replyToID      string
	lastSentSeq    int64
}

func (h *Handler) setupConnectorBridging() {
	if h == nil || h.st == nil {
		return
	}
	if h.st.Connectors != nil {
		h.st.Connectors.SetInboundHandler(h.handleConnectorInbound)
	}
	if h.st.Channels != nil {
		unsub := h.st.Channels.Subscribe(func(ev channel.Event) {
			h.forwardChannelReplyToConnector(ev)
		})
		h.unsubMu.Lock()
		h.unsubChannel = unsub
		h.unsubMu.Unlock()
	}
}

func (h *Handler) handleConnectorWebhook(w http.ResponseWriter, r *http.Request, cleanPath string) {
	if h.st == nil || h.st.Connectors == nil {
		writeError(w, newBizError(BizServiceUnavailable, "connector service unavailable"), BizServiceUnavailable)
		return
	}
	idStr := strings.TrimPrefix(cleanPath, "/api/v1/connector/webhook/")
	idStr = strings.Trim(idStr, "/")
	if idStr == "" || strings.Contains(idStr, "/") {
		writeError(w, newBizError(BizRouteNotFound, "connector webhook id missing"), BizRouteNotFound)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		writeError(w, newBizError(BizInvalidInput, "read webhook body failed"), BizInvalidInput)
		return
	}
	msg, err := h.st.Connectors.HandleWebhook(r.Context(), connector.ConnectorID(idStr), body)
	if err != nil {
		writeError(w, err, BizConnectorRefused)
		return
	}
	// Feishu / Slack URL verification challenge expects raw challenge JSON HTTP 200.
	if msg.Challenge != "" && msg.Text == "" && msg.ExternalUserID == "" {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"challenge": msg.Challenge})
		return
	}
	writeSuccess(w, msg)
}

func (h *Handler) handleConnectorInbound(ctx context.Context, msg connector.InboundMessage) error {
	if h == nil || h.st == nil || h.st.Channels == nil {
		return nil
	}
	targetChID := defaultChannelID
	if h.st.Connectors != nil {
		if st, err := h.st.Connectors.Get(msg.ConnectorID); err == nil && strings.TrimSpace(st.Channel) != "" {
			targetChID = st.Channel
		}
	}
	ch, err := h.resolveChannel(ctx, targetChID)
	if err != nil {
		ch, err = h.resolveChannel(ctx, defaultChannelID)
		if err != nil {
			return err
		}
	}
	author := firstNonEmpty(msg.SenderName, msg.ExternalUserID, string(msg.ConnectorID))
	mentions := extractMentions(msg.Text)
	if len(mentions) == 0 && ch.DefaultAgentID != "" {
		mentions = []string{ch.DefaultAgentID}
	}

	h.connRoutesMu.Lock()
	h.connRoutes[ch.ID] = &connectorReplyRoute{
		connectorID:    msg.ConnectorID,
		externalChatID: msg.ExternalChatID,
		replyToID:      firstNonEmpty(msg.MessageID, msg.ReplyToID),
	}
	h.connRoutesMu.Unlock()

	res, _, err := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
		ChannelID: ch.ID,
		Kind:      contract.ChannelEventMessage,
		AuthorID:  author,
		ActorKind: channel.ActorUser,
		Text:      msg.Text,
		Mentions:  mentions,
		SendKey:   msg.MessageID,
	})
	if err != nil {
		return err
	}

	h.connRoutesMu.Lock()
	if route := h.connRoutes[ch.ID]; route != nil && res.Event.Seq > route.lastSentSeq {
		route.lastSentSeq = res.Event.Seq
	}
	h.connRoutesMu.Unlock()

	h.hub.mu.Lock()
	cMeta := h.hub.ensureChannelMetaLocked(ch.ID)
	cMeta.LastAt = res.Event.CreatedAtMs
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(ctx)

	chatMsg := h.hub.buildChatMessage(res.Event)
	h.hub.emitChannelMessage(ch.ID, chatMsg.Revision, chatMsg)
	if !res.Deduplicated {
		h.triggerChannelAutoReply(ctx, ch, res.Event, ch.DefaultAgentID, mentions)
	}
	h.hub.notifyAllState()
	return nil
}

func (h *Handler) forwardChannelReplyToConnector(ev channel.Event) {
	if h == nil || h.st == nil || h.st.Connectors == nil {
		return
	}
	if ev.ActorKind != channel.ActorAgent || strings.TrimSpace(ev.Text) == "" {
		return
	}

	h.connRoutesMu.Lock()
	route := h.connRoutes[ev.ChannelID]
	if route == nil || ev.Seq <= route.lastSentSeq {
		h.connRoutesMu.Unlock()
		return
	}
	connID := route.connectorID
	chatID := route.externalChatID
	replyTo := route.replyToID
	route.lastSentSeq = ev.Seq
	h.connRoutesMu.Unlock()

	ctx := h.st.BackgroundContext()
	_, _ = h.st.Connectors.SendOutbound(ctx, connID, chatID, ev.Text, replyTo)
}

var (
	_ = filepath.Join
	_ sync.Mutex
)
