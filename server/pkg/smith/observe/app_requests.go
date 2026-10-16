package observe

import (
	"encoding/json"
	"strings"
)

// What a runtime→app request asks for (observe/app-requests.ts), read off its
// type: the type of an app_request event, view part or pending request.
//   - approval: may the agent go ahead with an action (a tool call, a command, a file change)?
//   - question: the agent, or an MCP server through it, asks the user for input.
//   - service: a client call the adapter serves itself (an ACP terminal or file); no person is asked.
//   - unknown: a type OAR does not recognise. The set is OPEN, so an
//     unrecognised type is unknown rather than force-fit, and a host keeps showing it.

// AppRequestKind is "approval", "question", "service" or "unknown".
type AppRequestKind string

// appRequestKinds maps type → kind; the names are distinct across runtimes.
// ACP: the client methods of @agentclientprotocol/sdk 1.4.0; codex: the
// app-server's server requests (0.160.0); claude: the control_request
// subtypes claude 2.1.288 sends its host; morph: the approval a task waits on.
var appRequestKinds = map[string]AppRequestKind{
	"session/request_permission": "approval",
	"elicitation/create":         "question",
	"terminal/create":            "service",
	"terminal/output":            "service",
	"terminal/wait_for_exit":     "service",
	"terminal/kill":              "service",
	"terminal/release":           "service",
	"fs/read_text_file":          "service",
	"fs/write_text_file":         "service",

	"item/commandExecution/requestApproval": "approval",
	"item/fileChange/requestApproval":       "approval",
	"item/permissions/requestApproval":      "approval",
	"item/tool/requestUserInput":            "question",
	"mcpServer/elicitation/request":         "question",

	"can_use_tool": "approval",
	"elicitation":  "question",

	"approval": "approval",
}

// AppRequestKindOf classifies a runtime→app request by its type (an app_request's method or subtype).
func AppRequestKindOf(requestType string) AppRequestKind {
	if kind, ok := appRequestKinds[requestType]; ok {
		return kind
	}
	return "unknown"
}

func askText(value any) (string, bool) {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" {
		return "", false
	}
	return text, true
}

// appRequestTexts maps type → where its words are, in the recorded body
// (claude's is the whole control_request frame, the ask in its request).
var appRequestTexts = map[string]func(map[string]any) any{
	"elicitation":                   func(body map[string]any) any { return asRecord(body["request"])["message"] },
	"can_use_tool":                  func(body map[string]any) any { return asRecord(body["request"])["tool_name"] },
	"mcpServer/elicitation/request": func(body map[string]any) any { return body["message"] },
	"item/tool/requestUserInput": func(body map[string]any) any {
		questions, _ := body["questions"].([]any)
		var lines []string
		for _, raw := range questions {
			if question := asRecord(raw); question != nil {
				if text, ok := askText(question["question"]); ok {
					lines = append(lines, text)
				}
			}
		}
		return strings.Join(lines, "\n")
	},
	"item/commandExecution/requestApproval": func(body map[string]any) any { return body["command"] },
	"elicitation/create":                    func(body map[string]any) any { return body["message"] },
	"session/request_permission":            func(body map[string]any) any { return asRecord(body["toolCall"])["title"] },
}

// AppRequestText is the words of a runtime→app request, read off its native
// body (the one a pending request or an app_request view part carries): what
// a question asks, or the action an approval is for. False for a type OAR
// does not know the words of, and when the body does not hold them: never guessed.
func AppRequestText(requestType string, body json.RawMessage) (string, bool) {
	read, ok := appRequestTexts[requestType]
	if !ok || len(body) == 0 {
		return "", false
	}
	record := asRecord(parseJSON(string(body)))
	if record == nil {
		return "", false
	}
	return askText(read(record))
}
