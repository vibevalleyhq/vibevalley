package media_test

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/media"
)

func TestVendorRunnerGenerateImageBase64AndURL(t *testing.T) {
	t.Parallel()

	pngBytes := []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDRfake-png")
	jpegBytes := []byte{0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 'J', 'F', 'I', 'F', 0x00}

	var srvURL string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/images/generations":
			if r.Header.Get("Authorization") != "Bearer media-key-1" {
				w.WriteHeader(http.StatusUnauthorized)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]any{"message": "bad key"}})
				return
			}
			var req map[string]any
			_ = json.NewDecoder(r.Body).Decode(&req)
			w.Header().Set("Content-Type", "application/json")
			if req["response_format"] == "url" {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"data": []map[string]any{{
						"url":            srvURL + "/cdn/generated.jpg",
						"revised_prompt": "revised url prompt",
					}},
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": []map[string]any{{
					"b64_json":       base64.StdEncoding.EncodeToString(pngBytes),
					"revised_prompt": "revised b64 prompt",
				}},
			})
		case "/cdn/generated.jpg":
			w.Header().Set("Content-Type", "image/jpeg")
			_, _ = w.Write(jpegBytes)
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	srvURL = srv.URL

	runner := media.NewVendorRunner(media.VendorConfig{
		BaseURL:    srv.URL + "/v1",
		APIKey:     "media-key-1",
		Model:      "moss-image-sft-1.0",
		Timeout:    5 * time.Second,
		HTTPClient: srv.Client(),
	})

	// 1. b64_json path.
	resB64, err := runner.GenerateImage(context.Background(), media.ImageRequest{
		Prompt: "golden wheat field",
		Width:  512,
		Height: 512,
	})
	if err != nil {
		t.Fatalf("GenerateImage b64: %v", err)
	}
	if !bytes.Equal(resB64.Bytes, pngBytes) || resB64.MimeType != "image/png" || resB64.RevisedPrompt != "revised b64 prompt" || resB64.Duration <= 0 {
		t.Fatalf("unexpected b64 image result: %+v", resB64)
	}

	// 2. URL download path.
	resURL, err := runner.GenerateImage(context.Background(), media.ImageRequest{
		Prompt:         "barn at sunset",
		ResponseFormat: "url",
	})
	if err != nil {
		t.Fatalf("GenerateImage url: %v", err)
	}
	if !bytes.Equal(resURL.Bytes, jpegBytes) || resURL.MimeType != "image/jpeg" || resURL.RevisedPrompt != "revised url prompt" {
		t.Fatalf("unexpected url image result: %+v", resURL)
	}

	// 3. Unauthorized returns ErrVendorRequest.
	badRunner := media.NewVendorRunner(media.VendorConfig{
		BaseURL:    srv.URL + "/v1",
		APIKey:     "wrong",
		HTTPClient: srv.Client(),
	})
	if _, err := badRunner.GenerateImage(context.Background(), media.ImageRequest{Prompt: "x"}); !errors.Is(err, media.ErrVendorRequest) {
		t.Fatalf("expected ErrVendorRequest on 401, got %v", err)
	}
}

func TestVendorRunnerUnderstandMediaSSEAndNonStreaming(t *testing.T) {
	t.Parallel()

	imgBytes := []byte("\x89PNG\r\n\x1a\nimg")
	audioBytes := []byte("RIFF\x00\x00\x00\x00WAVE")
	var capturedBody map[string]any

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			http.NotFound(w, r)
			return
		}
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &capturedBody)

		stream, _ := capturedBody["stream"].(bool)
		if stream {
			w.Header().Set("Content-Type", "text/event-stream")
			flusher, _ := w.(http.Flusher)
			chunks := []string{
				`data: {"model":"qwen-vl-max","choices":[{"index":0,"delta":{"content":"The image "}}]}`,
				`data: {"model":"qwen-vl-max","choices":[{"index":0,"delta":{"content":"shows wheat."},"finish_reason":"stop"}],"usage":{"prompt_tokens":12,"completion_tokens":5,"total_tokens":17}}`,
				`data: [DONE]`,
			}
			for _, ch := range chunks {
				_, _ = fmt.Fprintf(w, "%s\n\n", ch)
				if flusher != nil {
					flusher.Flush()
				}
			}
			return
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"model": "moss-vl-1.0",
			"choices": []map[string]any{{
				"finish_reason": "stop",
				"message": map[string]any{
					"content": "JSON summary OK",
				},
			}},
			"usage": map[string]any{"prompt_tokens": 8, "completion_tokens": 3, "total_tokens": 11},
		})
	}))
	defer srv.Close()

	runner := &media.VendorRunner{
		Config: media.VendorConfig{
			BaseURL: srv.URL + "/v1",
			APIKey:  "vl-key",
			Model:   "qwen-vl-max",
		},
		HTTPClient: srv.Client(),
	}

	// 1. Streaming SSE with text + image_url data URI + input_audio base64.
	var deltas []string
	streamRes, err := runner.UnderstandMedia(context.Background(), media.UnderstandingRequest{
		System: "Be concise.",
		Prompt: "Describe these inputs.",
		Parts: []media.MediaInputPart{
			{Kind: "image", Data: imgBytes, MimeType: "image/png"},
			{Kind: "audio", Data: audioBytes, Format: "wav"},
		},
	}, func(d string) {
		deltas = append(deltas, d)
	})
	if err != nil {
		t.Fatalf("UnderstandMedia SSE: %v", err)
	}
	if streamRes.Text != "The image shows wheat." || len(deltas) != 2 || streamRes.Usage.TotalTokens != 17 {
		t.Fatalf("unexpected SSE understanding result: res=%+v deltas=%v", streamRes, deltas)
	}

	// Verify multimodal payload parts serialized properly.
	rawPayload, _ := json.Marshal(capturedBody)
	payloadStr := string(rawPayload)
	wantImageURI := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imgBytes)
	wantAudioB64 := base64.StdEncoding.EncodeToString(audioBytes)
	if !strings.Contains(payloadStr, wantImageURI) || !strings.Contains(payloadStr, wantAudioB64) || !strings.Contains(payloadStr, `"input_audio"`) {
		t.Fatalf("multimodal request missing expected content parts: %s", payloadStr)
	}

	// 2. Non-streaming JSON mode.
	streamFalse := false
	jsonRes, err := runner.UnderstandMedia(context.Background(), media.UnderstandingRequest{
		Prompt: "Quick check",
		Stream: &streamFalse,
	}, nil)
	if err != nil {
		t.Fatalf("UnderstandMedia JSON: %v", err)
	}
	if jsonRes.Text != "JSON summary OK" || jsonRes.Model != "moss-vl-1.0" || jsonRes.Usage.TotalTokens != 11 {
		t.Fatalf("unexpected JSON understanding result: %+v", jsonRes)
	}
}

func TestVendorRunnerSynthesizeSpeechStreamingChunksAndMIME(t *testing.T) {
	t.Parallel()

	mp3Part1 := []byte("ID3\x04\x00\x00\x00\x00\x00\x00chunk1-")
	mp3Part2 := []byte("chunk2-frames")
	wavBytes := []byte("RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00")

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/speech" {
			http.NotFound(w, r)
			return
		}
		var req map[string]any
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req["response_format"] == "wav" {
			w.Header().Set("Content-Type", "audio/wav")
			_, _ = w.Write(wavBytes)
			return
		}
		w.Header().Set("Content-Type", "audio/mpeg")
		flusher, _ := w.(http.Flusher)
		_, _ = w.Write(mp3Part1)
		if flusher != nil {
			flusher.Flush()
		}
		_, _ = w.Write(mp3Part2)
		if flusher != nil {
			flusher.Flush()
		}
	}))
	defer srv.Close()

	runner := media.NewVendorRunner(media.VendorConfig{
		BaseURL:    srv.URL + "/v1",
		APIKey:     "tts-key",
		Model:      "moss-tts-1.5-flash",
		Voice:      "alloy",
		HTTPClient: srv.Client(),
	})

	var streamed bytes.Buffer
	var chunkCount int
	mp3Res, err := runner.SynthesizeSpeech(context.Background(), media.SpeechRequest{
		Input:          "Harvest ready.",
		ResponseFormat: "mp3",
	}, func(c []byte) {
		chunkCount++
		streamed.Write(c)
	})
	if err != nil {
		t.Fatalf("SynthesizeSpeech mp3: %v", err)
	}
	wantMP3 := append(append([]byte(nil), mp3Part1...), mp3Part2...)
	if mp3Res.MimeType != "audio/mpeg" || !bytes.Equal(mp3Res.Bytes, wantMP3) || !bytes.Equal(streamed.Bytes(), wantMP3) || chunkCount == 0 {
		t.Fatalf("unexpected mp3 synthesis result: res=%+v chunks=%d streamedLen=%d", mp3Res, chunkCount, streamed.Len())
	}

	wavRes, err := runner.SynthesizeSpeech(context.Background(), media.SpeechRequest{
		Input:          "Check wav.",
		ResponseFormat: "wav",
	}, nil)
	if err != nil {
		t.Fatalf("SynthesizeSpeech wav: %v", err)
	}
	if wavRes.MimeType != "audio/wav" || !bytes.Equal(wavRes.Bytes, wavBytes) {
		t.Fatalf("unexpected wav synthesis result: %+v", wavRes)
	}
}

func TestVendorRunnerTimeoutAndConfigValidation(t *testing.T) {
	t.Parallel()

	slow := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-r.Context().Done():
			return
		case <-time.After(500 * time.Millisecond):
			w.WriteHeader(http.StatusOK)
		}
	}))
	defer slow.Close()

	runner := media.NewVendorRunner(media.VendorConfig{
		BaseURL:    slow.URL + "/v1",
		Timeout:    40 * time.Millisecond,
		HTTPClient: slow.Client(),
	})
	if _, err := runner.GenerateImage(context.Background(), media.ImageRequest{Prompt: "slow"}); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("expected context.DeadlineExceeded, got %v", err)
	}

	emptyRunner := media.NewVendorRunner(media.VendorConfig{})
	if _, err := emptyRunner.UnderstandMedia(context.Background(), media.UnderstandingRequest{Prompt: "hi"}, nil); !errors.Is(err, media.ErrVendorConfig) {
		t.Fatalf("expected ErrVendorConfig for missing BaseURL, got %v", err)
	}
}
