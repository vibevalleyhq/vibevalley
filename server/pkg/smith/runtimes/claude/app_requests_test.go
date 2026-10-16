package claude

import (
	"testing"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports the claude cases of tests/app-request-cancelled.test.ts and
// tests/app-requests.test.ts.

// oar#263: a request the runtime withdrew leaves pendingRequests on the
// runtime's word, its part carries the body, and AppRequestText reads it.

// claude 2.1.292: an MCP server's cElicitation, an interrupt, then claude's cancel under the same id.
const cElicitationID = "a19c0ccb-9037-4733-9496-375c4762cfa2"

func cElicitation() map[string]any {
	return map[string]any{
		"type":       "control_request",
		"request_id": cElicitationID,
		"request": map[string]any{"subtype": "elicitation", "mcp_server_name": "ask", "message": "Which color do you like?", "mode": "form",
			"requested_schema": map[string]any{"type": "object", "properties": map[string]any{"color": map[string]any{"type": "string"}}, "required": []any{"color"}}},
	}
}

// cFeedKernel applies claude's projection to a kernel the way the claude session does.
func cFeedKernel(k *kernel.Kernel, state projectionState, message map[string]any) projectionState {
	next, commands := fold(state, message)
	for _, command := range commands {
		switch command.Kind {
		case "frame":
			k.Frame(command.Body, kernel.RecordAt{AgentPath: command.AgentPath})
		case "toApp":
			k.Request(oar.ToApp, oar.RequestBody{Kind: oar.RequestNative, Type: command.Type, Native: command.Native}, kernel.RecordAt{ID: command.ID})
		}
	}
	return next
}

func cAsking() (*kernel.Kernel, projectionState) {
	k := kernel.New("root")
	prompt := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "Call the ask tool"}, kernel.RecordAt{})
	k.Respond(prompt.ID, oar.Accepted(), kernel.RecordAt{})
	return k, cFeedKernel(k, initialClaudeProjection(), cElicitation())
}

func cRequestParts(view observe.SessionView) []observe.ViewPart {
	var parts []observe.ViewPart
	for _, message := range view.Messages {
		if message.Kind != "turn" {
			continue
		}
		for _, section := range message.Sections {
			for _, part := range section.Parts {
				if part.Kind == "app_request" {
					parts = append(parts, part)
				}
			}
		}
	}
	return parts
}

func TestAppRequestPartCarriesTheNativeBodyAndAppRequestTextReadsIt(t *testing.T) {
	k, _ := cAsking()
	view := observe.ViewOf(k.Records(), "root")
	parts := cRequestParts(view)
	if len(parts) != 1 {
		t.Fatalf("parts = %d", len(parts))
	}
	cAssertMatches(t, parts[0], `{"requestId":"`+cElicitationID+`","type":"elicitation","answered":false,"body":`+jsonText(cElicitation())+`}`)
	if len(view.PendingRequests) != 1 || view.PendingRequests[0].RequestID != cElicitationID {
		t.Fatalf("pending = %+v", view.PendingRequests)
	}
	if text, ok := observe.AppRequestText(parts[0].Type, parts[0].Body); !ok || text != "Which color do you like?" {
		t.Fatalf("text = %q %v", text, ok)
	}
}

func TestClaudesControlCancelRequestTakesTheRequestOutOfPendingRequests(t *testing.T) {
	k, state := cAsking()
	cFeedKernel(k, state, map[string]any{"type": "control_cancel_request", "request_id": cElicitationID})
	view := observe.ViewOf(k.Records(), "root")
	if len(view.PendingRequests) != 0 {
		t.Fatalf("pending = %+v", view.PendingRequests)
	}
	cAssertMatches(t, cRequestParts(view), `[{"requestId":"`+cElicitationID+`","answered":false,"cancelled":true}]`)
}

func TestTheExitEmptiesPendingRequestsAndThePartStaysAsItWas(t *testing.T) {
	k, _ := cAsking()
	k.Respond("", oar.ExitedBody(intPtr(1)), kernel.RecordAt{})
	view := observe.ViewOf(k.Records(), "root")
	if len(view.PendingRequests) != 0 {
		t.Fatalf("pending = %+v", view.PendingRequests)
	}
	parts := cRequestParts(view)
	cAssertMatches(t, parts, `[{"answered":false}]`)
	if parts[0].Cancelled {
		t.Fatal("part says cancelled")
	}
}

func TestAppRequestTextReadsClaudesApproval(t *testing.T) {
	body := []byte(jsonText(map[string]any{"type": "control_request", "request": map[string]any{"subtype": "can_use_tool", "tool_name": "Bash", "input": map[string]any{}}}))
	if text, ok := observe.AppRequestText("can_use_tool", body); !ok || text != "Bash" {
		t.Fatalf("text = %q %v", text, ok)
	}
}

func TestClaudeRecordsAControlRequestUnderItsSubtypeWhichClassifies(t *testing.T) {
	kinds := map[string]string{}
	for _, subtype := range []string{"can_use_tool", "elicitation"} {
		_, commands := fold(initialClaudeProjection(), map[string]any{"type": "control_request", "request_id": "req-" + subtype, "request": map[string]any{"subtype": subtype}})
		for _, command := range commands {
			if command.Kind == "toApp" {
				kinds[command.Type] = string(observe.AppRequestKindOf(command.Type))
			}
		}
	}
	assertJSON(t, kinds, `{"can_use_tool":"approval","elicitation":"question"}`)
	// claude: subtypes that need a host to declare them first
	for _, subtype := range []string{"hook_callback", "request_user_dialog"} {
		if kind := observe.AppRequestKindOf(subtype); kind != "unknown" {
			t.Fatalf("%s = %s", subtype, kind)
		}
	}
}
