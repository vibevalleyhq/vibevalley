package opencode

// Ported from tests/opencode/opencode-list-models.test.ts.

import (
	"bytes"
	"encoding/json"
	"testing"
)

// block is `opencode models --verbose` (1.18.30, cli/cmd/models.ts) for one
// model: a `provider/model` line, then `JSON.stringify(model, null, 2)`.
func block(t *testing.T, id string, model string) string {
	var indented bytes.Buffer
	if err := json.Indent(&indented, []byte(model), "", "  "); err != nil {
		t.Fatal(err)
	}
	return id + "\n" + indented.String() + "\n"
}

func TestEachModelKeepsItsProviderModelIDItsNameAndItsVariantsAsEffortLevels(t *testing.T) {
	stdout := block(t, "opencode/big-pickle", `{"id": "big-pickle", "providerID": "opencode", "name": "Big Pickle", "limit": {"context": 200000}, "variants": {}}`) +
		block(t, "anthropic/claude-haiku-4-5", `{"id": "claude-haiku-4-5", "providerID": "anthropic", "name": "Claude Haiku 4.5 (latest)",
			"variants": {"high": {"thinking": {"type": "enabled", "budgetTokens": 16000}}, "max": {"thinking": {"type": "enabled", "budgetTokens": 31999}}}}`)
	jsonEqual(t, ProjectModels(stdout), `[
		{"id": "opencode/big-pickle", "displayName": "Big Pickle", "provider": {"id": "opencode"}},
		{"id": "anthropic/claude-haiku-4-5", "displayName": "Claude Haiku 4.5 (latest)", "effortLevels": ["high", "max"], "provider": {"id": "anthropic"}}]`)
}

func TestThePlainListingAndStrayOutputYieldNoEntryWithoutAModelBody(t *testing.T) {
	for _, stdout := range []string{"opencode/big-pickle\nopencode/fledge-alpha-free\n", "Models cache refreshed\n", ""} {
		jsonEqual(t, ProjectModels(stdout), []any{})
	}
}
