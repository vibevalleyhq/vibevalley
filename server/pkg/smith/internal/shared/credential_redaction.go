package shared

import (
	"strings"

	"vibevalley/pkg/smith/internal/jsonx"
)

// RedactionRules says which stored records oar's credential-redaction rules
// can change, and the rules' version (docs/spec/record-stream.md). Version
// goes up whenever a rule is added or broadened, so a host that cleans
// stored records rescans only when it changes. A frame whose body.type
// starts with none of FrameTypePrefixes is never changed, so a host can
// pre-filter its storage by them.
var RedactionRules = struct {
	Version           int
	FrameTypePrefixes []string
}{
	Version: 1,
	// grok's MCP notifications (0.32.1).
	FrameTypePrefixes: []string{"_x.ai/mcp/", "_x.ai/mcp_initialized"},
}

// RedactionCovers reports whether a frame type is one the redaction rules cover.
func RedactionCovers(frameType string) bool {
	for _, prefix := range RedactionRules.FrameTypePrefixes {
		if strings.HasPrefix(frameType, prefix) {
			return true
		}
	}
	return false
}

// RedactGrokNotification redacts MCP credential values in a grok
// notification. Grok 1.0.46's servers_updated reports the user's stdio env
// verbatim; the other registered MCP notifications carry status/counters,
// but the same credential rule applies if they include these fields. Never
// edits free-form text, other field names, other notifications or the
// received map: an uncovered method returns params itself, a covered one a copy.
func RedactGrokNotification(method string, params jsonx.Record) jsonx.Record {
	if !RedactionCovers(method) {
		return params
	}
	return redactMcpFields(params)
}

// redactNamedValues keeps credential names and the native array/map shape, never their values.
func redactNamedValues(value any) any {
	if list, ok := value.([]any); ok {
		out := make([]any, len(list))
		for index, entry := range list {
			record := jsonx.AsRecord(entry)
			if _, has := record["value"]; record != nil && has {
				redacted := redactMcpFields(record)
				redacted["value"] = "[redacted]"
				out[index] = redacted
				continue
			}
			out[index] = redactMcpTree(entry)
		}
		return out
	}
	record := jsonx.AsRecord(value)
	if record == nil {
		return value
	}
	out := make(jsonx.Record, len(record))
	for key := range record {
		out[key] = "[redacted]"
	}
	return out
}

func redactMcpFields(record jsonx.Record) jsonx.Record {
	out := make(jsonx.Record, len(record))
	for key, value := range record {
		switch key {
		case "env", "headers", "http_headers":
			out[key] = redactNamedValues(value)
		case "bearer_token", "bearerToken":
			if value == nil {
				out[key] = nil
			} else {
				out[key] = "[redacted]"
			}
		default:
			out[key] = redactMcpTree(value)
		}
	}
	return out
}

func redactMcpTree(value any) any {
	if list, ok := value.([]any); ok {
		out := make([]any, len(list))
		for index, entry := range list {
			out[index] = redactMcpTree(entry)
		}
		return out
	}
	record := jsonx.AsRecord(value)
	if record == nil {
		return value
	}
	return redactMcpFields(record)
}
