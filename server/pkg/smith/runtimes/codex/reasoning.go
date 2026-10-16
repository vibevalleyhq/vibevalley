package codex

import (
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

func textParts(value any) []string {
	var parts []string
	for _, part := range jsonx.AsList(value) {
		if text, ok := jsonx.AsRecord(part)["text"].(string); ok && text != "" {
			parts = append(parts, text)
		}
	}
	return parts
}

// codexReasoningContent reads a completed raw Responses API item
// (reasoning.ts): its summary and content text, else redacted when it
// carries encrypted_content, else empty; nil for any other item.
func codexReasoningContent(item jsonx.Record) *oar.ReasoningContent {
	if item == nil || item["type"] != "reasoning" {
		return nil
	}
	text := strings.Join(append(textParts(item["summary"]), textParts(item["content"])...), "\n")
	if text != "" {
		return &oar.ReasoningContent{Kind: "text", Text: text}
	}
	if _, ok := item["encrypted_content"].(string); ok {
		return &oar.ReasoningContent{Kind: "redacted"}
	}
	return &oar.ReasoningContent{Kind: "empty"}
}
