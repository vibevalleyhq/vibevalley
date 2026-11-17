package media

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"time"
)

const (
	maxVendorErrorBytes = 1 << 20
	speechReadChunkSize = 16 * 1024
)

// GenerateImage calls `POST {BaseURL}/images/generations`, decodes `b64_json` or downloads `url`,
// and returns image bytes, MIME type, revised prompt, and elapsed duration.
func (r *VendorRunner) GenerateImage(ctx context.Context, req ImageRequest) (ImageResult, error) {
	runCtx, cancel := r.withTimeout(ctx)
	defer cancel()
	if err := runCtx.Err(); err != nil {
		return ImageResult{}, err
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return ImageResult{}, fmt.Errorf("%w: prompt is required", ErrVendorConfig)
	}
	endpoint, err := r.endpointURL("/images/generations")
	if err != nil {
		return ImageResult{}, err
	}

	model := firstNonEmpty(req.Model, r.Config.Model, "gpt-image-1")
	size := strings.TrimSpace(req.Size)
	if size == "" && req.Width > 0 && req.Height > 0 {
		size = fmt.Sprintf("%dx%d", req.Width, req.Height)
	}

	payload := map[string]any{
		"model":  model,
		"prompt": req.Prompt,
	}
	if size != "" {
		payload["size"] = size
	}
	if req.N > 0 {
		payload["n"] = req.N
	}
	if strings.TrimSpace(req.Quality) != "" {
		payload["quality"] = strings.TrimSpace(req.Quality)
	}
	if strings.TrimSpace(req.Style) != "" {
		payload["style"] = strings.TrimSpace(req.Style)
	}
	if strings.TrimSpace(req.ResponseFormat) != "" {
		payload["response_format"] = strings.TrimSpace(req.ResponseFormat)
	}

	start := time.Now()
	resp, err := r.postJSON(runCtx, endpoint, "application/json", payload)
	if err != nil {
		return ImageResult{}, err
	}
	defer resp.Body.Close()

	raw, err := readBoundedBody(resp.Body, DefaultMaxAssetBytes)
	if err != nil {
		return ImageResult{}, fmt.Errorf("%w: read image response: %v", ErrVendorRequest, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ImageResult{}, parseVendorHTTPError("images/generations", resp.StatusCode, raw)
	}

	b64Data, imgURL, revisedPrompt, err := extractImageOutput(raw)
	if err != nil {
		return ImageResult{}, err
	}

	var imgBytes []byte
	var mimeType string

	if b64Data != "" {
		var dataMIME string
		imgBytes, dataMIME, err = decodeBase64Payload(b64Data)
		if err != nil {
			return ImageResult{}, fmt.Errorf("%w: decode b64_json: %v", ErrVendorResponse, err)
		}
		mimeType = firstNonEmpty(dataMIME, detectImageMIME(imgBytes))
	} else if imgURL != "" {
		resolvedURL, uErr := resolveDownloadURL(r.Config.BaseURL, imgURL)
		if uErr != nil {
			return ImageResult{}, fmt.Errorf("%w: invalid image url: %v", ErrVendorResponse, uErr)
		}
		imgURL = resolvedURL
		var ct string
		imgBytes, ct, err = r.downloadBinary(runCtx, resolvedURL)
		if err != nil {
			return ImageResult{}, err
		}
		mimeType = resolveImageDownloadMIME(ct, resolvedURL, imgBytes)
	} else {
		return ImageResult{}, fmt.Errorf("%w: image response missing b64_json and url", ErrVendorResponse)
	}

	return ImageResult{
		Bytes:         imgBytes,
		MimeType:      mimeType,
		RevisedPrompt: revisedPrompt,
		URL:           imgURL,
		Model:         model,
		Duration:      time.Since(start),
	}, nil
}

// UnderstandMedia sends multimodal content (`text`, `image_url` data URI, `input_audio` base64)
// to `POST {BaseURL}/chat/completions`, supporting both streaming SSE deltas and JSON responses.
func (r *VendorRunner) UnderstandMedia(ctx context.Context, req UnderstandingRequest, onDelta func(string)) (UnderstandingResult, error) {
	runCtx, cancel := r.withTimeout(ctx)
	defer cancel()
	if err := runCtx.Err(); err != nil {
		return UnderstandingResult{}, err
	}
	endpoint, err := r.endpointURL("/chat/completions")
	if err != nil {
		return UnderstandingResult{}, err
	}

	parts, err := buildUnderstandingParts(req)
	if err != nil {
		return UnderstandingResult{}, err
	}
	if len(parts) == 0 {
		return UnderstandingResult{}, fmt.Errorf("%w: prompt or media parts are required", ErrVendorConfig)
	}

	messages := make([]map[string]any, 0, 2)
	if sys := strings.TrimSpace(req.System); sys != "" {
		messages = append(messages, map[string]any{
			"role":    "system",
			"content": sys,
		})
	}
	messages = append(messages, map[string]any{
		"role":    "user",
		"content": parts,
	})

	stream := onDelta != nil
	if req.Stream != nil {
		stream = *req.Stream
	}
	model := firstNonEmpty(req.Model, r.Config.Model, "gpt-4o-mini")
	payload := map[string]any{
		"model":    model,
		"messages": messages,
		"stream":   stream,
	}
	if stream {
		payload["stream_options"] = map[string]any{"include_usage": true}
	}
	if req.MaxTokens > 0 {
		payload["max_tokens"] = req.MaxTokens
	}
	if req.Temperature != nil {
		payload["temperature"] = *req.Temperature
	}

	accept := "application/json"
	if stream {
		accept = "text/event-stream, application/json"
	}

	start := time.Now()
	resp, err := r.postJSON(runCtx, endpoint, accept, payload)
	if err != nil {
		return UnderstandingResult{}, err
	}
	defer resp.Body.Close()

	stopCancel := context.AfterFunc(runCtx, func() {
		_ = resp.Body.Close()
	})
	defer stopCancel()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		rawErr, _ := readBoundedBody(resp.Body, maxVendorErrorBytes)
		return UnderstandingResult{}, parseVendorHTTPError("chat/completions", resp.StatusCode, rawErr)
	}

	ct := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(ct, "text/event-stream") {
		res, sErr := consumeUnderstandingSSE(runCtx, resp.Body, model, onDelta)
		if sErr != nil {
			return UnderstandingResult{}, sErr
		}
		res.Duration = time.Since(start)
		return res, nil
	}

	raw, err := readBoundedBody(resp.Body, 16<<20)
	if err != nil {
		if runCtx.Err() != nil {
			return UnderstandingResult{}, runCtx.Err()
		}
		return UnderstandingResult{}, fmt.Errorf("%w: read understanding response: %v", ErrVendorRequest, err)
	}
	res, err := decodeUnderstandingJSON(raw, model)
	if err != nil {
		return UnderstandingResult{}, err
	}
	if onDelta != nil && res.Text != "" {
		onDelta(res.Text)
	}
	res.Duration = time.Since(start)
	return res, nil
}

// SynthesizeSpeech calls `POST {BaseURL}/audio/speech`, streaming audio chunks to onChunk while
// accumulating the full audio bytes and resolved MIME type (`audio/mpeg`, `audio/wav`, etc.).
func (r *VendorRunner) SynthesizeSpeech(ctx context.Context, req SpeechRequest, onChunk func([]byte)) (SpeechResult, error) {
	runCtx, cancel := r.withTimeout(ctx)
	defer cancel()
	if err := runCtx.Err(); err != nil {
		return SpeechResult{}, err
	}
	input := firstNonEmpty(req.Input, req.Text)
	if input == "" {
		return SpeechResult{}, fmt.Errorf("%w: speech input text is required", ErrVendorConfig)
	}
	endpoint, err := r.endpointURL("/audio/speech")
	if err != nil {
		return SpeechResult{}, err
	}

	model := firstNonEmpty(req.Model, r.Config.Model, "tts-1")
	voice := firstNonEmpty(req.Voice, r.Config.Voice, "alloy")
	format := strings.ToLower(strings.TrimPrefix(firstNonEmpty(req.ResponseFormat, "mp3"), "."))

	payload := map[string]any{
		"model":           model,
		"input":           input,
		"voice":           voice,
		"response_format": format,
	}
	if req.Speed > 0 {
		payload["speed"] = req.Speed
	}

	start := time.Now()
	resp, err := r.postJSON(runCtx, endpoint, "audio/*, application/octet-stream, application/json", payload)
	if err != nil {
		return SpeechResult{}, err
	}
	defer resp.Body.Close()

	stopCancel := context.AfterFunc(runCtx, func() {
		_ = resp.Body.Close()
	})
	defer stopCancel()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		rawErr, _ := readBoundedBody(resp.Body, maxVendorErrorBytes)
		return SpeechResult{}, parseVendorHTTPError("audio/speech", resp.StatusCode, rawErr)
	}

	ct := strings.ToLower(strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0]))
	var audioBytes []byte
	if ct == "application/json" {
		rawJSON, rErr := readBoundedBody(resp.Body, DefaultMaxAssetBytes)
		if rErr != nil {
			return SpeechResult{}, fmt.Errorf("%w: read speech json: %v", ErrVendorRequest, rErr)
		}
		audioBytes, err = decodeSpeechJSONAudio(rawJSON)
		if err != nil {
			return SpeechResult{}, err
		}
		if onChunk != nil && len(audioBytes) > 0 {
			onChunk(slices.Clone(audioBytes))
		}
		ct = ""
	} else {
		audioBytes, err = streamAudioChunks(runCtx, resp.Body, DefaultMaxAssetBytes, onChunk)
		if err != nil {
			return SpeechResult{}, err
		}
	}

	if len(audioBytes) == 0 {
		return SpeechResult{}, fmt.Errorf("%w: empty speech audio payload", ErrVendorResponse)
	}

	mimeType := resolveSpeechMIME(ct, format, audioBytes)
	return SpeechResult{
		Bytes:    audioBytes,
		MimeType: mimeType,
		Format:   format,
		Duration: time.Since(start),
	}, nil
}

func (r *VendorRunner) endpointURL(suffix string) (string, error) {
	base := strings.TrimRight(strings.TrimSpace(r.Config.BaseURL), "/")
	if base == "" {
		return "", fmt.Errorf("%w: BaseURL is required", ErrVendorConfig)
	}
	if strings.HasSuffix(base, suffix) {
		return base, nil
	}
	return base + suffix, nil
}

func (r *VendorRunner) postJSON(ctx context.Context, endpoint, accept string, payload any) (*http.Response, error) {
	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("%w: marshal request: %v", ErrVendorConfig, err)
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrVendorConfig, err)
	}
	httpReq.Header.Set("Content-Type", "application/json")
	if accept != "" {
		httpReq.Header.Set("Accept", accept)
	}
	if key := strings.TrimSpace(r.Config.APIKey); key != "" {
		httpReq.Header.Set("Authorization", "Bearer "+key)
	}
	for k, v := range r.Config.Headers {
		if strings.TrimSpace(k) != "" {
			httpReq.Header.Set(k, v)
		}
	}
	resp, err := r.httpClient().Do(httpReq)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: %v", ErrVendorRequest, err)
	}
	return resp, nil
}

func (r *VendorRunner) downloadBinary(ctx context.Context, targetURL string) ([]byte, string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return nil, "", fmt.Errorf("%w: %v", ErrVendorRequest, err)
	}
	resp, err := r.httpClient().Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, "", ctx.Err()
		}
		return nil, "", fmt.Errorf("%w: download image: %v", ErrVendorRequest, err)
	}
	defer resp.Body.Close()

	data, err := readBoundedBody(resp.Body, DefaultMaxAssetBytes)
	if err != nil {
		return nil, "", fmt.Errorf("%w: read image download: %v", ErrVendorRequest, err)
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, "", fmt.Errorf("%w: image download HTTP %d", ErrVendorRequest, resp.StatusCode)
	}
	ct := strings.TrimSpace(strings.Split(resp.Header.Get("Content-Type"), ";")[0])
	return data, ct, nil
}

func buildUnderstandingParts(req UnderstandingRequest) ([]map[string]any, error) {
	parts := make([]map[string]any, 0, len(req.Parts)+1)
	if p := strings.TrimSpace(req.Prompt); p != "" {
		parts = append(parts, map[string]any{
			"type": "text",
			"text": req.Prompt,
		})
	}
	for _, part := range req.Parts {
		kind := strings.ToLower(strings.TrimSpace(part.Kind))
		switch kind {
		case "text", "":
			if strings.TrimSpace(part.Text) != "" {
				parts = append(parts, map[string]any{
					"type": "text",
					"text": part.Text,
				})
			}
		case "image", "image_url":
			var imgURL string
			if len(part.Data) > 0 {
				mimeType := firstNonEmpty(part.MimeType, detectImageMIME(part.Data))
				imgURL = fmt.Sprintf("data:%s;base64,%s", mimeType, base64.StdEncoding.EncodeToString(part.Data))
			} else if strings.TrimSpace(part.URL) != "" {
				imgURL = strings.TrimSpace(part.URL)
			} else {
				return nil, fmt.Errorf("%w: image part missing data and url", ErrVendorConfig)
			}
			parts = append(parts, map[string]any{
				"type": "image_url",
				"image_url": map[string]string{
					"url": imgURL,
				},
			})
		case "audio", "input_audio":
			if len(part.Data) == 0 {
				return nil, fmt.Errorf("%w: input_audio part requires audio bytes", ErrVendorConfig)
			}
			format := firstNonEmpty(part.Format, audioFormatFromMIME(part.MimeType), "wav")
			parts = append(parts, map[string]any{
				"type": "input_audio",
				"input_audio": map[string]string{
					"data":   base64.StdEncoding.EncodeToString(part.Data),
					"format": format,
				},
			})
		default:
			return nil, fmt.Errorf("%w: unsupported media part kind %q", ErrVendorConfig, part.Kind)
		}
	}
	return parts, nil
}

type chatCompletionChunk struct {
	Model   string `json:"model"`
	Choices []struct {
		FinishReason string `json:"finish_reason"`
		Delta        struct {
			Content json.RawMessage `json:"content"`
		} `json:"delta"`
		Message *struct {
			Content json.RawMessage `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

func consumeUnderstandingSSE(ctx context.Context, body io.Reader, fallbackModel string, onDelta func(string)) (UnderstandingResult, error) {
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 8*1024*1024)

	var (
		textBuf      strings.Builder
		model        = fallbackModel
		finishReason string
		usage        UnderstandingUsage
		dataLines    []string
	)

	flush := func() (done bool, err error) {
		if len(dataLines) == 0 {
			return false, nil
		}
		payload := strings.TrimSpace(strings.Join(dataLines, "\n"))
		dataLines = dataLines[:0]
		if payload == "" {
			return false, nil
		}
		if payload == "[DONE]" {
			return true, nil
		}
		var chunk chatCompletionChunk
		if uErr := json.Unmarshal([]byte(payload), &chunk); uErr != nil {
			return false, fmt.Errorf("%w: decode SSE chunk: %v", ErrVendorResponse, uErr)
		}
		if chunk.Error != nil && chunk.Error.Message != "" {
			return false, fmt.Errorf("%w: %s", ErrVendorRequest, chunk.Error.Message)
		}
		if chunk.Model != "" {
			model = chunk.Model
		}
		if chunk.Usage != nil {
			usage = UnderstandingUsage{
				PromptTokens:     chunk.Usage.PromptTokens,
				CompletionTokens: chunk.Usage.CompletionTokens,
				TotalTokens:      chunk.Usage.TotalTokens,
			}
		}
		for _, ch := range chunk.Choices {
			if ch.FinishReason != "" {
				finishReason = ch.FinishReason
			}
			frag := extractContentText(ch.Delta.Content)
			if frag == "" && ch.Message != nil {
				frag = extractContentText(ch.Message.Content)
			}
			if frag != "" {
				textBuf.WriteString(frag)
				if onDelta != nil {
					onDelta(frag)
				}
			}
		}
		return false, nil
	}

	for scanner.Scan() {
		if err := ctx.Err(); err != nil {
			return UnderstandingResult{}, err
		}
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if line == "" {
			done, err := flush()
			if err != nil {
				return UnderstandingResult{}, err
			}
			if done {
				return UnderstandingResult{
					Text:         textBuf.String(),
					Model:        model,
					FinishReason: finishReason,
					Usage:        usage,
				}, nil
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, val, found := strings.Cut(line, ":")
		if found && strings.HasPrefix(val, " ") {
			val = val[1:]
		}
		if field == "data" {
			dataLines = append(dataLines, val)
		}
	}
	if err := ctx.Err(); err != nil {
		return UnderstandingResult{}, err
	}
	if err := scanner.Err(); err != nil {
		return UnderstandingResult{}, fmt.Errorf("%w: read SSE stream: %v", ErrVendorRequest, err)
	}
	if _, err := flush(); err != nil {
		return UnderstandingResult{}, err
	}
	return UnderstandingResult{
		Text:         textBuf.String(),
		Model:        model,
		FinishReason: finishReason,
		Usage:        usage,
	}, nil
}

func decodeUnderstandingJSON(raw []byte, fallbackModel string) (UnderstandingResult, error) {
	var resp chatCompletionChunk
	if err := json.Unmarshal(raw, &resp); err != nil {
		return UnderstandingResult{}, fmt.Errorf("%w: decode understanding json: %v", ErrVendorResponse, err)
	}
	if resp.Error != nil && resp.Error.Message != "" {
		return UnderstandingResult{}, fmt.Errorf("%w: %s", ErrVendorRequest, resp.Error.Message)
	}
	model := firstNonEmpty(resp.Model, fallbackModel)
	var text, finishReason string
	if len(resp.Choices) > 0 {
		finishReason = resp.Choices[0].FinishReason
		if resp.Choices[0].Message != nil {
			text = extractContentText(resp.Choices[0].Message.Content)
		}
		if text == "" {
			text = extractContentText(resp.Choices[0].Delta.Content)
		}
	}
	var usage UnderstandingUsage
	if resp.Usage != nil {
		usage = UnderstandingUsage{
			PromptTokens:     resp.Usage.PromptTokens,
			CompletionTokens: resp.Usage.CompletionTokens,
			TotalTokens:      resp.Usage.TotalTokens,
		}
	}
	return UnderstandingResult{
		Text:         text,
		Model:        model,
		FinishReason: finishReason,
		Usage:        usage,
	}, nil
}

func extractContentText(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return ""
	}
	var s string
	if json.Unmarshal(trimmed, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(trimmed, &parts) == nil {
		var sb strings.Builder
		for _, p := range parts {
			if p.Text != "" {
				sb.WriteString(p.Text)
			}
		}
		return sb.String()
	}
	return ""
}

func extractImageOutput(raw []byte) (b64Data, imgURL, revisedPrompt string, err error) {
	var payload struct {
		Data []struct {
			B64JSON       string `json:"b64_json"`
			URL           string `json:"url"`
			RevisedPrompt string `json:"revised_prompt"`
		} `json:"data"`
		Output *struct {
			Results []struct {
				URL           string `json:"url"`
				B64Image      string `json:"b64_image"`
				RevisedPrompt string `json:"revised_prompt"`
			} `json:"results"`
		} `json:"output"`
		Images []struct {
			URL     string `json:"url"`
			B64JSON string `json:"b64_json"`
		} `json:"images"`
	}
	if uErr := json.Unmarshal(raw, &payload); uErr != nil {
		return "", "", "", fmt.Errorf("%w: decode image json: %v", ErrVendorResponse, uErr)
	}
	if len(payload.Data) > 0 {
		d := payload.Data[0]
		return strings.TrimSpace(d.B64JSON), strings.TrimSpace(d.URL), strings.TrimSpace(d.RevisedPrompt), nil
	}
	if payload.Output != nil && len(payload.Output.Results) > 0 {
		r := payload.Output.Results[0]
		return strings.TrimSpace(r.B64Image), strings.TrimSpace(r.URL), strings.TrimSpace(r.RevisedPrompt), nil
	}
	if len(payload.Images) > 0 {
		im := payload.Images[0]
		return strings.TrimSpace(im.B64JSON), strings.TrimSpace(im.URL), "", nil
	}
	return "", "", "", fmt.Errorf("%w: image response contained no results", ErrVendorResponse)
}

func decodeBase64Payload(raw string) ([]byte, string, error) {
	trimmed := strings.TrimSpace(raw)
	var declaredMIME string
	if strings.HasPrefix(trimmed, "data:") {
		if header, rest, ok := strings.Cut(trimmed, ","); ok {
			meta := strings.TrimPrefix(header, "data:")
			declaredMIME = strings.TrimSpace(strings.Split(meta, ";")[0])
			trimmed = rest
		}
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err != nil {
		decoded, err = base64.RawStdEncoding.DecodeString(trimmed)
		if err != nil {
			return nil, "", err
		}
	}
	return decoded, declaredMIME, nil
}

func decodeSpeechJSONAudio(raw []byte) ([]byte, error) {
	var payload struct {
		Audio string `json:"audio"`
		Data  *struct {
			Audio string `json:"audio"`
		} `json:"data"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &payload); err != nil {
		return nil, fmt.Errorf("%w: decode speech json: %v", ErrVendorResponse, err)
	}
	if payload.Error != nil && payload.Error.Message != "" {
		return nil, fmt.Errorf("%w: %s", ErrVendorRequest, payload.Error.Message)
	}
	b64 := payload.Audio
	if b64 == "" && payload.Data != nil {
		b64 = payload.Data.Audio
	}
	if strings.TrimSpace(b64) == "" {
		return nil, fmt.Errorf("%w: speech json missing audio", ErrVendorResponse)
	}
	decoded, _, err := decodeBase64Payload(b64)
	if err != nil {
		return nil, fmt.Errorf("%w: decode speech audio: %v", ErrVendorResponse, err)
	}
	return decoded, nil
}

func streamAudioChunks(ctx context.Context, r io.Reader, maxBytes int64, onChunk func([]byte)) ([]byte, error) {
	var out bytes.Buffer
	buf := make([]byte, speechReadChunkSize)
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n, readErr := r.Read(buf)
		if n > 0 {
			if int64(out.Len()+n) > maxBytes {
				return nil, fmt.Errorf("%w: audio exceeds %d bytes", ErrAssetTooLarge, maxBytes)
			}
			chunk := buf[:n]
			out.Write(chunk)
			if onChunk != nil {
				onChunk(slices.Clone(chunk))
			}
		}
		if readErr == io.EOF {
			return out.Bytes(), nil
		}
		if readErr != nil {
			if ctx.Err() != nil {
				return nil, ctx.Err()
			}
			return nil, fmt.Errorf("%w: read speech stream: %v", ErrVendorRequest, readErr)
		}
	}
}

func readBoundedBody(r io.Reader, maxBytes int64) ([]byte, error) {
	data, err := io.ReadAll(io.LimitReader(r, maxBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > maxBytes {
		return nil, fmt.Errorf("%w: payload exceeds %d bytes", ErrAssetTooLarge, maxBytes)
	}
	return data, nil
}

func parseVendorHTTPError(op string, status int, raw []byte) error {
	var errEnvelope struct {
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
		Message string `json:"message"`
	}
	msg := strings.TrimSpace(string(raw))
	if json.Unmarshal(raw, &errEnvelope) == nil {
		if errEnvelope.Error != nil && strings.TrimSpace(errEnvelope.Error.Message) != "" {
			msg = strings.TrimSpace(errEnvelope.Error.Message)
		} else if strings.TrimSpace(errEnvelope.Message) != "" {
			msg = strings.TrimSpace(errEnvelope.Message)
		}
	}
	if len(msg) > 256 {
		msg = msg[:256]
	}
	if msg == "" {
		return fmt.Errorf("%w: %s HTTP %d", ErrVendorRequest, op, status)
	}
	return fmt.Errorf("%w: %s HTTP %d: %s", ErrVendorRequest, op, status, msg)
}

func resolveDownloadURL(baseURL, rawURL string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return "", err
	}
	if parsed.IsAbs() {
		return parsed.String(), nil
	}
	base, err := url.Parse(strings.TrimSpace(baseURL))
	if err != nil {
		return "", err
	}
	return base.ResolveReference(parsed).String(), nil
}

func resolveImageDownloadMIME(contentType, rawURL string, data []byte) string {
	ct := strings.ToLower(strings.TrimSpace(contentType))
	if ct != "" && ct != "application/octet-stream" && ct != "binary/octet-stream" {
		return ct
	}
	if detected := detectImageMIME(data); detected != "application/octet-stream" {
		return detected
	}
	if u, err := url.Parse(rawURL); err == nil {
		return resolveMimeType(u.Path, "", data)
	}
	return "image/png"
}

func detectImageMIME(data []byte) string {
	switch {
	case len(data) >= 8 && bytes.Equal(data[:8], []byte{0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n'}):
		return "image/png"
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		return "image/jpeg"
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WEBP")):
		return "image/webp"
	case len(data) >= 6 && (bytes.Equal(data[:6], []byte("GIF87a")) || bytes.Equal(data[:6], []byte("GIF89a"))):
		return "image/gif"
	case len(data) > 0:
		trimmed := bytes.TrimSpace(data)
		if bytes.HasPrefix(trimmed, []byte("<svg")) || (bytes.HasPrefix(trimmed, []byte("<?xml")) && bytes.Contains(trimmed, []byte("<svg"))) {
			return "image/svg+xml"
		}
		return http.DetectContentType(data)
	default:
		return "application/octet-stream"
	}
}

func audioFormatFromMIME(mimeType string) string {
	base := strings.ToLower(strings.TrimSpace(strings.Split(mimeType, ";")[0]))
	switch base {
	case "audio/mpeg", "audio/mp3":
		return "mp3"
	case "audio/wav", "audio/x-wav", "audio/wave":
		return "wav"
	case "audio/ogg", "application/ogg", "audio/opus":
		return "ogg"
	case "audio/flac":
		return "flac"
	case "audio/aac", "audio/mp4":
		return "aac"
	case "audio/pcm", "audio/l16":
		return "pcm"
	default:
		return ""
	}
}

func resolveSpeechMIME(contentType, format string, data []byte) string {
	if contentType != "" && contentType != "application/octet-stream" && contentType != "binary/octet-stream" {
		return contentType
	}
	switch format {
	case "mp3":
		return "audio/mpeg"
	case "wav":
		return "audio/wav"
	case "opus":
		return "audio/opus"
	case "ogg":
		return "audio/ogg"
	case "flac":
		return "audio/flac"
	case "aac":
		return "audio/aac"
	case "pcm":
		return "audio/pcm"
	}
	switch {
	case len(data) >= 12 && bytes.Equal(data[:4], []byte("RIFF")) && bytes.Equal(data[8:12], []byte("WAVE")):
		return "audio/wav"
	case len(data) >= 3 && bytes.Equal(data[:3], []byte("ID3")):
		return "audio/mpeg"
	case len(data) >= 2 && data[0] == 0xFF && (data[1]&0xE0) == 0xE0:
		return "audio/mpeg"
	case len(data) >= 4 && bytes.Equal(data[:4], []byte("fLaC")):
		return "audio/flac"
	case len(data) >= 4 && bytes.Equal(data[:4], []byte("OggS")):
		return "audio/ogg"
	default:
		return "application/octet-stream"
	}
}
