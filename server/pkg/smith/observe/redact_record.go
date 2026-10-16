package observe

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"

	"vibevalley/pkg/smith/oar"
)

// Credential redaction of stored records (observe/redact-record.ts, with the
// rules of shared/credential-redaction.ts ported here so observe stays free
// of internal packages).

// RedactionRulesInfo says which stored records oar's credential-redaction rules
// can change, and the rules' version. Version goes up whenever a rule is
// added or broadened, so a host that cleans stored records with RedactRecord
// rescans only when it changes. A frame whose type starts with none of
// FrameTypePrefixes is never changed, so a host can pre-filter its storage by them.
type RedactionRulesInfo struct {
	Version           int      `json:"version"`
	FrameTypePrefixes []string `json:"frameTypePrefixes"`
}

// RedactionRules are the current rules: grok's MCP notifications (0.32.1).
var RedactionRules = RedactionRulesInfo{
	Version:           1,
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

// redactNamedValues keeps credential names and the native array/map shape, never their values.
func redactNamedValues(value any) any {
	if list, ok := value.([]any); ok {
		out := make([]any, len(list))
		for i, entry := range list {
			if record, isRecord := entry.(map[string]any); isRecord {
				if _, has := record["value"]; has {
					redacted := redactMcpFields(record)
					redacted["value"] = "[redacted]"
					out[i] = redacted
					continue
				}
			}
			out[i] = redactMcpTree(entry)
		}
		return out
	}
	record, ok := value.(map[string]any)
	if !ok {
		return value
	}
	out := make(map[string]any, len(record))
	for key := range record {
		out[key] = "[redacted]"
	}
	return out
}

func redactMcpFields(record map[string]any) map[string]any {
	out := make(map[string]any, len(record))
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
		for i, entry := range list {
			out[i] = redactMcpTree(entry)
		}
		return out
	}
	if record, ok := value.(map[string]any); ok {
		return redactMcpFields(record)
	}
	return value
}

// RedactGrokNotification applies the credential rule to a covered notification's params.
// Grok 1.0.46's servers_updated reports the user's stdio env verbatim; the
// other registered MCP notifications currently carry status/counters, but
// get the same rule if they include these fields. Free-form text, other
// field names and other notifications are never edited.
func RedactGrokNotification(method string, params map[string]any) map[string]any {
	if !RedactionCovers(method) {
		return params
	}
	return redactMcpFields(params)
}

// RedactRecord is a stored record with oar's current credential-redaction
// rules applied, for records a host kept before a rule existed: grok's
// _x.ai/mcp/* notifications recorded by oar before 0.32.1 carry the user's
// own MCP server env values in plain text. Only a frame's native can change,
// as the live adapter would now have recorded it.
//
// Pure and idempotent: changed is false (and the record comes back as it
// was) for a record no rule touches or one already redacted, so a host can
// run it over all of its storage on every start and rewrite only the
// records it reports changed. (TS returns the same object; Go has no object
// identity, so it reports changed.)
func RedactRecord(record oar.RawEvent) (oar.RawEvent, bool) {
	if record.Kind != oar.KindFrame || len(record.Frame.Native) == 0 {
		return record, false
	}
	decoder := json.NewDecoder(bytes.NewReader(record.Frame.Native))
	decoder.UseNumber()
	var parsed any
	if err := decoder.Decode(&parsed); err != nil {
		return record, false
	}
	native, ok := parsed.(map[string]any)
	if !ok {
		return record, false
	}
	redacted := RedactGrokNotification(record.Frame.Type, native)
	if reflect.DeepEqual(redacted, native) {
		return record, false
	}
	encoded, err := marshalNoEscape(redacted)
	if err != nil {
		return record, false
	}
	next := record
	next.Frame.Native = encoded
	return next, true
}
