package observe_test

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
	"time"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// ─── Shared fixtures for the fold tests (prefix fx) ────────────────────────

func fxAny(t *testing.T, value any) any {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var out any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	return out
}

func fxParse(t *testing.T, text string) any {
	t.Helper()
	var out any
	if err := json.Unmarshal([]byte(text), &out); err != nil {
		t.Fatalf("bad expectation %s: %v", text, err)
	}
	return out
}

// fxEqual is toEqual: got, as JSON, equals want.
func fxEqual(t *testing.T, got any, want string, what ...any) {
	t.Helper()
	g, w := fxAny(t, got), fxParse(t, want)
	if !reflect.DeepEqual(g, w) {
		t.Errorf("%s\n got: %s\nwant: %s", fmt.Sprint(what...), fxShow(g), fxShow(w))
	}
}

// fxMatch is toMatchObject: every key of want is in got with a matching
// value; arrays match element-wise with the same length.
func fxMatch(t *testing.T, got any, want string, what ...any) {
	t.Helper()
	g, w := fxAny(t, got), fxParse(t, want)
	if path, ok := fxSubset(g, w, "$"); !ok {
		t.Errorf("%s: mismatch at %s\n got: %s\nwant: %s", fmt.Sprint(what...), path, fxShow(g), fxShow(w))
	}
}

func fxSubset(got, want any, path string) (string, bool) {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return path, false
		}
		for key, value := range w {
			gv, present := g[key]
			if !present {
				return path + "." + key, false
			}
			if p, ok := fxSubset(gv, value, path+"."+key); !ok {
				return p, false
			}
		}
		return "", true
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return path, false
		}
		for i := range w {
			if p, ok := fxSubset(g[i], w[i], fmt.Sprintf("%s[%d]", path, i)); !ok {
				return p, false
			}
		}
		return "", true
	default:
		return path, reflect.DeepEqual(got, want)
	}
}

func fxShow(value any) string {
	data, _ := json.Marshal(value)
	return string(data)
}

func fxHas(t *testing.T, value any, key string) bool {
	t.Helper()
	m, ok := fxAny(t, value).(map[string]any)
	if !ok {
		t.Fatalf("not an object: %v", value)
	}
	_, present := m[key]
	return present
}

// fxSession is an AdapterSession over a kernel that accepts every control
// (the TS tests' sessionOver / fixture).
type fxSession struct {
	k       *kernel.Kernel
	dispose func()
}

func (s *fxSession) ID() string { return s.k.SessionID() }
func (s *fxSession) Capabilities() oar.SessionCapabilities {
	return oar.SessionCapabilities{Attribution: "nested"}
}
func (s *fxSession) control(body oar.RequestBody) (oar.ControlResult, error) {
	return s.k.Control(body, func(oar.RawEvent) (oar.ResponseBody, error) { return oar.Accepted(), nil }, kernel.RecordAt{}), nil
}
func (s *fxSession) Prompt(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	return s.control(oar.RequestBody{Kind: oar.RequestPrompt, Input: input, InputID: options.InputID})
}
func (s *fxSession) Queue(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	return s.control(oar.RequestBody{Kind: oar.RequestQueue, Input: input, InputID: options.InputID})
}
func (s *fxSession) Abort(context.Context) (oar.ControlResult, error) {
	return s.control(oar.RequestBody{Kind: oar.RequestAbort})
}
func (s *fxSession) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.k.RawEvents(observer, cursor)
}
func (s *fxSession) Records() []oar.RawEvent { return s.k.Records() }
func (s *fxSession) Graph() oar.SessionGraph { return s.k.Graph() }
func (s *fxSession) Dispose(context.Context) error {
	if s.dispose != nil {
		s.dispose()
	}
	return nil
}

func fxSealed(k *kernel.Kernel) oar.Session { return kernel.Seal(&fxSession{k: k}) }

func fxCtx(t *testing.T) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func fxBody(kind string, events ...oar.EventBody) oar.FrameBody {
	return oar.FrameBody{Type: kind, Native: json.RawMessage("{}"), Events: events}
}

func fxAt(sessionID string, path ...string) kernel.RecordAt {
	return kernel.RecordAt{SessionID: sessionID, AgentPath: path}
}

// fxClock is a kernel clock returning 0, 10, 20… per record (receivedAt = seq*10).
func fxClock() kernel.Option {
	var n int64
	return kernel.WithClock(func() int64 {
		value := n * 10
		n++
		return value
	})
}

// ─── observe-folds.test.ts ─────────────────────────────────────────────────

const fxRoot = "root-thread"
const fxChild = "child-thread"

func fxUsage(input, output int64) oar.EventBody {
	tokens := input
	return oar.Usage{Usage: oar.UsageReport{Context: &oar.ContextUsage{Tokens: &tokens}, Tokens: &oar.TokenTotals{Input: input, Output: output}}}
}

func fxLink(k *kernel.Kernel, edge oar.SessionEdge) {
	k.Frame(oar.FrameBody{Type: "synthetic/lineage", Native: json.RawMessage(`{}`), Events: []oar.EventBody{k.Link(edge)}}, kernel.RecordAt{})
}

func fxTurnEnded(outcome oar.TurnOutcome) oar.FrameBody {
	return fxBody("turn/completed", oar.TurnEnded{Outcome: outcome})
}

func fxChildTurnEndsFirst(t *testing.T, k *kernel.Kernel, afterSeq int64) {
	t.Helper()
	fxLink(k, oar.SessionEdge{Parent: fxRoot, Child: fxChild, Via: "tool_call"})
	childEnd := k.Frame(fxTurnEnded(oar.Completed()), fxAt(fxChild))
	if childEnd.SessionID != fxChild || len(childEnd.AgentPath) != 0 {
		t.Fatalf("child end envelope %+v", childEnd.Envelope)
	}
	if got := observe.TurnEndAfter(k.Records(), afterSeq, fxRoot, ""); got != nil {
		t.Fatalf("the child's turn end is not the root's: %+v", got)
	}
	if got := observe.TurnEndAfter(k.Records(), afterSeq, "", ""); got == nil || got.Kind != "completed" {
		t.Fatalf("unscoped, any root-agent turn end counts: %+v", got)
	}
}

func TestFoldsChildTurnEndDoesNotEndRootTurn(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	prompt, err := session.Prompt(fxCtx(t), "spawn a child", oar.InputOptions{})
	if err != nil {
		t.Fatal(err)
	}
	fxChildTurnEndsFirst(t, k, prompt.Request.Seq)
	done := make(chan oar.TurnOutcome, 1)
	go func() {
		outcome, _ := observe.AwaitTurnEnd(fxCtx(t), session, prompt.Request.Seq, "")
		done <- outcome
	}()
	select {
	case outcome := <-done:
		t.Fatalf("awaitTurnEnd settled on the child: %+v", outcome)
	case <-time.After(50 * time.Millisecond):
	}
	k.Frame(fxTurnEnded(oar.AbortedOutcome()), kernel.RecordAt{})
	fxEqual(t, <-done, `{"kind":"aborted"}`, "it resolves on the root session's own turn end")
}

func fxRootAndChildReport(k *kernel.Kernel) {
	k.Frame(fxBody("thread/start", oar.Model{Model: "root-model"}), kernel.RecordAt{})
	k.Frame(fxBody("thread/tokenUsage/updated", fxUsage(100, 10)), kernel.RecordAt{})
	k.Frame(fxBody("thread/start", oar.Model{Model: "child-model"}, k.Link(oar.SessionEdge{Parent: fxRoot, Child: fxChild, Via: "tool_call"})), fxAt(fxChild))
	k.Frame(fxBody("thread/tokenUsage/updated", fxUsage(500, 50)), fxAt(fxChild))
}

func TestFoldsEffortLatestRootReport(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	fxEqual(t, session.Effort(), `{"value":null,"seq":-1}`, "null before the runtime said anything")
	k.Frame(fxBody("thread/start", oar.Model{Model: "root-model"}, oar.Effort{Effort: "low"}), kernel.RecordAt{})
	k.Frame(fxBody("thread/start", oar.Effort{Effort: "xhigh"}), fxAt(fxChild))
	fxEqual(t, session.Effort(), `{"value":"low","seq":0}`)
	k.Frame(fxBody("thread/settings/updated", oar.Effort{Effort: "high"}), kernel.RecordAt{})
	fxEqual(t, session.Effort(), `{"value":"high","seq":2}`)
	fxEqual(t, observe.EffortOf(session.Records(), fxChild).Value, `"xhigh"`, "the child's own report is in its own records")
}

func TestFoldsModelUsageContextRootOnly(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	fxRootAndChildReport(k)
	fxEqual(t, session.Model().Value, `"root-model"`)
	fxEqual(t, session.Usage().Value, `{"total":{"input":100,"output":10},"withChildren":{"input":600,"output":60}}`, "withChildren adds the child")
	fxEqual(t, session.ContextUsage().Value, `{"tokens":100,"contextWindow":null,"percent":null}`)
	if seq := session.Model().Seq; seq != 1 {
		t.Errorf("model fold rests on the last root record consumed: %d", seq)
	}
	if seq := session.Usage().Seq; seq != 3 {
		t.Errorf("usage fold rests on the last record consumed, the derived child's included: %d", seq)
	}
	if seq := session.ContextUsage().Seq; seq != 1 {
		t.Errorf("context fold rests on the last root record consumed: %d", seq)
	}
	records := session.Records()
	fxEqual(t, observe.ModelOf(records, fxChild).Value, `"child-model"`, "the child's own answers are in its own records")
	fxEqual(t, observe.UsageOf(records, fxChild, nil).Value, `{"total":{"input":500,"output":50}}`)
	fxEqual(t, observe.ContextUsageOf(records, fxChild).Value, `{"tokens":500,"contextWindow":null,"percent":null}`)
	fxEqual(t, observe.UsageOf(records, "", nil).Value, `{"total":{"input":500,"output":50}}`, "unscoped, both sessions collide on agentPath []")

	k.Frame(fxBody("thread/tokenUsage/updated", fxUsage(120, 12)), fxAt("", "worker"))
	fxEqual(t, session.Usage().Value, `{"total":{"input":220,"output":22},"byAgent":[
		{"agentPath":[],"tokens":{"input":100,"output":10}},
		{"agentPath":["worker"],"tokens":{"input":120,"output":12}}],
		"withChildren":{"input":720,"output":72}}`, "sub-agents of this session still aggregate")
}

func fxReports(k *kernel.Kernel, sessionID string, input, output int64) {
	at := kernel.RecordAt{}
	if sessionID != fxRoot {
		at.SessionID = sessionID
	}
	k.Frame(fxBody("thread/tokenUsage/updated", fxUsage(input, output)), at)
}

func fxFamily() (*kernel.Kernel, oar.Session) {
	k := kernel.New(fxRoot)
	for _, pair := range [][2]string{{fxRoot, "a"}, {fxRoot, "b"}, {"a", "c"}, {"b", "c"}} {
		fxLink(k, oar.SessionEdge{Parent: pair[0], Child: pair[1], Via: "tool_call"})
	}
	reported := []struct {
		id            string
		input, output int64
	}{{fxRoot, 100, 10}, {"a", 20, 2}, {"b", 3, 1}, {"c", 7, 1}, {"a", 30, 3}, {"stray", 1000, 100}}
	for _, r := range reported {
		fxReports(k, r.id, r.input, r.output)
	}
	return k, fxSealed(k)
}

func TestFoldsWithChildrenAbsentUntilAChildReports(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	fxReports(k, fxRoot, 100, 10)
	fxLink(k, oar.SessionEdge{Parent: fxRoot, Child: "a", Via: "tool_call"})
	fxLink(k, oar.SessionEdge{Parent: fxRoot, Child: "b", Via: "tool_call"})
	if session.Usage().Value.WithChildren != nil {
		t.Fatal("withChildren before any child reported")
	}
	fxReports(k, "a", 20, 2)
	fxEqual(t, session.Usage().Value, `{"total":{"input":100,"output":10},"withChildren":{"input":120,"output":12}}`)
}

func TestFoldsWithChildrenCountsEachDescendantOnce(t *testing.T) {
	_, session := fxFamily()
	fxEqual(t, session.Usage().Value, `{"total":{"input":100,"output":10},"withChildren":{"input":140,"output":15}}`, "a 30, b 3 and c 7 once each")
	graph := session.Graph()
	fxEqual(t, observe.UsageOf(session.Records(), "a", &graph).Value, `{"total":{"input":30,"output":3},"withChildren":{"input":37,"output":4}}`)
	fxEqual(t, observe.UsageOf(session.Records(), fxRoot, nil).Value, fxShow(fxAny(t, session.Usage().Value)), "lineage comes from records by default")
	empty := oar.SessionGraph{}
	fxEqual(t, observe.UsageOf(session.Records(), fxRoot, &empty).Value, `{"total":{"input":100,"output":10}}`, "an explicit graph overrides recorded lineage")
}

func TestFoldsWithChildrenAbsentWhileOwnTotalUnknown(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	ten := int64(10)
	k.Frame(fxBody("thread/tokenUsage/updated", oar.Usage{Usage: oar.UsageReport{Context: &oar.ContextUsage{Tokens: &ten}}}), kernel.RecordAt{})
	fxLink(k, oar.SessionEdge{Parent: fxRoot, Child: fxChild, Via: "tool_call"})
	k.Frame(fxBody("thread/tokenUsage/updated", fxUsage(500, 50)), fxAt(fxChild))
	fxEqual(t, session.Usage().Value, `{"total":null}`)
}

func fxTotals(input, output int64, cache ...int64) *oar.TokenTotals {
	totals := &oar.TokenTotals{Input: input, Output: output}
	if len(cache) > 0 {
		totals.CacheRead = oar.Int64(cache[0])
	}
	if len(cache) > 1 {
		totals.CacheWrite = oar.Int64(cache[1])
	}
	return totals
}

func TestFoldsReportedSessionTotalAndUnattributed(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	k.Frame(fxBody("result", oar.Usage{Usage: oar.UsageReport{Tokens: fxTotals(100, 10, 60, 30), Total: fxTotals(100, 10, 60, 30)}}), kernel.RecordAt{})
	fxEqual(t, session.Usage().Value, `{"total":{"input":100,"output":10,"cacheRead":60,"cacheWrite":30}}`, "all of it the root's")
	k.Frame(fxBody("result", oar.Usage{Usage: oar.UsageReport{Tokens: fxTotals(150, 15, 80, 40), Total: fxTotals(400, 25, 200, 90)}}), kernel.RecordAt{})
	fxEqual(t, session.Usage().Value, `{"total":{"input":400,"output":25,"cacheRead":200,"cacheWrite":90},
		"byAgent":[{"agentPath":[],"tokens":{"input":150,"output":15,"cacheRead":80,"cacheWrite":40}}],
		"unattributed":{"input":250,"output":10,"cacheRead":120,"cacheWrite":50}}`)
	one := int64(1)
	k.Frame(fxBody("result", oar.Usage{Usage: oar.UsageReport{Context: &oar.ContextUsage{Tokens: &one}}}), kernel.RecordAt{})
	fxEqual(t, session.Usage().Value.Total, `{"input":400,"output":25,"cacheRead":200,"cacheWrite":90}`, "a later frame without a total keeps the last one")
}

func TestFoldsCachePartsSumOverReportingAgents(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	tokens := func(totals *oar.TokenTotals) oar.FrameBody {
		return fxBody("result", oar.Usage{Usage: oar.UsageReport{Tokens: totals}})
	}
	k.Frame(tokens(fxTotals(100, 10, 60, 30)), kernel.RecordAt{})
	fxEqual(t, session.Usage().Value, `{"total":{"input":100,"output":10,"cacheRead":60,"cacheWrite":30}}`)
	k.Frame(tokens(fxTotals(40, 4, 25)), fxAt("", "worker"))
	k.Frame(tokens(fxTotals(9, 1)), fxAt("", "reader"))
	fxEqual(t, session.Usage().Value, `{"total":{"input":149,"output":15,"cacheRead":85,"cacheWrite":30},"byAgent":[
		{"agentPath":[],"tokens":{"input":100,"output":10,"cacheRead":60,"cacheWrite":30}},
		{"agentPath":["worker"],"tokens":{"input":40,"output":4,"cacheRead":25}},
		{"agentPath":["reader"],"tokens":{"input":9,"output":1}}]}`)
	plain := kernel.New(fxRoot)
	plain.Frame(tokens(fxTotals(9, 1)), kernel.RecordAt{})
	fxEqual(t, observe.UsageOf(plain.Records(), "", nil).Value, `{"total":{"input":9,"output":1}}`, "no agent reported a cache part")
}

func TestFoldsServiceTierUnknownUntilReported(t *testing.T) {
	session := fxSealed(kernel.New(fxRoot))
	fxEqual(t, session.ServiceTier(), `{"value":null,"seq":-1}`)
}

func TestFoldsServiceTierRootReportsAndReplay(t *testing.T) {
	k := kernel.New(fxRoot)
	session := fxSealed(k)
	k.Frame(fxBody("thread/start", oar.ServiceTier{ServiceTier: "priority"}), kernel.RecordAt{})
	for _, at := range []kernel.RecordAt{fxAt(fxChild), fxAt("", "subagent")} {
		k.Frame(fxBody("child", oar.ServiceTier{ServiceTier: "flex"}), at)
	}
	fxEqual(t, session.ServiceTier(), `{"value":"priority","seq":2}`)
	k.Frame(fxBody("thread/settings/updated", oar.ServiceTier{ServiceTier: "default"}), kernel.RecordAt{})
	fxEqual(t, session.ServiceTier(), `{"value":"default","seq":3}`)
	data, _ := json.Marshal(session.Records())
	var records []oar.RawEvent
	if err := json.Unmarshal(data, &records); err != nil {
		t.Fatal(err)
	}
	fxEqual(t, observe.ServiceTierOf(records, fxRoot), fxShow(fxAny(t, session.ServiceTier())))
}

// fxJSONRoundTrip is the host's persistence boundary: records through JSON.
func fxJSONRoundTrip(t *testing.T, records []oar.RawEvent) []oar.RawEvent {
	t.Helper()
	data, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	var out []oar.RawEvent
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatal(err)
	}
	return out
}
