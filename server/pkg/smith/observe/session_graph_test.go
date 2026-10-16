package observe_test

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// tests/session-graph-records.test.ts. The TS test compares inside
// synchronous rawEvents observers; Go observers run on a delivery goroutine,
// so each comparison runs right after the append instead (same instant in
// the stream).

func sgReport(k *kernel.Kernel, sessionID string, usage oar.UsageReport, agentPath ...string) oar.RawEvent {
	native, _ := json.Marshal(usage)
	return k.Frame(oar.FrameBody{Type: "fixture/usage", Native: native, Events: []oar.EventBody{oar.Usage{Usage: usage}}}, kernel.RecordAt{SessionID: sessionID, AgentPath: agentPath})
}

func sgTokens(totals *oar.TokenTotals) oar.UsageReport { return oar.UsageReport{Tokens: totals} }

func sgLink(k *kernel.Kernel, parent, child string) oar.RawEvent {
	edge := oar.SessionEdge{Parent: parent, Child: child, Via: "tool_call"}
	native, _ := json.Marshal(edge)
	return k.Frame(oar.FrameBody{Type: "fixture/lineage", Native: native, Events: []oar.EventBody{k.Link(edge)}}, kernel.RecordAt{})
}

func TestSessionGraphVisibleWithSourceFrameAndReplay(t *testing.T) {
	k := kernel.New("root")
	fxEqual(t, k.Graph(), `{"nodes":[{"id":"root"}],"edges":[]}`)
	fxEqual(t, observe.GraphOf(nil), `{"nodes":[],"edges":[]}`)
	seen := []oar.SessionGraph{}
	sgLink(k, "root", "child")
	seen = append(seen, k.Graph())
	sgLink(k, "root", "child")
	seen = append(seen, k.Graph())
	linked := `{"nodes":[{"id":"root"},{"id":"child"}],"edges":[{"parent":"root","child":"child","via":"tool_call"}]}`
	fxEqual(t, seen, `[`+linked+`,`+linked+`]`)
	persisted := fxJSONRoundTrip(t, k.Records())
	fxEqual(t, observe.GraphOf(persisted), fxShow(fxAny(t, k.Graph())))
	links := 0
	for _, record := range k.Records() {
		for _, event := range observe.EventsOf(record, nil) {
			if event.Kind() == "session_linked" {
				links++
			}
		}
	}
	if links != 2 {
		t.Fatalf("session_linked events = %d", links)
	}
}

func TestSessionGraphLiveAgreesWithReplay(t *testing.T) {
	k := kernel.New("root")
	comparisons := []bool{}
	compare := func() {
		comparisons = append(comparisons, fxShow(fxAny(t, k.Graph())) == fxShow(fxAny(t, observe.GraphOf(k.Records()))))
	}
	initial := k.Graph()
	request := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "hello"}, kernel.RecordAt{})
	compare()
	k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	compare()
	sgReport(k, "child", sgTokens(fxTotals(20, 2)))
	compare()
	beforeLink := k.Graph()
	for _, pair := range [][2]string{{"root", "child"}, {"root", "child"}, {"child", "grandchild"}} {
		sgLink(k, pair[0], pair[1])
		compare()
	}
	closing := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
	compare()
	zero := 0
	k.Respond(closing.ID, oar.ExitedBody(&zero), kernel.RecordAt{})
	compare()
	if len(comparisons) != len(k.Records()) {
		t.Fatalf("comparisons %d, records %d", len(comparisons), len(k.Records()))
	}
	for i, ok := range comparisons {
		if !ok {
			t.Fatalf("record %d: live graph differs from replay", i)
		}
	}
	fxEqual(t, initial, `{"nodes":[{"id":"root"}],"edges":[]}`)
	fxEqual(t, beforeLink, `{"nodes":[{"id":"root"},{"id":"child"}],"edges":[]}`)
	fxEqual(t, k.Graph(), fxShow(fxAny(t, observe.GraphOf(fxJSONRoundTrip(t, k.Records())))))
}

func sgFamily(k *kernel.Kernel, after func()) {
	steps := []func(){
		func() { sgReport(k, "root", sgTokens(fxTotals(100, 10, 60))) },
		// Reports can precede lineage. Repeated totals replace, never add again.
		func() { sgReport(k, "a", sgTokens(fxTotals(20, 2))) },
		func() { sgReport(k, "b", sgTokens(fxTotals(3, 1))) },
		func() {
			totals := fxTotals(7, 1)
			totals.CacheWrite = oar.Int64(2)
			sgReport(k, "c", sgTokens(totals))
		},
		func() { sgReport(k, "a", sgTokens(fxTotals(30, 3))) },
		func() { sgReport(k, "stray", sgTokens(fxTotals(1000, 100))) },
	}
	for _, pair := range [][2]string{{"root", "a"}, {"root", "b"}, {"a", "c"}, {"b", "c"}, {"a", "c"}, {"c", "root"}} {
		steps = append(steps, func() { sgLink(k, pair[0], pair[1]) })
	}
	for _, step := range steps {
		step()
		after()
	}
}

func TestSessionGraphNestedDescendantsCountOnce(t *testing.T) {
	k := kernel.New("root")
	live := observe.InitialSessionView()
	folded := 0
	sgFamily(k, func() {
		records := k.Records()
		for ; folded < len(records); folded++ {
			live = observe.ReduceSessionView(live, records[folded], "")
		}
		fxEqual(t, live.Usage, fxShow(fxAny(t, observe.UsageOf(records, "root", nil).Value)), "live view usage vs query")
	})
	expected := `{"total":{"input":100,"output":10,"cacheRead":60},"withChildren":{"input":140,"output":15,"cacheRead":60,"cacheWrite":2}}`
	fxEqual(t, live.Usage, expected)
	fxEqual(t, observe.ViewOf(fxJSONRoundTrip(t, k.Records()), "").Usage, expected)
	flat := observe.InitialSessionView()
	for _, record := range k.Records() {
		for _, event := range observe.EventsOf(record, nil) {
			flat = observe.ReduceSessionViewEvent(flat, event, "")
		}
	}
	fxEqual(t, flat.Usage, expected)
	fxEqual(t, live.SessionGraph, fxShow(fxAny(t, observe.GraphOf(k.Records()))))
}

func TestSessionGraphCheckpointRetainsTotalsBeforeLineage(t *testing.T) {
	k := kernel.New("root")
	sgReport(k, "root", sgTokens(fxTotals(10, 1)))
	sgReport(k, "child", sgTokens(fxTotals(20, 2)))
	prefix := observe.ViewOf(k.Records(), "")
	before := fxShow(fxAny(t, prefix))
	offset := len(k.Records())
	sgReport(k, "child", sgTokens(fxTotals(30, 3)))
	sgLink(k, "root", "child")
	continued := prefix
	for _, record := range k.Records()[offset:] {
		continued = observe.ReduceSessionView(continued, record, "")
	}
	fxEqual(t, prefix.Usage, `{"total":{"input":10,"output":1}}`)
	child, _ := prefix.UsageBySession.Get("child")
	var childRoot *oar.TokenTotals
	for _, agent := range child.Agents() {
		if len(agent.AgentPath) == 0 {
			tokens := agent.Tokens
			childRoot = &tokens
		}
	}
	fxEqual(t, childRoot, `{"input":20,"output":2}`)
	fxEqual(t, continued.Usage, `{"total":{"input":10,"output":1},"withChildren":{"input":40,"output":4}}`)
	fxEqual(t, continued, fxShow(fxAny(t, observe.ViewOf(k.Records(), ""))))
	fxEqual(t, prefix, before, "the earlier view is unchanged")
}

func TestSessionGraphOldRecordsNeverInventChildren(t *testing.T) {
	k := kernel.New("root")
	sgReport(k, "root", sgTokens(fxTotals(10, 1)))
	sgReport(k, "child", sgTokens(fxTotals(20, 2)))
	recorded := fxJSONRoundTrip(t, k.Records())
	fxEqual(t, observe.GraphOf(recorded), `{"nodes":[{"id":"root"},{"id":"child"}],"edges":[]}`)
	fxEqual(t, observe.UsageOf(recorded, "root", nil).Value, `{"total":{"input":10,"output":1}}`)
	fxEqual(t, observe.ViewOf(recorded, "").Usage, `{"total":{"input":10,"output":1}}`)
	graph := oar.SessionGraph{Edges: []oar.SessionEdge{{Parent: "root", Child: "child", Via: "tool_call"}}}
	fxEqual(t, observe.UsageOf(recorded, "root", &graph).Value.WithChildren, `{"input":30,"output":3}`)
}

func TestSessionGraphUnknownTotalsStayUnknown(t *testing.T) {
	k := kernel.New("root")
	sgLink(k, "root", "child")
	sgReport(k, "child", sgTokens(fxTotals(20, 2)))
	fxEqual(t, observe.ViewOf(k.Records(), "").Usage, `{"total":null}`)
	sgReport(k, "root", sgTokens(fxTotals(10, 1)))
	sgReport(k, "child", sgTokens(fxTotals(5, 1)), "agent")
	fxEqual(t, observe.ViewOf(k.Records(), "").Usage.WithChildren, `{"input":35,"output":4}`)
	sgReport(k, "child", oar.UsageReport{Total: fxTotals(50, 5)})
	tokens, window, percent := int64(999), int64(1000), float64(99)
	sgReport(k, "child", oar.UsageReport{Context: &oar.ContextUsage{Tokens: &tokens, ContextWindow: &window, Percent: &percent}})
	view := observe.ViewOf(k.Records(), "")
	fxEqual(t, view.Usage, `{"total":{"input":10,"output":1},"withChildren":{"input":60,"output":6}}`)
	fxEqual(t, view.Usage, fxShow(fxAny(t, observe.UsageOf(k.Records(), "root", nil).Value)))
	if view.Context != nil {
		t.Fatalf("context = %+v", view.Context)
	}
}

func TestSessionGraphForeignLineageFrameAdvancesUsageCursor(t *testing.T) {
	k := kernel.New("root")
	sgReport(k, "root", sgTokens(fxTotals(10, 1)))
	sgReport(k, "child", sgTokens(fxTotals(20, 2)))
	source := k.Frame(oar.FrameBody{Type: "fixture/lineage", Native: json.RawMessage(`{}`), Events: []oar.EventBody{
		k.Link(oar.SessionEdge{Parent: "root", Child: "child", Via: "tool_call"}),
		oar.Usage{Usage: sgTokens(fxTotals(1000, 100))},
	}}, kernel.RecordAt{SessionID: "reporter"})
	fxEqual(t, observe.UsageOf(k.Records(), "root", nil), `{"seq":`+fxShow(source.Seq)+`,"value":{"total":{"input":10,"output":1},"withChildren":{"input":30,"output":3}}}`)
	fxEqual(t, observe.ViewOf(k.Records(), "").Usage, fxShow(fxAny(t, observe.UsageOf(k.Records(), "root", nil).Value)))
	graph := k.Graph()
	fxEqual(t, observe.UsageOf(k.Records(), "root", &graph), fxShow(fxAny(t, observe.UsageOf(k.Records(), "root", nil))))
	empty := oar.SessionGraph{}
	fxEqual(t, observe.UsageOf(k.Records(), "root", &empty), `{"seq":0,"value":{"total":{"input":10,"output":1}}}`)
}
