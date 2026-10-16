package observe_test

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// The session-view parts of tests/app-request-cancelled.test.ts (oar#263),
// and tests/service-tier-view.test.ts. The TS test feeds claude 2.1.292
// frames through the claude projection; Go has no claude projection here, so
// the records are the ones it writes: a control_request is an event-less
// frame plus a toApp request (its subtype as type, the frame as native, its
// request_id as id); a control_cancel_request is a frame carrying
// app_request_cancelled.

const svElicitation = `{"type":"control_request","request_id":"a19c0ccb-9037-4733-9496-375c4762cfa2",
	"request":{"subtype":"elicitation","mcp_server_name":"ask","message":"Which color do you like?","mode":"form",
	"requested_schema":{"type":"object","properties":{"color":{"type":"string"}},"required":["color"]}}}`

const svElicitationID = "a19c0ccb-9037-4733-9496-375c4762cfa2"

func svAsking() *svStream {
	s := svNewStream("root")
	prompt := s.request(svLane{}, oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "Call the ask tool"})
	s.respond(svLane{}, prompt.ID, oar.Accepted())
	s.frame(svLane{})
	s.records[len(s.records)-1].Frame.Type = "control_request"
	s.records[len(s.records)-1].Frame.Native = json.RawMessage(svElicitation)
	s.ids++
	s.records = append(s.records, svRequestIn(s.lane(svLane{}), int64(len(s.records)), svElicitationID, oar.ToApp,
		oar.RequestBody{Kind: oar.RequestNative, Type: "elicitation", Native: json.RawMessage(svElicitation)}))
	return s
}

func svRequestParts(view observe.SessionView) []observe.ViewPart {
	parts := []observe.ViewPart{}
	for _, turn := range svTurns(view) {
		for _, part := range svTurnParts(turn) {
			if part.Kind == "app_request" {
				parts = append(parts, part)
			}
		}
	}
	return parts
}

func TestSessionViewAppRequestPartCarriesTheNativeBody(t *testing.T) {
	view := observe.ViewOf(svAsking().records, "")
	parts := svRequestParts(view)
	if len(parts) == 0 {
		t.Fatal("no app_request part")
	}
	part := parts[0]
	svMatch(t, "part", part, `{"requestId":"`+svElicitationID+`","type":"elicitation","answered":false,"body":`+svElicitation+`}`)
	ids := []string{}
	for _, request := range view.PendingRequests {
		ids = append(ids, request.RequestID)
	}
	svStrings(t, "pending", ids, []string{svElicitationID})
	text, ok := observe.AppRequestText(part.Type, part.Body)
	if !ok || text != "Which color do you like?" {
		t.Errorf("text = %q, %v", text, ok)
	}
}

func TestSessionViewAppRequestCancelMarksThePartCancelled(t *testing.T) {
	s := svAsking()
	s.frame(svLane{}, oar.AppRequestCancelled{RequestID: svElicitationID})
	view := observe.ViewOf(s.records, "")
	svEq(t, "pending", view.PendingRequests, `[]`)
	parts := svRequestParts(view)
	if len(parts) != 1 {
		t.Fatalf("parts = %d", len(parts))
	}
	svMatch(t, "part", parts[0], `{"requestId":"`+svElicitationID+`","answered":false,"cancelled":true}`)
}

func TestSessionViewExitEmptiesPendingRequestsAndKeepsThePart(t *testing.T) {
	s := svAsking()
	code := 1
	s.respond(svLane{}, "", oar.ExitedBody(&code))
	view := observe.ViewOf(s.records, "")
	svEq(t, "pending", view.PendingRequests, `[]`)
	parts := svRequestParts(view)
	if len(parts) != 1 {
		t.Fatalf("parts = %d", len(parts))
	}
	svMatch(t, "part", parts[0], `{"answered":false}`)
	if svHas(parts[0], "cancelled") {
		t.Error("the part says cancelled")
	}
}

func TestSessionViewServiceTierReadsOnlyRootReports(t *testing.T) {
	if observe.InitialSessionView().ServiceTier != nil {
		t.Error("initial tier is not null")
	}
	report := func(seq int64, tier string, lane svLane) oar.RawEvent {
		if lane.Session == "" {
			lane.Session = "root"
		}
		lane.At = seq
		return svFrameIn(lane, seq, oar.ServiceTier{ServiceTier: tier})
	}
	records := []oar.RawEvent{report(0, "priority", svLane{}), report(1, "flex", svLane{Session: "child"}), report(2, "flex", svLane{Path: []string{"agent"}})}
	svEq(t, "tier", observe.ViewOf(records, "").ServiceTier, `"priority"`)
	records = append(records, report(3, "default", svLane{}))
	svEq(t, "default", observe.ViewOf(records, "").ServiceTier, `"default"`)
	svSame(t, "fold vs replay", svFold(records...), observe.ViewOf(records, ""))
}
