package observe_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sort"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Fold parity: smith/parity/generate.ts folds record logs with the TS
// functions and writes one golden file per log; this test decodes the same
// records, runs the Go folds and compares each field semantically (both
// sides unmarshalled to `any`). Regenerate with `pnpm tsx smith/parity/generate.ts`.

const goldenDir = "../parity/golden"

type golden struct {
	Name          string          `json:"name"`
	Source        string          `json:"source"`
	RuntimeID     string          `json:"runtimeId"`
	RootSessionID string          `json:"rootSessionId"`
	Records       json.RawMessage `json:"records"`
	fields        map[string]json.RawMessage
}

// Fields the test compares; every other golden key must be metadata.
var metadata = map[string]bool{"name": true, "source": true, "runtimeId": true, "rootSessionId": true}

func loadGoldens(t *testing.T) []golden {
	t.Helper()
	paths, err := filepath.Glob(filepath.Join(goldenDir, "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) == 0 {
		t.Fatalf("no golden files in %s: run `pnpm tsx smith/parity/generate.ts` from the repo root", goldenDir)
	}
	var out []golden
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var g golden
		if err := json.Unmarshal(data, &g); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		if err := json.Unmarshal(data, &g.fields); err != nil {
			t.Fatalf("%s: %v", path, err)
		}
		out = append(out, g)
	}
	return out
}

func asAny(t *testing.T, value any) any {
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

func rawAny(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var out any
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal golden: %v", err)
	}
	return out
}

// diff lists the paths where got differs from want, at most limit of them.
func diff(path string, want, got any, out *[]string, limit int) {
	if len(*out) >= limit {
		return
	}
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: want object %s, got %s", path, short(want), short(got)))
			return
		}
		keys := map[string]bool{}
		for key := range w {
			keys[key] = true
		}
		for key := range g {
			keys[key] = true
		}
		sorted := make([]string, 0, len(keys))
		for key := range keys {
			sorted = append(sorted, key)
		}
		sort.Strings(sorted)
		for _, key := range sorted {
			wv, wok := w[key]
			gv, gok := g[key]
			switch {
			case !wok:
				*out = append(*out, fmt.Sprintf("%s.%s: unexpected, got %s", path, key, short(gv)))
			case !gok:
				*out = append(*out, fmt.Sprintf("%s.%s: missing, want %s", path, key, short(wv)))
			default:
				diff(path+"."+key, wv, gv, out, limit)
			}
			if len(*out) >= limit {
				return
			}
		}
	case []any:
		g, ok := got.([]any)
		if !ok {
			*out = append(*out, fmt.Sprintf("%s: want array %s, got %s", path, short(want), short(got)))
			return
		}
		if len(w) != len(g) {
			*out = append(*out, fmt.Sprintf("%s: want %d items, got %d", path, len(w), len(g)))
		}
		for i := 0; i < len(w) && i < len(g); i++ {
			diff(fmt.Sprintf("%s[%d]", path, i), w[i], g[i], out, limit)
		}
	default:
		if !reflect.DeepEqual(want, got) {
			*out = append(*out, fmt.Sprintf("%s: want %s, got %s", path, short(want), short(got)))
		}
	}
}

func short(value any) string {
	data, _ := json.Marshal(value)
	if len(data) > 300 {
		return string(data[:300]) + "…"
	}
	return string(data)
}

// knownGaps are mismatches whose fix belongs to package oar (not owned by
// this port), keyed "log/field", with the exact diff lines they produce. A
// gap must match exactly: any other difference in the same field fails, and
// so does the gap disappearing (remove the entry once oar is fixed).
var knownGaps = map[string][]string{}

func compare(t *testing.T, key, field string, want json.RawMessage, got any) {
	t.Helper()
	w := rawAny(t, want)
	g := asAny(t, got)
	var lines []string
	if !reflect.DeepEqual(w, g) {
		diff(field, w, g, &lines, 25)
	}
	if known, ok := knownGaps[key]; ok {
		if slices.Equal(known, lines) {
			t.Logf("known oar gap (see knownGaps): %s", strings.Join(lines, "; "))
			return
		}
		t.Errorf("%s: the known oar gap changed; want exactly:\n  %s\ngot:\n  %s", key, strings.Join(known, "\n  "), strings.Join(lines, "\n  "))
		return
	}
	if len(lines) > 0 {
		t.Errorf("%s differs from the TS fold:\n  %s", field, strings.Join(lines, "\n  "))
	}
}

func eventsOf(records []oar.RawEvent) []oar.Event {
	events := []oar.Event{}
	read := observe.EventsReader(func(event oar.Event) { events = append(events, event) })
	for _, record := range records {
		read(record)
	}
	return events
}

type both[T any] struct {
	All  T `json:"all"`
	Root T `json:"root"`
}

func TestFoldParity(t *testing.T) {
	goldens := loadGoldens(t)
	compared := 0
	for _, g := range goldens {
		t.Run(g.Name, func(t *testing.T) {
			var records []oar.RawEvent
			if err := json.Unmarshal(g.Records, &records); err != nil {
				t.Fatalf("records: %v", err)
			}
			root := g.RootSessionID
			done := map[string]bool{}
			check := func(field string, got func() any) {
				done[field] = true
				want, ok := g.fields[field]
				if !ok {
					t.Errorf("golden has no %q", field)
					return
				}
				t.Run(field, func(t *testing.T) { compare(t, g.Name+"/"+field, field, want, got()) })
				compared++
			}

			check("records", func() any { return records })
			check("statusSteps", func() any {
				steps := []oar.AgentStatus{}
				status := observe.InitialStatus
				for _, record := range records {
					status = observe.ReduceStatus(status, record, root)
					steps = append(steps, status)
				}
				return steps
			})
			check("statusOf", func() any {
				return both[any]{observe.StatusOf(records, ""), observe.StatusOf(records, root)}
			})
			check("modelOf", func() any { return both[any]{observe.ModelOf(records, ""), observe.ModelOf(records, root)} })
			check("effortOf", func() any { return both[any]{observe.EffortOf(records, ""), observe.EffortOf(records, root)} })
			check("serviceTierOf", func() any {
				return both[any]{observe.ServiceTierOf(records, ""), observe.ServiceTierOf(records, root)}
			})
			check("contextUsageOf", func() any {
				return both[any]{observe.ContextUsageOf(records, ""), observe.ContextUsageOf(records, root)}
			})
			check("usageOf", func() any {
				return both[any]{observe.UsageOf(records, "", nil), observe.UsageOf(records, root, nil)}
			})
			check("graphOf", func() any { return observe.GraphOf(records) })
			events := eventsOf(records)
			check("events", func() any { return events })
			check("coalesced", func() any {
				out := []oar.Event{}
				observer := observe.CoalesceText(func(event oar.Event) { out = append(out, event) }, 0)
				for _, event := range events {
					observer(event)
				}
				// A non-text sentinel flushes the last held piece; it is not part of the result.
				observer(oar.Event{Envelope: oar.Envelope{SessionID: "sentinel", Seq: -1}, Body: oar.Exited{}})
				return out[:len(out)-1]
			})
			check("turnEndAfter", func() any {
				var samples []struct {
					AfterSeq  int64   `json:"afterSeq"`
					SessionID *string `json:"sessionId"`
					InputID   *string `json:"inputId"`
				}
				if err := json.Unmarshal(g.fields["turnEndAfter"], &samples); err != nil {
					t.Fatal(err)
				}
				out := []map[string]any{}
				for _, sample := range samples {
					entry := map[string]any{"afterSeq": sample.AfterSeq}
					sessionID, inputID := "", ""
					if sample.SessionID != nil {
						sessionID = *sample.SessionID
						entry["sessionId"] = sessionID
					}
					if sample.InputID != nil {
						inputID = *sample.InputID
						entry["inputId"] = inputID
					}
					entry["outcome"] = observe.TurnEndAfter(records, sample.AfterSeq, sessionID, inputID)
					out = append(out, entry)
				}
				return out
			})
			check("conversation", func() any { return observe.ConversationOf(records) })
			check("conversationUpdates", func() any {
				out := [][]observe.ConversationUpdate{}
				state := observe.InitialConversation()
				for _, record := range records {
					state = observe.ReduceConversation(state, record, "")
					out = append(out, state.Updates)
				}
				return out
			})
			check("view", func() any { return viewWithPurityCheck(t, records, "") })
			check("viewStream", func() any { return observe.ViewOf(records, "stream-1") })
			check("viewSteps", func() any { return viewSteps(records) })
			check("viewEvents", func() any {
				view := observe.InitialSessionView()
				for _, event := range events {
					view = observe.ReduceSessionViewEvent(view, event, "")
				}
				return view
			})
			check("tasksOf", func() any { return observe.TasksOf(records, "") })
			check("tasksOfRoot", func() any { return observe.TasksOf(records, root) })
			check("display", func() any { return displayOf(t, g, records) })

			for field := range g.fields {
				if !metadata[field] && !done[field] {
					t.Errorf("golden field %q is not compared", field)
				}
			}
		})
	}
	t.Logf("compared %d fields over %d logs", compared, len(goldens))
}

// viewWithPurityCheck folds the view and checks that each reduce leaves the previous view unchanged.
func viewWithPurityCheck(t *testing.T, records []oar.RawEvent, streamID string) observe.SessionView {
	t.Helper()
	view := observe.InitialSessionView()
	for i, record := range records {
		before, err := json.Marshal(view)
		if err != nil {
			t.Fatal(err)
		}
		next := observe.ReduceSessionView(view, record, streamID)
		after, err := json.Marshal(view)
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(before, after) {
			t.Fatalf("reducing record %d (seq %d) changed the previous view", i, record.Seq)
		}
		view = next
	}
	return view
}

// viewSteps mirrors generate.ts viewSteps: a digest of the view after every record.
func viewSteps(records []oar.RawEvent) []any {
	steps := []any{}
	view := observe.InitialSessionView()
	for _, record := range records {
		view = observe.ReduceSessionView(view, record, "")
		messages := []any{}
		for _, message := range view.Messages {
			if message.Kind != "turn" {
				messages = append(messages, map[string]any{"id": message.ID})
				continue
			}
			parts := []int{}
			for _, section := range message.Sections {
				parts = append(parts, len(section.Parts))
			}
			var outcome any
			if message.Outcome != nil {
				outcome = message.Outcome.Kind
			}
			messages = append(messages, map[string]any{"id": message.ID, "parts": parts, "outcome": outcome})
		}
		inputs := []any{}
		for _, input := range view.PendingInputs {
			inputs = append(inputs, map[string]any{"id": input.ID, "state": input.State})
		}
		requests := []string{}
		for _, request := range view.PendingRequests {
			requests = append(requests, request.RequestID)
		}
		steps = append(steps, map[string]any{"openTurn": view.OpenTurn, "messages": messages, "pendingInputs": inputs, "pendingRequests": requests, "updates": len(view.Conversation.Updates)})
	}
	return steps
}
