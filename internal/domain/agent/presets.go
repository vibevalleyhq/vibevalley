package agent

import "slices"

// RuntimeLook defines visual appearance metadata for a runtime preset.
type RuntimeLook struct {
	Build string `json:"build"`
	Head  string `json:"head"`
	Body  string `json:"body"`
	Trim  string `json:"trim"`
	Hat   string `json:"hat"`
	Eye   string `json:"eye"`
}

// RuntimePreset defines a known coding runtime's display metadata and fallback look.
type RuntimePreset struct {
	ID    string      `json:"id"`
	Label string      `json:"label"`
	Blurb string      `json:"blurb"`
	Look  RuntimeLook `json:"look"`
}

// RuntimeSupport declares capabilities and refused session options for a runtime.
type RuntimeSupport struct {
	Steer        bool              `json:"steer"`
	Refused      map[string]string `json:"refused,omitempty"`
	Capabilities []string          `json:"capabilities,omitempty"`
	InProcess    bool              `json:"inProcess"`
}

// RuntimeSettings holds user-configurable defaults and overrides for a runtime.
type RuntimeSettings struct {
	Enabled       bool              `json:"enabled"`
	BinPath       string            `json:"binPath,omitempty"`
	DefaultModel  string            `json:"defaultModel,omitempty"`
	DefaultEffort string            `json:"defaultEffort,omitempty"`
	DailyBudget   float64           `json:"dailyBudget,omitempty"`
	Env           map[string]string `json:"env,omitempty"`
}

// ModelInfo describes an available model advertised by a runtime.
type ModelInfo struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	IsDefault    bool     `json:"isDefault,omitempty"`
	EffortLevels []string `json:"effortLevels,omitempty"`
}

// RuntimeInfo combines probed availability, settings, models, and support matrix.
type RuntimeInfo struct {
	ID         string          `json:"id"`
	Installed  bool            `json:"installed"`
	Settings   RuntimeSettings `json:"settings"`
	Support    RuntimeSupport  `json:"support"`
	Preset     RuntimePreset   `json:"preset"`
	Models     []ModelInfo     `json:"models,omitempty"`
	SpentToday float64         `json:"spentToday,omitempty"`
}

// KnownRuntimeIDs lists the 10 built-in VibeValley runtimes in UI order.
var KnownRuntimeIDs = []string{
	"claude", "codex", "opencode", "vibevalley", "pi",
	"cursor", "grok", "kimi", "antigravity", "dsh",
}

var builtinPresets = map[string]RuntimePreset{
	"claude": {
		ID: "claude", Label: "Claude Code", Blurb: "Anthropic CLI coding agent.",
		Look: RuntimeLook{Build: "biped", Head: "rounded", Body: "#f3e9da", Trim: "#d9774f", Hat: "#e8804f", Eye: "#a6f4ff"},
	},
	"codex": {
		ID: "codex", Label: "Codex", Blurb: "OpenAI coding agent via app-server.",
		Look: RuntimeLook{Build: "treads", Head: "terminal", Body: "#3d434a", Trim: "#d8dadc", Hat: "#f4f3ee", Eye: "#a6f4ff"},
	},
	"opencode": {
		ID: "opencode", Label: "opencode", Blurb: "Open-source terminal coding agent over ACP.",
		Look: RuntimeLook{Build: "biped", Head: "terminal", Body: "#e9e6de", Trim: "#24282d", Hat: "#2f3438", Eye: "#a6f4ff"},
	},
	"vibevalley": {
		ID: "vibevalley", Label: "vibevalley", Blurb: "VibeValley hosted agent running in-process.",
		Look: RuntimeLook{Build: "hopper", Head: "orb", Body: "#fbe7c6", Trim: "#4f9a5a", Hat: "#f2b53a", Eye: "#a6f4ff"},
	},
	"pi": {
		ID: "pi", Label: "Pi", Blurb: "In-process coding agent SDK.",
		Look: RuntimeLook{Build: "hopper", Head: "dome", Body: "#f4e6d4", Trim: "#b0503f", Hat: "#d9534f", Eye: "#a6f4ff"},
	},
	"cursor": {
		ID: "cursor", Label: "Cursor", Blurb: "Cursor local agent SDK.",
		Look: RuntimeLook{Build: "wheel", Head: "saucer", Body: "#dfe4ea", Trim: "#5b6470", Hat: "#a9b4c2", Eye: "#a6f4ff"},
	},
	"grok": {
		ID: "grok", Label: "Grok", Blurb: "xAI grok CLI over ACP.",
		Look: RuntimeLook{Build: "wheel", Head: "dome", Body: "#b9c4d1", Trim: "#3a404a", Hat: "#4f86d9", Eye: "#a6f4ff"},
	},
	"kimi": {
		ID: "kimi", Label: "Kimi", Blurb: "Moonshot kimi CLI over ACP.",
		Look: RuntimeLook{Build: "hopper", Head: "orb", Body: "#e7e6fb", Trim: "#6c70d8", Hat: "#9580e6", Eye: "#a6f4ff"},
	},
	"antigravity": {
		ID: "antigravity", Label: "Antigravity", Blurb: "Google Antigravity agent over ACP.",
		Look: RuntimeLook{Build: "hover", Head: "saucer", Body: "#d3efe8", Trim: "#2f9d8f", Hat: "#45bf8c", Eye: "#a6f4ff"},
	},
	"dsh": {
		ID: "dsh", Label: "DeepSeek Harness", Blurb: "DeepSeek harness over ACP.",
		Look: RuntimeLook{Build: "treads", Head: "orb", Body: "#dce6fb", Trim: "#3b5bdb", Hat: "#4d6bfe", Eye: "#a6f4ff"},
	},
}

var builtinSupports = map[string]RuntimeSupport{
	"claude":      {Steer: true, Capabilities: []string{"listModels", "accountUsage", "skills", "mcpServers", "tools"}},
	"codex":       {Steer: true, Capabilities: []string{"listModels", "accountUsage", "skills", "mcpServers", "tools"}},
	"opencode":    {Steer: true, Refused: map[string]string{"disallowedTools": "opencode ACP has no session disallowedTools"}, Capabilities: []string{"listModels"}},
	"vibevalley":  {Steer: true, InProcess: true, Capabilities: []string{"listModels"}},
	"pi":          {Steer: true, InProcess: true, Capabilities: []string{"listModels", "skills", "tools"}},
	"cursor":      {Steer: true, InProcess: true, Refused: map[string]string{"systemPrompt": "unsupported", "appendSystemPrompt": "unsupported", "env": "unsupported", "mcpServers": "unsupported"}, Capabilities: []string{"listModels"}},
	"grok":        {Steer: true, Refused: map[string]string{"disallowedTools": "unsupported"}, Capabilities: []string{"listModels", "accountUsage", "skills", "mcpServers"}},
	"kimi":        {Steer: false, Refused: map[string]string{"systemPrompt": "unsupported", "appendSystemPrompt": "unsupported", "disallowedTools": "unsupported"}, Capabilities: []string{"listModels", "accountUsage"}},
	"antigravity": {Steer: true, Refused: map[string]string{"systemPrompt": "unsupported", "disallowedTools": "unsupported", "mcpServerCredentials": "plaintext credential storage rejected"}, Capabilities: []string{"listModels"}},
	"dsh":         {Steer: false, Refused: map[string]string{"systemPrompt": "unsupported", "appendSystemPrompt": "unsupported", "disallowedTools": "unsupported"}, Capabilities: []string{"listModels"}},
}

// PresetOf returns the preset metadata for runtimeID (falling back cleanly for custom runtimes).
func PresetOf(runtimeID string) RuntimePreset {
	if p, ok := builtinPresets[runtimeID]; ok {
		return p
	}
	return RuntimePreset{
		ID:    runtimeID,
		Label: runtimeID,
		Blurb: "Custom coding agent runtime.",
		Look:  RuntimeLook{Build: "biped", Head: "rounded", Body: "#f1e8d8", Trim: "#5d5850", Hat: "#f2b53a", Eye: "#a6f4ff"},
	}
}

// ListPresets returns all built-in presets in canonical UI order.
func ListPresets() []RuntimePreset {
	out := make([]RuntimePreset, 0, len(KnownRuntimeIDs))
	for _, id := range KnownRuntimeIDs {
		out = append(out, PresetOf(id))
	}
	return out
}

// SupportOf returns a cloned RuntimeSupport entry for runtimeID.
func SupportOf(runtimeID string) RuntimeSupport {
	sup, ok := builtinSupports[runtimeID]
	if !ok {
		return RuntimeSupport{Refused: map[string]string{}}
	}
	out := sup
	out.Capabilities = slices.Clone(sup.Capabilities)
	out.Refused = make(map[string]string, len(sup.Refused))
	for k, v := range sup.Refused {
		out.Refused[k] = v
	}
	return out
}
