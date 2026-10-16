package grok

import (
	"strings"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// SpontaneousTokens reads the prompts grok injects directly into its
// session actor, outside ACP session/prompt
// (spawn.rs::inject_subagent_completed_prompt). Their terminal ledger is
// independent of RPC prompt ledgers. Never apply this to ordinary
// turn_completed or child frames; the ACP recorder enforces root attribution.
func SpontaneousTokens(method string, params jsonx.Record) *acp.SpontaneousTokens {
	if method != "_x.ai/session_notification" {
		return nil
	}
	update := jsonx.AsRecord(params["update"])
	promptID, ok := update["prompt_id"].(string)
	if update["sessionUpdate"] != "turn_completed" || !ok || !strings.HasPrefix(promptID, "subagent-completed-") || promptID == "subagent-completed-" {
		return nil
	}
	// eventId is stable across duplicate delivery. A later wake of the same
	// resumed child can reuse the prompt id, but has a different native eventId.
	meta := jsonx.AsRecord(params["_meta"])
	key, _ := meta["eventId"].(string)
	usage := jsonx.AsRecord(update["usage"])
	input, inputOK := jsonx.Num(usage, "inputTokens")
	output, outputOK := jsonx.Num(usage, "outputTokens")
	if key == "" || usage == nil || !inputOK || !outputOK {
		return nil
	}
	tokens := oar.TokenTotals{Input: int64(input), Output: int64(output)}
	shared.CacheParts(&tokens, usage, "cachedReadTokens", "cacheCreationTokens")
	shared.ReasoningPart(&tokens, usage, "reasoningTokens")
	return &acp.SpontaneousTokens{Key: key, Tokens: tokens, Replayed: meta["isReplay"] == true}
}
