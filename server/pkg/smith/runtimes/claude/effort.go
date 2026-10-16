package claude

import (
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
)

// claude's word on the reasoning effort it will run (claude 2.1.284, effort.ts):
//   - --effort <level> reaches the Messages API as output_config.effort, on a
//     new session and on --resume alike; without it claude sends its default.
//   - Nothing in the stream-json output names the effort, and an unknown
//     level, a model without effort or an override setting all change it
//     silently on stdout.
//   - The one report is the get_settings control request, answered before
//     any turn: response.applied.effort is what will actually be sent, null
//     when the model takes none. The same answer carries the merged settings
//     of every source verbatim, which is why the adapter consumes it instead
//     of recording it (session.go).

// claudeEffortReadback is how long the adapter waits for claude to answer
// its get_settings read-back (after the SessionStart hooks). A var so tests
// can shorten it.
var claudeEffortReadback = 30 * time.Second

// claudeSettingsRequest is the get_settings control request, under its own request id.
func claudeSettingsRequest(requestID string) string {
	return jsonText(controlRequest{Type: "control_request", RequestID: requestID, Request: map[string]any{"subtype": "get_settings"}}) + "\n"
}

type controlRequest struct {
	Type      string         `json:"type"`
	RequestID string         `json:"request_id"`
	Request   map[string]any `json:"request"`
}

// claudeControlResponseID is the request id a control_response frame answers, "" for any other frame.
func claudeControlResponseID(message jsonx.Record) string {
	if message["type"] != "control_response" {
		return ""
	}
	id, _ := jsonx.AsRecord(message["response"])["request_id"].(string)
	return id
}

// claudeEffortRefusal is why claude will not run requested, read off its
// get_settings answer, or "" when applied.effort is exactly the requested
// level. The message names the requested level and what claude said instead.
func claudeEffortRefusal(requested string, answer jsonx.Record) string {
	response := jsonx.AsRecord(answer["response"])
	if response["subtype"] != "success" {
		reason, ok := response["error"].(string)
		if !ok {
			reason = "no success answer"
		}
		return "claude could not report the effort it runs (get_settings: " + reason + "), so effort " + requested + " cannot be confirmed"
	}
	applied := jsonx.AsRecord(jsonx.AsRecord(response["response"])["applied"])
	effort, present := applied["effort"]
	if applied == nil || !present {
		return "claude's get_settings answer names no applied effort, so effort " + requested + " cannot be confirmed"
	}
	model := ""
	if name, ok := applied["model"].(string); ok {
		model = " for " + name
	}
	if effort == requested {
		return ""
	}
	if effort == nil {
		return "claude sends no effort" + model + " (the model takes none), so effort " + requested + " would be dropped"
	}
	applies, ok := effort.(string)
	if !ok {
		applies = jsonText(effort)
	}
	return "claude applies effort " + applies + model + " although " + requested + " was requested"
}
