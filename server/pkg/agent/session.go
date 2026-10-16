package agent

// A conversation on disk: `<name>.jsonl`, one message per line, appended as each is said. A compaction is a line
// too: reading the file back, a `compactionSummary` stands in for everything before it except its `kept` most
// recent messages. A session from before this format (`<name>.json`, effect/ai's Prompt) is converted the first
// time it is read and kept beside as `<name>.json.bak`.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

// Replay is the transcript a session file amounts to, compactions applied.
func Replay(lines []agentcore.AgentMessage) []agentcore.AgentMessage {
	out := []agentcore.AgentMessage{}
	for _, m := range lines {
		if s, ok := m.(CompactionSummaryMessage); ok {
			next := []agentcore.AgentMessage{s}
			if s.Kept > 0 && len(out) > 0 {
				next = append(next, out[max(0, len(out)-s.Kept):]...)
			}
			out = next
			continue
		}
		out = append(out, m)
	}
	return out
}

func parseLines(text string) []agentcore.AgentMessage {
	var out []agentcore.AgentMessage
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		var head struct {
			Role *string `json:"role"`
		}
		// A line cut off by a crash: the rest still reads.
		if json.Unmarshal([]byte(line), &head) != nil || head.Role == nil {
			continue
		}
		m, err := DecodeMessage([]byte(line))
		if err != nil {
			continue
		}
		out = append(out, m)
	}
	return out
}

// OldPart is a part of an effect/ai Prompt message.
type OldPart struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Params    any    `json:"params,omitempty"`
	Result    any    `json:"result,omitempty"`
	IsFailure bool   `json:"isFailure,omitempty"`
}

// OldPrompt is an effect/ai Prompt as the old session files hold it.
type OldPrompt struct {
	Content []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"content"`
}

// FromOldPrompt is an effect/ai Prompt as messages.
func FromOldPrompt(prompt OldPrompt) []agentcore.AgentMessage {
	out := []agentcore.AgentMessage{}
	at := time.Now().UnixMilli()
	parts := func(raw json.RawMessage) []OldPart {
		var text string
		if json.Unmarshal(raw, &text) == nil {
			return []OldPart{{Type: "text", Text: text}}
		}
		var list []OldPart
		_ = json.Unmarshal(raw, &list)
		return list
	}
	for _, m := range prompt.Content {
		switch m.Role {
		case "user":
			var texts []string
			for _, p := range parts(m.Content) {
				texts = append(texts, p.Text)
			}
			out = append(out, ai.UserMessage{Content: ai.StringContent(strings.Join(texts, "\n")), Timestamp: at})
		case "assistant":
			content := []ai.Content{}
			stop := ai.StopStop
			for _, p := range parts(m.Content) {
				switch {
				case p.Type == "reasoning" && p.Text != "":
					content = append(content, ai.NewThinking(p.Text))
				case p.Type == "text" && p.Text != "":
					content = append(content, ai.NewText(p.Text))
				case p.Type == "tool-call" && p.ID != "" && p.Name != "":
					args := json.RawMessage("{}")
					if p.Params != nil {
						args = json.RawMessage(ai.Stringify(p.Params))
					}
					content = append(content, ai.NewToolCall(p.ID, p.Name, args))
					stop = ai.StopToolUse
				}
			}
			out = append(out, ai.AssistantMessage{Content: content, API: "openai-completions", Provider: "deepseek", Usage: ai.EmptyUsage(), StopReason: stop, Timestamp: at})
		case "tool":
			for _, p := range parts(m.Content) {
				if p.Type != "tool-result" || p.ID == "" {
					continue
				}
				text, ok := p.Result.(string)
				if !ok {
					text = ai.Stringify(p.Result)
				}
				out = append(out, ai.ToolResultMessage{ToolCallID: p.ID, ToolName: p.Name, Content: []ai.Content{ai.NewText(text)}, IsError: p.IsFailure, Timestamp: at})
			}
		}
	}
	return out
}

// Session is a conversation on disk.
type Session interface {
	// Load is the transcript to go on with.
	Load() []agentcore.AgentMessage
	Append(message agentcore.AgentMessage) error
	// Clear forgets it all.
	Clear() error
}

type fileSession struct {
	file string
	mu   sync.Mutex
}

// SessionAt is the session at file (`.jsonl`).
func SessionAt(file string) Session { return &fileSession{file: file} }

func (s *fileSession) Load() []agentcore.AgentMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	if text, err := os.ReadFile(s.file); err == nil {
		return Replay(parseLines(string(text)))
	}
	old := strings.TrimSuffix(s.file, ".jsonl") + ".json"
	before, err := os.ReadFile(old)
	if err != nil {
		return []agentcore.AgentMessage{}
	}
	var prompt OldPrompt
	if json.Unmarshal(before, &prompt) != nil {
		return []agentcore.AgentMessage{}
	}
	messages := FromOldPrompt(prompt)
	var b strings.Builder
	for _, m := range messages {
		b.WriteString(ai.Stringify(m))
		b.WriteByte('\n')
	}
	if os.MkdirAll(filepath.Dir(s.file), 0o755) == nil && os.WriteFile(s.file, []byte(b.String()), 0o644) == nil {
		_ = os.Rename(old, old+".bak")
	}
	return messages
}

func (s *fileSession) Append(message agentcore.AgentMessage) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(s.file, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString(ai.Stringify(message) + "\n")
	return err
}

func (s *fileSession) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.file, nil, 0o644)
}
