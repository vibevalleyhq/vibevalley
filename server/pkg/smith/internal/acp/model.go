package acp

import "vibevalley/pkg/smith/internal/jsonx"

// ReportedModel is the model an ACP agent reports as in effect, read from
// the agent's own frames rather than from what was asked for (model.ts
// acpReportedModel). Two spellings exist upstream:
//
//   - kimi-code: `session/new|load|resume` answer `configOptions` with a
//     `{type: "select", id: "model", currentValue}` row, and every switch
//     pushes `config_option_update` BEFORE the switch request is answered;
//     the `set_model` response is `{}`.
//   - xai-grok-shell 1.0.12: `session/new|load` answer
//     `models.currentModelId` (a model the account cannot use falls back to
//     the default silently) and `session/set_model` answers `{_meta: {model}}`.
//
// false when the frame carries neither. The request parameter is never consulted.
func ReportedModel(frame jsonx.Record) (string, bool) {
	if frame == nil {
		return "", false
	}
	for _, entry := range jsonx.AsRecordList(frame["configOptions"]) {
		if entry["id"] == "model" {
			if current, ok := entry["currentValue"].(string); ok {
				return current, true
			}
			break
		}
	}
	if current, ok := jsonx.Get(frame, "models", "currentModelId").(string); ok {
		return current, true
	}
	if model, ok := jsonx.Get(frame, "_meta", "model").(string); ok {
		return model, true
	}
	return "", false
}

// ThoughtLevelOption is the agent's reasoning-effort selector: the config
// option in ACP's reserved `thought_level` category, whatever its id (grok
// 1.0.41 `reasoning_effort`, kimi 2.0.0 `thinking`; agy_acp_server 1.2.1 has
// none, its effort being part of the model id). nil when none is advertised.
func ThoughtLevelOption(frame jsonx.Record) jsonx.Record {
	if frame == nil {
		return nil
	}
	for _, entry := range jsonx.AsRecordList(frame["configOptions"]) {
		if entry["category"] == "thought_level" {
			return entry
		}
	}
	return nil
}

// ReportedEffort is the `thought_level` option's non-empty `currentValue` in
// a handshake answer or a `config_option_update` push; false when none.
func ReportedEffort(frame jsonx.Record) (string, bool) {
	current, ok := ThoughtLevelOption(frame)["currentValue"].(string)
	return current, ok && current != ""
}
