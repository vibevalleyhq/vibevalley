package shared

import "vibevalley/pkg/smith/internal/jsonx"

// EffortLevelsOf reads a reasoning-effort menu as plain level names.
// Runtimes disagree on the entry shape: codex ships {effort, description}
// objects, claude ships strings, grok's ACP extension may ship either. nil
// when the runtime exposes no menu at all (not an array), so callers can
// omit the field rather than emit []; an empty menu is a non-nil empty slice.
func EffortLevelsOf(value any) []string {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	levels := []string{}
	for _, entry := range entries {
		if level, ok := entry.(string); ok {
			levels = append(levels, level)
			continue
		}
		if level, ok := effortName(jsonx.AsRecord(entry)); ok {
			levels = append(levels, level)
		}
	}
	return levels
}

// effortName is record.effort ?? record.id when that is a non-empty string.
func effortName(record jsonx.Record) (string, bool) {
	if record == nil {
		return "", false
	}
	candidate := record["effort"]
	if candidate == nil {
		candidate = record["id"]
	}
	text, ok := candidate.(string)
	return text, ok && text != ""
}

// EffortLevelOf is a single effort name; false when absent or not a non-empty string.
func EffortLevelOf(value any) (string, bool) {
	if text, ok := value.(string); ok && text != "" {
		return text, true
	}
	return effortName(jsonx.AsRecord(value))
}
