package brain

// A compaction is a line too: reading the file back, a `compactionSummary` stands in for everything before it except its `kept` most recent messages.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

func Replay(lines []agentcore.AgentMessage) []agentcore.AgentMessage {
	out := []agentcore.AgentMessage{}
	for _, m := range lines {
		if s, ok := m.(CompactionSummaryMessage); ok {
			out = applySummary(out, s)
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

type Session struct {
	file string
	mu   sync.Mutex
}

func SessionAt(file string) *Session { return &Session{file: file} }

func (s *Session) Load() []agentcore.AgentMessage {
	s.mu.Lock()
	defer s.mu.Unlock()
	if text, err := os.ReadFile(s.file); err == nil {
		return Replay(parseLines(string(text)))
	}
	return []agentcore.AgentMessage{}
}

func (s *Session) Append(message agentcore.AgentMessage) error {
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

func (s *Session) Clear() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := os.MkdirAll(filepath.Dir(s.file), 0o755); err != nil {
		return err
	}
	return os.WriteFile(s.file, nil, 0o644)
}
