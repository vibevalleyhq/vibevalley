package cli

// MCP output schemas: the objects a programmatic caller receives (mcp-output-schemas.ts).

func identity() map[string]any {
	return map[string]any{
		"id":        map[string]any{"type": "string"},
		"name":      map[string]any{"type": "string"},
		"runtime":   map[string]any{"type": "string"},
		"sessionId": map[string]any{"type": "string"},
		"log":       map[string]any{"type": "string"},
	}
}

func with(base map[string]any, extra map[string]any) map[string]any {
	out := map[string]any{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

var infoSchema = map[string]any{
	"type": "object",
	"properties": with(identity(), map[string]any{
		"state": map[string]any{"type": "string", "enum": []string{"running", "idle", "closed"}},
		"turns": map[string]any{"type": "integer"},
	}),
	"required": []string{"id", "runtime", "sessionId", "state", "turns"},
}

var reportSchema = map[string]any{
	"type": "object",
	"properties": with(identity(), map[string]any{
		"turn": map[string]any{"type": "integer"},
		"outcome": map[string]any{
			"type": "object",
			"anyOf": []any{
				map[string]any{"properties": map[string]any{"kind": map[string]any{"const": "completed"}, "structuredOutput": map[string]any{}}, "required": []string{"kind"}},
				map[string]any{"properties": map[string]any{"kind": map[string]any{"const": "aborted"}}, "required": []string{"kind"}},
				map[string]any{
					"properties": map[string]any{
						"kind":       map[string]any{"const": "failed"},
						"failure":    map[string]any{"type": "string", "description": "OAR's failure classification."},
						"reason":     map[string]any{"type": "string"},
						"status":     map[string]any{"type": "number"},
						"credential": map[string]any{"type": "string", "enum": []string{"missing", "rejected"}},
						"resetsAt":   map[string]any{"type": "string"},
					},
					"required": []string{"kind", "failure", "reason"},
				},
			},
		},
		"text":    map[string]any{"type": "string"},
		"endedAt": map[string]any{"type": "number", "description": "Unix time in milliseconds."},
	}),
	"required": []string{"id", "runtime", "sessionId", "turn", "outcome", "text", "endedAt"},
}

var runOutputSchema = map[string]any{
	"type":        "object",
	"description": "A turn report, a spawn refusal, or the subagent's info if it closed before reporting.",
	"anyOf": []any{
		reportSchema,
		map[string]any{
			"type":       "object",
			"properties": map[string]any{"kind": map[string]any{"const": "refused"}, "code": map[string]any{"type": "string"}, "reason": map[string]any{"type": "string"}},
			"required":   []string{"kind", "code", "reason"},
		},
		infoSchema,
	},
}

var waitOutputSchema = map[string]any{
	"type":       "object",
	"properties": map[string]any{"reports": map[string]any{"type": "array", "items": reportSchema}},
	"required":   []string{"reports"},
}

var listOutputSchema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"agents": map[string]any{"type": "array", "items": infoSchema},
		"unread": map[string]any{
			"type":        "array",
			"description": "Finished turns whose reports are still unread; call wait to take them.",
			"items": map[string]any{
				"type":       "object",
				"properties": map[string]any{"id": map[string]any{"type": "string"}, "turn": map[string]any{"type": "integer"}},
				"required":   []string{"id", "turn"},
			},
		},
	},
	"required": []string{"agents", "unread"},
}
