package agent

// Named as pi-coding-agent names them: `custom` and `compactionSummary`. Both are kept in the transcript; the model reads them as a user's words
// (ConvertToLlm).

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf16"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

type CustomMessage struct {
	CustomType string
	Content    ai.UserContent
	Display    bool
	Details    any
	Timestamp  int64
}

type CompactionSummaryMessage struct {
	Summary      string
	TokensBefore int
	Timestamp    int64
	// "" when not archived.
	Archive string
	// How many messages before it in the session file stay after it, as they were.
	Kept int
}

func (CustomMessage) Role() string             { return "custom" }
func (m CustomMessage) Time() int64            { return m.Timestamp }
func (CompactionSummaryMessage) Role() string  { return "compactionSummary" }
func (m CompactionSummaryMessage) Time() int64 { return m.Timestamp }

func (m CustomMessage) MarshalJSON() ([]byte, error) {
	type wire struct {
		Role       string         `json:"role"`
		CustomType string         `json:"customType"`
		Content    ai.UserContent `json:"content"`
		Display    bool           `json:"display"`
		Details    any            `json:"details,omitempty"`
		Timestamp  int64          `json:"timestamp"`
	}
	return []byte(ai.Stringify(wire{"custom", m.CustomType, m.Content, m.Display, m.Details, m.Timestamp})), nil
}

func (m *CustomMessage) UnmarshalJSON(data []byte) error {
	var wire struct {
		CustomType string         `json:"customType"`
		Content    ai.UserContent `json:"content"`
		Display    bool           `json:"display"`
		Details    any            `json:"details"`
		Timestamp  int64          `json:"timestamp"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*m = CustomMessage(wire)
	return nil
}

func (m CompactionSummaryMessage) MarshalJSON() ([]byte, error) {
	type wire struct {
		Role         string `json:"role"`
		Summary      string `json:"summary"`
		TokensBefore int    `json:"tokensBefore"`
		Timestamp    int64  `json:"timestamp"`
		Archive      string `json:"archive,omitempty"`
		Kept         int    `json:"kept"`
	}
	return []byte(ai.Stringify(wire{"compactionSummary", m.Summary, m.TokensBefore, m.Timestamp, m.Archive, m.Kept})), nil
}

func (m *CompactionSummaryMessage) UnmarshalJSON(data []byte) error {
	var wire struct {
		Summary      string `json:"summary"`
		TokensBefore int    `json:"tokensBefore"`
		Timestamp    int64  `json:"timestamp"`
		Archive      string `json:"archive"`
		Kept         int    `json:"kept"`
	}
	if err := json.Unmarshal(data, &wire); err != nil {
		return err
	}
	*m = CompactionSummaryMessage(wire)
	return nil
}

func DecodeMessage(data []byte) (agentcore.AgentMessage, error) {
	var head struct {
		Role      string `json:"role"`
		Timestamp int64  `json:"timestamp"`
	}
	if err := json.Unmarshal(data, &head); err != nil {
		return nil, err
	}
	switch head.Role {
	case "custom":
		var m CustomMessage
		err := json.Unmarshal(data, &m)
		return m, err
	case "compactionSummary":
		var m CompactionSummaryMessage
		err := json.Unmarshal(data, &m)
		return m, err
	case "system", "user", "assistant", "toolResult":
		return ai.DecodeMessage(data)
	}
	return agentcore.UnknownMessage{RoleName: head.Role, Timestamp: head.Timestamp, Raw: append(json.RawMessage(nil), data...)}, nil
}

// Hidden is pi's display: false.
type CustomMessageOptions struct {
	Hidden  bool
	Details any
}

func NewCustomMessage(customType string, content ai.UserContent, options ...CustomMessageOptions) CustomMessage {
	var o CustomMessageOptions
	if len(options) > 0 {
		o = options[0]
	}
	return CustomMessage{CustomType: customType, Content: content, Display: !o.Hidden, Details: o.Details, Timestamp: time.Now().UnixMilli()}
}

func UserMessage(text string) agentcore.AgentMessage {
	return ai.UserMessage{Content: ai.StringContent(text), Timestamp: time.Now().UnixMilli()}
}

func SummaryText(m CompactionSummaryMessage) string {
	where := ""
	if m.Archive != "" {
		where = "，原文在 " + m.Archive
	}
	return "【之前的对话压成了下面的摘要" + where + "】\n<summary>\n" + m.Summary + "\n</summary>"
}

func ConvertToLlm(_ context.Context, messages []agentcore.AgentMessage) []ai.Message {
	out := []ai.Message{}
	for _, m := range messages {
		switch m := m.(type) {
		case CustomMessage:
			out = append(out, ai.UserMessage{Content: m.Content, Timestamp: m.Timestamp})
		case CompactionSummaryMessage:
			out = append(out, ai.UserMessage{Content: ai.StringContent(SummaryText(m)), Timestamp: m.Timestamp})
		case ai.Message:
			out = append(out, m)
		}
	}
	return out
}

func blocksText(blocks []ai.Content) string {
	var b strings.Builder
	for _, c := range blocks {
		switch c.Type {
		case ai.TypeText:
			b.WriteString(c.Text)
		case ai.TypeImage:
			b.WriteString("[图片]")
		}
	}
	return b.String()
}

func contentWords(c ai.UserContent) string {
	if !c.IsBlocks() {
		return c.Text
	}
	return blocksText(c.Blocks)
}

func MessageText(m agentcore.AgentMessage) string {
	switch m := m.(type) {
	case CompactionSummaryMessage:
		return m.Summary
	case CustomMessage:
		return contentWords(m.Content)
	case ai.SystemMessage:
		return contentWords(m.Content)
	case ai.UserMessage:
		return contentWords(m.Content)
	case ai.AssistantMessage:
		return blocksText(m.Content)
	case ai.ToolResultMessage:
		return blocksText(m.Content)
	}
	return ""
}

func LastWords(messages []agentcore.AgentMessage) string {
	for i := len(messages) - 1; i >= 0; i-- {
		m := messages[i]
		if m.Role() == "assistant" {
			if text := strings.TrimSpace(MessageText(m)); text != "" {
				return text
			}
		}
		if m.Role() == "user" || m.Role() == "custom" {
			return ""
		}
	}
	return ""
}

func Transcript(messages []agentcore.AgentMessage) string {
	var out []string
	for _, m := range messages {
		switch m := m.(type) {
		case ai.UserMessage:
			out = append(out, "## 用户\n"+MessageText(m))
		case CustomMessage:
			out = append(out, "## "+m.CustomType+"\n"+MessageText(m))
		case CompactionSummaryMessage:
			out = append(out, "## 更早的摘要\n"+m.Summary)
		case ai.AssistantMessage:
			for _, c := range m.Content {
				if c.Type == ai.TypeText && strings.TrimSpace(c.Text) != "" {
					out = append(out, "## 助手\n"+c.Text)
				}
				if c.Type == ai.TypeToolCall {
					out = append(out, "## 调用 "+c.Name+"\n"+string(c.Args()))
				}
			}
		case ai.ToolResultMessage:
			failed := ""
			if m.IsError {
				failed = "（失败）"
			}
			out = append(out, "## "+m.ToolName+" 的结果"+failed+"\n"+MessageText(m))
		}
	}
	return strings.Join(out, "\n\n")
}

// jsLength is a string's length as JavaScript counts it (UTF-16 code units).
func jsLength(s string) int { return len(utf16.Encode([]rune(s))) }

// Clamped; JS slice on text without surrogate pairs.
func runeSlice(s string, from, to int) string {
	r := []rune(s)
	from = max(0, min(from, len(r)))
	to = max(from, min(to, len(r)))
	return string(r[from:to])
}
