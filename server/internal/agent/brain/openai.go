package brain

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

// ChatCompletions answers OpenAI's chat/completions for an agent that keeps its own conversation. Only the newest user message is read: the
// agent's session is the history and its own prompt the persona, so earlier messages, system messages and tools in the request are not. Only
// the agent's words come back, without usage. Who may ask (paths, keys) is the mounting side's business.
type ChatCompletions struct {
	// One turn's words as they come; the channel closes when the turn is over and is no longer read once the request ends. nil: no such model.
	Answerer func(model string) func(ctx context.Context, text string) <-chan string
	// Said when a request has no user text; empty: such a request is refused.
	Misheard string
	Logf     func(format string, args ...any)
}

type chatRequest struct {
	Model    string `json:"model"`
	Stream   bool   `json:"stream"`
	Messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
}

// Content is a string or a list of parts, of which only the text ones count.
func (r chatRequest) newestUserText() string {
	for i := len(r.Messages) - 1; i >= 0; i-- {
		m := r.Messages[i]
		if m.Role != "user" {
			continue
		}
		var text string
		if json.Unmarshal(m.Content, &text) == nil {
			return strings.TrimSpace(text)
		}
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(m.Content, &parts) != nil {
			return ""
		}
		var b strings.Builder
		for _, p := range parts {
			if p.Type == "text" {
				b.WriteString(p.Text)
			}
		}
		return strings.TrimSpace(b.String())
	}
	return ""
}

func chatError(w http.ResponseWriter, status int, kind, code, message string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	body, _ := json.Marshal(map[string]any{"error": map[string]any{"message": message, "type": kind, "code": code}})
	w.Write(body)
}

// finish_reason is null until the last chunk, which has an empty delta.
func chatChunk(id string, created int64, model, content string, stop, first bool) string {
	delta := map[string]any{}
	var finish any
	if stop {
		finish = "stop"
	} else {
		if first {
			delta["role"] = "assistant"
		}
		delta["content"] = content
	}
	type choice struct {
		Index        int            `json:"index"`
		Delta        map[string]any `json:"delta"`
		FinishReason any            `json:"finish_reason"`
	}
	body, _ := json.Marshal(struct {
		ID      string   `json:"id"`
		Object  string   `json:"object"`
		Created int64    `json:"created"`
		Model   string   `json:"model"`
		Choices []choice `json:"choices"`
	}{id, "chat.completion.chunk", created, model, []choice{{0, delta, finish}}})
	return "data: " + string(body) + "\n\n"
}

func (c ChatCompletions) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		chatError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "only POST")
		return
	}
	asked := time.Now()
	var req chatRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		chatError(w, http.StatusBadRequest, "invalid_request_error", "invalid_json", err.Error())
		return
	}
	answer := c.Answerer(req.Model)
	if answer == nil {
		chatError(w, http.StatusNotFound, "invalid_request_error", "model_not_found", "no model "+req.Model)
		return
	}
	var words <-chan string
	if text := req.newestUserText(); text != "" {
		words = answer(r.Context(), text)
	} else if c.Misheard != "" {
		misheard := make(chan string, 1)
		misheard <- c.Misheard
		close(misheard)
		words = misheard
	} else {
		chatError(w, http.StatusBadRequest, "invalid_request_error", "no_user_message", "no user message to answer")
		return
	}
	raw := make([]byte, 6)
	rand.Read(raw)
	id := "chatcmpl-" + hex.EncodeToString(raw)
	created := asked.Unix()
	firstWords := func() {
		if c.Logf != nil {
			c.Logf("vibevalley: %s's first words %dms after it was asked", req.Model, time.Since(asked).Milliseconds())
		}
	}
	if !req.Stream {
		c.whole(w, r, words, id, created, req.Model, firstWords)
		return
	}
	flusher, _ := w.(http.Flusher)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)
	send := func(s string) bool {
		if _, err := io.WriteString(w, s); err != nil {
			return false
		}
		if flusher != nil {
			flusher.Flush()
		}
		return true
	}
	first := true
	for {
		select {
		case <-r.Context().Done():
			return
		case content, open := <-words:
			if !open {
				send(chatChunk(id, created, req.Model, "", true, false))
				send("data: [DONE]\n\n")
				return
			}
			if first {
				firstWords()
			}
			if !send(chatChunk(id, created, req.Model, content, false, first)) {
				return
			}
			first = false
		}
	}
}

func (c ChatCompletions) whole(w http.ResponseWriter, r *http.Request, words <-chan string, id string, created int64, model string, firstWords func()) {
	var b strings.Builder
	for {
		select {
		case <-r.Context().Done():
			return
		case content, open := <-words:
			if open {
				if b.Len() == 0 {
					firstWords()
				}
				b.WriteString(content)
				continue
			}
			type message struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			}
			type choice struct {
				Index        int     `json:"index"`
				Message      message `json:"message"`
				FinishReason string  `json:"finish_reason"`
			}
			body, _ := json.Marshal(struct {
				ID      string   `json:"id"`
				Object  string   `json:"object"`
				Created int64    `json:"created"`
				Model   string   `json:"model"`
				Choices []choice `json:"choices"`
			}{id, "chat.completion", created, model, []choice{{0, message{"assistant", b.String()}, "stop"}}})
			w.Header().Set("Content-Type", "application/json")
			w.Write(body)
			return
		}
	}
}
