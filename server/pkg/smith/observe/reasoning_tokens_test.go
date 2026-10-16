package observe_test

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// tests/reasoning-tokens.test.ts (the Grok ledger cases belong to the grok runtime port).

func rtTokens(input, output int64, reasoning ...int64) oar.TokenTotals {
	totals := oar.TokenTotals{Input: input, Output: output}
	if len(reasoning) > 0 {
		totals.Reasoning = oar.Int64(reasoning[0])
	}
	return totals
}

func TestReasoningArithmeticPreservesAbsenceAndZero(t *testing.T) {
	bare := rtTokens(10, 5)
	fxEqual(t, observe.AddTokens(bare, bare), `{"input":20,"output":10}`)
	fxEqual(t, observe.AddTokens(bare, rtTokens(10, 5, 0)), `{"input":20,"output":10,"reasoning":0}`)
	fxEqual(t, observe.AddTokens(rtTokens(10, 5, 3), bare), `{"input":20,"output":10,"reasoning":3}`)
	fxEqual(t, observe.SubtractTokens(bare, rtTokens(1, 1, 1)), `{"input":9,"output":4}`)
	fxEqual(t, observe.SubtractTokens(rtTokens(10, 5, 3), rtTokens(1, 1)), `{"input":9,"output":4,"reasoning":3}`)
}

func TestReasoningNativeSessionTotalKeepsRemainder(t *testing.T) {
	k := kernel.New("root")
	tokens, total := rtTokens(10, 5, 2), rtTokens(30, 12, 6)
	k.Frame(oar.FrameBody{Type: "usage", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.Usage{Usage: oar.UsageReport{Tokens: &tokens, Total: &total}}}}, kernel.RecordAt{})
	fxMatch(t, observe.UsageOf(k.Records(), "", nil).Value, `{"total":{"input":30,"output":12,"reasoning":6},"unattributed":{"input":20,"output":7,"reasoning":4}}`)
	fxEqual(t, observe.ViewOf(k.Records(), "").Usage, fxShow(fxAny(t, observe.UsageOf(k.Records(), "", nil).Value)))
}

func TestReasoningSumsByAgentAndChildAndSurvivesReplay(t *testing.T) {
	k := kernel.New("root")
	report := func(tokens oar.TokenTotals, sessionID string, agentPath ...string) {
		native, _ := json.Marshal(tokens)
		k.Frame(oar.FrameBody{Type: "usage", Native: native, Events: []oar.EventBody{oar.Usage{Usage: oar.UsageReport{Tokens: &tokens}}}}, kernel.RecordAt{SessionID: sessionID, AgentPath: agentPath})
	}
	report(rtTokens(10, 5, 2), "root")
	report(rtTokens(20, 7), "root", "agent")
	report(rtTokens(30, 8, 3), "child")
	report(rtTokens(40, 9, 4), "child")
	k.Frame(oar.FrameBody{Type: "lineage", Native: json.RawMessage(`{}`), Events: []oar.EventBody{k.Link(oar.SessionEdge{Parent: "root", Child: "child", Via: "tool_call"})}}, kernel.RecordAt{})
	expected := `{"total":{"input":30,"output":12,"reasoning":2},"withChildren":{"input":70,"output":21,"reasoning":6}}`
	fxMatch(t, observe.UsageOf(k.Records(), "root", nil).Value, expected)
	saved := fxJSONRoundTrip(t, k.Records())
	fxEqual(t, observe.ViewOf(saved, "").Usage, fxShow(fxAny(t, observe.UsageOf(k.Records(), "root", nil).Value)))
	fxMatch(t, observe.UsageOf(saved, "root", nil).Value, expected)
}
