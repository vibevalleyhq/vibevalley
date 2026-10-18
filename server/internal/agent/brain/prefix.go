package brain

// DeepSeek caches by prefix: a request is cheap up to the first character that differs from the request before. The
// prompt's start (tools, then the system prompt) is hashed part by part on every request, so a change between two
// compactions, which costs the whole conversation at full price, is told and can be traced to its part.

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

type promptPart struct {
	name string
	text string
}

func joinParts(parts []promptPart) string {
	texts := make([]string, len(parts))
	for i, p := range parts {
		texts[i] = p.text
	}
	return strings.Join(texts, "\n\n")
}

func digest(text string) string {
	sum := sha256.Sum256([]byte(text))
	return hex.EncodeToString(sum[:])
}

// In the order told. Tools last: they are sent before the system prompt, but are told after its own parts.
var prefixParts = []string{"instructions", "env", "skills", "memory", "tools"}

func prefixHashes(parts []promptPart, tools []agentcore.AgentTool) map[string]string {
	hashes := map[string]string{}
	for _, p := range parts {
		hashes[p.name] = digest(p.text)
	}
	var b strings.Builder
	for _, t := range tools {
		tool := agentcore.ToolOf(t)
		b.WriteString(tool.Name + "\x00" + tool.Description + "\x00" + ai.Stringify(tool.Parameters) + "\x00")
	}
	hashes["tools"] = digest(b.String())
	return hashes
}

// Told as prefix_changed; the first request, and the first after a compaction, set what the next is compared with.
func (a *Agent) noteChanges(parts []promptPart, tools []agentcore.AgentTool) {
	hashes := prefixHashes(parts, tools)
	a.foldMu.Lock()
	before := a.sent
	a.sent = hashes
	a.foldMu.Unlock()
	if before == nil {
		return
	}
	var changed []string
	for _, name := range prefixParts {
		if before[name] != hashes[name] {
			changed = append(changed, name)
		}
	}
	if len(changed) > 0 {
		a.publish(PrefixChanged{Parts: changed})
	}
}
