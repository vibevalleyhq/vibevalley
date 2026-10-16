//go:build wip_a

package claude

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-context-breakdown.test.ts: Session.ContextBreakdown
// (oar#262), claude's get_context_usage with detail "full", asked now and never recorded.

// The shape claude 2.1.292 answered mid-turn with one MCP server under tool search.
const breakdownAnswer = `{
  "categories": [
    {"name":"System prompt","tokens":2375,"color":"promptBorder","kind":"used"},
    {"name":"System tools","tokens":4225,"color":"inactive","kind":"used"},
    {"name":"MCP server instructions","tokens":717,"color":"cyan_FOR_SUBAGENTS_ONLY","kind":"used"},
    {"name":"MCP tools","tokens":120,"color":"cyan_FOR_SUBAGENTS_ONLY","kind":"used"},
    {"name":"MCP tools (deferred)","tokens":165,"color":"inactive","isDeferred":true,"kind":"deferred"},
    {"name":"Memory files","tokens":111,"color":"claude","kind":"used"},
    {"name":"Skills","tokens":556,"color":"warning","kind":"used"},
    {"name":"Messages","tokens":8801,"color":"purple_FOR_SUBAGENTS_ONLY","kind":"used"},
    {"name":"Autocompact buffer","tokens":33000,"color":"inactive","kind":"buffer"},
    {"name":"Free space","tokens":950095,"color":"promptBorder","kind":"free"}
  ],
  "totalTokens":16905,
  "maxTokens":1000000,
  "gridRows":[[{"color":"promptBorder","isFilled":true,"categoryName":"System prompt","tokens":2375}]],
  "memoryFiles":[{"path":"/home/user/.claude/CLAUDE.md","type":"User","tokens":111}],
  "mcpTools":[
    {"name":"mcp__echo__echo","serverName":"echo","tokens":120,"isLoaded":true},
    {"name":"mcp__docs__search","serverName":"docs","tokens":165,"isLoaded":false}
  ],
  "agents":[],
  "skills":{"totalSkills":2,"includedSkills":2,"tokens":556,"skillFrontmatter":[{"name":"dataviz","source":"built-in","tokens":482},{"name":"frontend-design","source":"userSettings","tokens":74}]}
}`

func answerRecord() jsonx.Record { return jsonx.ParseRecord([]byte(breakdownAnswer)) }

func withCategories(filter func(jsonx.Record) bool, extra ...any) jsonx.Record {
	answer := answerRecord()
	kept := []any{}
	for _, category := range jsonx.AsRecordList(answer["categories"]) {
		if filter(category) {
			kept = append(kept, category)
		}
	}
	answer["categories"] = append(kept, extra...)
	return answer
}

func itemsByName(t *testing.T, payload jsonx.Record) map[string][]oar.ContextItem {
	t.Helper()
	breakdown, err := claudeContextBreakdown(payload)
	if err != nil {
		t.Fatal(err)
	}
	items := map[string][]oar.ContextItem{}
	for _, category := range breakdown.Categories {
		items[category.Name] = category.Items
	}
	return items
}

func TestCategoriesStayInClaudesOrderAndWordsAndItsKindsAreOARs(t *testing.T) {
	answer := withCategories(func(jsonx.Record) bool { return true }, map[string]any{"name": "Something new", "tokens": 5, "kind": "pinned"})
	breakdown, err := claudeContextBreakdown(answer)
	if err != nil {
		t.Fatal(err)
	}
	if breakdown.Tokens != 16_905 || breakdown.ContextWindow != 1_000_000 {
		t.Fatalf("totals = %d %d", breakdown.Tokens, breakdown.ContextWindow)
	}
	var pairs [][2]string
	for _, category := range breakdown.Categories {
		pairs = append(pairs, [2]string{category.Name, category.Kind})
	}
	assertJSON(t, pairs, `[["System prompt","used"],["System tools","used"],["MCP server instructions","used"],["MCP tools","used"],
		["MCP tools (deferred)","deferred"],["Memory files","used"],["Skills","used"],["Messages","used"],
		["Autocompact buffer","reserved"],["Free space","free"],["Something new","unknown"]]`)
	// The sums hold as documented: used = tokens; all but deferred = the window.
	sum := func(kinds ...string) int64 {
		var total int64
		for _, category := range jsonx.AsRecordList(answerRecord()["categories"]) {
			for _, kind := range kinds {
				if category["kind"] == kind {
					value, _ := jsonx.Num(category, "tokens")
					total += int64(value)
				}
			}
		}
		return total
	}
	if sum("used") != breakdown.Tokens || sum("used", "buffer", "free") != breakdown.ContextWindow {
		t.Fatal("sums do not hold")
	}
}

func TestClaudesListsItemizeTheCategoryEachMakesUp(t *testing.T) {
	items := itemsByName(t, answerRecord())
	assertJSON(t, items["Memory files"], `[{"name":"/home/user/.claude/CLAUDE.md","tokens":111}]`)
	assertJSON(t, items["MCP tools"], `[{"name":"mcp__echo__echo","tokens":120}]`)
	assertJSON(t, items["MCP tools (deferred)"], `[{"name":"mcp__docs__search","tokens":165}]`)
	assertJSON(t, items["Skills"], `[{"name":"dataviz","tokens":482},{"name":"frontend-design","tokens":74}]`)
	// No list, or an empty one (no custom agents), leaves the category without items.
	if items["Messages"] != nil {
		t.Fatalf("Messages items = %v", items["Messages"])
	}
	breakdown, _ := claudeContextBreakdown(answerRecord())
	if strings.Contains(jsonText(breakdown), `"Messages","tokens":8801,"kind":"used","items"`) {
		t.Fatal("Messages carries items")
	}
}

func TestWithOneMCPCategoryEveryMCPToolGoesUnderIt(t *testing.T) {
	// claude 2.1.292 with tool search off: only MCP tools (used), its tool isLoaded false.
	items := itemsByName(t, withCategories(func(category jsonx.Record) bool { return category["name"] != "MCP tools (deferred)" }))
	assertJSON(t, items["MCP tools"], `[{"name":"mcp__echo__echo","tokens":120},{"name":"mcp__docs__search","tokens":165}]`)
	// Tool search on: only the deferred category.
	deferred := itemsByName(t, withCategories(func(category jsonx.Record) bool { return category["name"] != "MCP tools" }))
	assertJSON(t, deferred["MCP tools (deferred)"], `[{"name":"mcp__echo__echo","tokens":120},{"name":"mcp__docs__search","tokens":165}]`)
}

func TestAnAnswerWithoutTotalsIsAnError(t *testing.T) {
	_, err := claudeContextBreakdown(jsonx.Record{"categories": []any{}})
	if err == nil || !regexp.MustCompile(`totalTokens or maxTokens`).MatchString(err.Error()) {
		t.Fatalf("err = %v", err)
	}
}

// scriptedBreakdown answers get_context_usage with answer, or with an error when it is a string.
func scriptedBreakdown(answer any) *fakeProcess {
	return newFakeProcess(func(line string, process *fakeProcess) {
		request := jsonx.ParseRecord([]byte(line))
		if jsonx.AsRecord(request["request"])["subtype"] != "get_context_usage" {
			return
		}
		response := map[string]any{"subtype": "success", "request_id": request["request_id"], "response": answer}
		if text, ok := answer.(string); ok {
			response = map[string]any{"subtype": "error", "request_id": request["request_id"], "error": text}
		}
		process.emitJSON(map[string]any{"type": "control_response", "response": response})
	})
}

func asked(writes []string) []jsonx.Record {
	out := []jsonx.Record{}
	for _, line := range writes {
		request := jsonx.AsRecord(jsonx.ParseRecord([]byte(line))["request"])
		if request["subtype"] == "get_context_usage" {
			out = append(out, request)
		}
	}
	return out
}

func TestAsksForTheFullAnswerSharesAReadInFlightAndRecordsNothing(t *testing.T) {
	fake := scriptedBreakdown(answerRecord())
	useFakeSpawner(t, fake)
	ctx := testContext(t)
	session, err := Session(ctx, oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.292"}, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	before := len(session.Records())
	var wait sync.WaitGroup
	results := make([]*oar.ContextBreakdown, 2)
	for index := range results {
		wait.Add(1)
		go func() {
			defer wait.Done()
			breakdown, err := session.ContextBreakdown(ctx)
			if err != nil {
				t.Error(err)
			}
			results[index] = breakdown
		}()
	}
	wait.Wait()
	if results[0] == nil || len(results[0].Categories) != 10 {
		t.Fatalf("first = %+v", results[0])
	}
	if results[1] != results[0] {
		t.Fatal("the second read did not share the first")
	}
	assertJSON(t, asked(fake.writes()), `[{"subtype":"get_context_usage","detail":"full"}]`)
	if len(session.Records()) != before {
		t.Fatal("the read was recorded")
	}
	encoded, _ := json.Marshal(session.Records())
	if strings.Contains(string(encoded), "CLAUDE.md") {
		t.Fatal("records contain the answer")
	}
	_ = session.Dispose(ctx)
}

func TestClaudesRefusalRejectsWithItsWords(t *testing.T) {
	fake := scriptedBreakdown("get_context_usage is not supported in this context")
	useFakeSpawner(t, fake)
	ctx := testContext(t)
	session, err := Session(ctx, testInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	_, err = session.ContextBreakdown(ctx)
	if err == nil || !strings.Contains(err.Error(), "not supported in this context") {
		t.Fatalf("err = %v", err)
	}
	_ = session.Dispose(ctx)
}

// slowExit is a real claude's shape: Kill ends stdin at once, and the exit comes later.
type slowExit struct {
	*fakeProcess
	mu         sync.Mutex
	stdinEnded bool
	t          *testing.T
}

func (s *slowExit) Write(text string) {
	s.mu.Lock()
	ended := s.stdinEnded
	s.mu.Unlock()
	if ended {
		s.t.Error(errors.New("write after end"))
		return
	}
	s.fakeProcess.Write(text)
}

func (s *slowExit) Kill() {
	s.mu.Lock()
	s.stdinEnded = true
	s.mu.Unlock()
}

func TestNilFromTheMomentDisposeBeginsWithoutWritingToTheEndedStdin(t *testing.T) {
	fake := scriptedBreakdown(answerRecord())
	child := &slowExit{fakeProcess: fake, t: t}
	useProcess(t, child)
	ctx := testContext(t)
	session, err := Session(ctx, testInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	disposed := make(chan error, 1)
	go func() { disposed <- session.Dispose(ctx) }()
	eventually(t, "dispose recorded", func() bool {
		for _, record := range session.Records() {
			if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestDispose {
				return true
			}
		}
		return false
	})
	breakdown, err := session.ContextBreakdown(ctx)
	if err != nil || breakdown != nil {
		t.Fatalf("breakdown = %v %v", breakdown, err)
	}
	if len(asked(fake.writes())) != 0 {
		t.Fatal("asked after dispose")
	}
	fake.end(nil)
	if err := <-disposed; err != nil {
		t.Fatal(err)
	}
}

// TS ends the child's stdin by hand to stand for the abort fallback's kill;
// Go has no stdin handle, so the fallback's own kill ends it here: an abort
// claude never answers, past a shortened fallback deadline.
func TestNilOnceStdinHasEndedWithoutADispose(t *testing.T) {
	previous := abortFallbackTimeout
	abortFallbackTimeout = 50 * time.Millisecond
	t.Cleanup(func() { abortFallbackTimeout = previous })
	fake := scriptedBreakdown(answerRecord())
	child := &slowExit{fakeProcess: fake, t: t}
	useProcess(t, child)
	ctx := testContext(t)
	session, err := Session(ctx, testInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Prompt(ctx, "work", oar.InputOptions{}); err != nil {
		t.Fatal(err)
	}
	abort, err := session.Abort(ctx)
	if err != nil || !abort.IsAccepted() {
		t.Fatalf("abort = %v %v", abort, err)
	}
	child.mu.Lock()
	ended := child.stdinEnded
	child.mu.Unlock()
	if !ended {
		t.Fatal("the fallback did not end stdin")
	}
	breakdown, err := session.ContextBreakdown(ctx)
	if err != nil || breakdown != nil {
		t.Fatalf("breakdown = %v %v", breakdown, err)
	}
	if len(asked(fake.writes())) != 0 {
		t.Fatal("asked after stdin ended")
	}
	fake.end(nil)
	_ = session.Dispose(ctx)
}

func TestNilOnceTheProcessHasExitedForAReadInFlightAndEveryLaterOne(t *testing.T) {
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	ctx := testContext(t)
	session, err := Session(ctx, testInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	type read struct {
		breakdown *oar.ContextBreakdown
		err       error
	}
	reading := make(chan read, 1)
	go func() {
		breakdown, err := session.ContextBreakdown(ctx)
		reading <- read{breakdown, err}
	}()
	eventually(t, "the read written", func() bool { return len(asked(fake.writes())) == 1 })
	fake.end(intPtr(1))
	if got := <-reading; got.err != nil || got.breakdown != nil {
		t.Fatalf("in flight = %v %v", got.breakdown, got.err)
	}
	if breakdown, err := session.ContextBreakdown(ctx); err != nil || breakdown != nil {
		t.Fatalf("later = %v %v", breakdown, err)
	}
	_ = session.Dispose(ctx)
}
