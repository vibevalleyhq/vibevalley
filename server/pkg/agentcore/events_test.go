package agentcore

import (
	"go/ast"
	"go/parser"
	"go/token"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/ai"
)

func TestTypedEventVariantsAndStateConsumer(t *testing.T) {
	answer := ai.AssistantMessage{StopReason: ai.StopError, ErrorMessage: "failed"}
	cases := []struct {
		event AgentEvent
		kind  EventKind
		check func(*testing.T, AgentState)
	}{
		{AgentStarted{}, EventAgentStart, func(t *testing.T, s AgentState) {
			if !s.IsStreaming || s.ErrorMessage != "" {
				t.Fatal(s)
			}
		}},
		{AgentEnded{Aborted: true}, EventAgentEnd, func(t *testing.T, s AgentState) {
			if s.IsStreaming || len(s.PendingToolCalls) != 0 {
				t.Fatal(s)
			}
		}},
		{TurnStarted{}, EventTurnStart, nil},
		{TurnEnded{Message: answer}, EventTurnEnd, nil},
		{MessageStarted{Message: answer}, EventMessageStart, func(t *testing.T, s AgentState) {
			if s.StreamingMessage == nil {
				t.Fatal("no streaming message")
			}
		}},
		{MessageUpdated{Message: answer, Delta: ai.AssistantMessageEvent{Type: ai.EventTextDelta, Delta: "x"}}, EventMessageUpdate, func(t *testing.T, s AgentState) {
			if s.StreamingMessage == nil {
				t.Fatal("no updated message")
			}
		}},
		{MessageEnded{Message: answer}, EventMessageEnd, func(t *testing.T, s AgentState) {
			if len(s.Messages) != 1 || s.ErrorMessage != "failed" {
				t.Fatal(s)
			}
		}},
		{ToolStarted{ToolCallID: "new", ToolName: "read"}, EventToolExecutionStart, func(t *testing.T, s AgentState) {
			if !s.PendingToolCalls["new"] || !s.PendingToolCalls["old"] {
				t.Fatal(s)
			}
		}},
		{ToolUpdated{ToolCallID: "old", PartialResult: TextResult("partial")}, EventToolExecutionUpdate, nil},
		{ToolEnded{ToolCallID: "old", Result: TextResult("done")}, EventToolExecutionEnd, func(t *testing.T, s AgentState) {
			if len(s.PendingToolCalls) != 0 {
				t.Fatal(s)
			}
		}},
	}
	covered := map[string]bool{}
	for _, tc := range cases {
		t.Run(string(tc.kind), func(t *testing.T) {
			if tc.event.Kind() != tc.kind {
				t.Fatalf("kind: %s", tc.event.Kind())
			}
			typ := reflect.TypeOf(tc.event)
			covered[typ.Name()] = true
			if _, exists := typ.FieldByName("Type"); exists {
				t.Fatal("payload exposes a separately writable discriminator")
			}
			before := AgentState{ErrorMessage: "before", PendingToolCalls: map[string]bool{"old": true}}
			after := ApplyEvent(before, tc.event)
			if tc.check == nil {
				if !reflect.DeepEqual(before, after) {
					t.Fatal("observation-only event changed state")
				}
			} else {
				tc.check(t, after)
			}
			if !before.PendingToolCalls["old"] || len(before.PendingToolCalls) != 1 {
				t.Fatal("consumer mutated the prior state")
			}
		})
	}
	// An added concrete variant must acquire an explicit state-consumer case here, including intentional no-ops.
	files, err := parser.ParseDir(token.NewFileSet(), ".", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	for _, pkg := range files {
		for name, file := range pkg.Files {
			if strings.HasSuffix(name, "_test.go") {
				continue
			}
			for _, decl := range file.Decls {
				method, ok := decl.(*ast.FuncDecl)
				if !ok || method.Name.Name != "Kind" || method.Recv == nil || method.Type.Results == nil {
					continue
				}
				result, ok := method.Type.Results.List[0].Type.(*ast.Ident)
				if !ok || result.Name != "EventKind" {
					continue
				}
				receiver, ok := method.Recv.List[0].Type.(*ast.Ident)
				if !ok || !covered[receiver.Name] {
					t.Fatalf("event variant missing from consumer matrix: %s", name)
				}
			}
		}
	}
}

type foreignEvent struct{}

func (foreignEvent) Kind() EventKind { return "domain_extension" }
func TestEventContractAllowsExtensionsWithoutCorePayload(t *testing.T) {
	before := AgentState{ErrorMessage: "keep", PendingToolCalls: map[string]bool{"x": true}}
	if after := ApplyEvent(before, foreignEvent{}); !reflect.DeepEqual(after, before) {
		t.Fatal("extension changed core state")
	}
}
