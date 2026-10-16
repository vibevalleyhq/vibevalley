package kimi

import (
	"time"
	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// SelectAuthMethod picks `login` when kimi offers it.
func SelectAuthMethod(initialized jsonx.Record) string {
	for _, method := range jsonx.AsRecordList(initialized["authMethods"]) {
		if method["id"] == "login" {
			return "login"
		}
	}
	return ""
}

// SupportsYolo reports `yolo` as a session mode or a `mode` config option value.
func SupportsYolo(response jsonx.Record) bool {
	for _, mode := range jsonx.AsRecordList(jsonx.Get(response, "modes", "availableModes")) {
		if mode["id"] == "yolo" {
			return true
		}
	}
	for _, option := range jsonx.AsRecordList(response["configOptions"]) {
		if option["id"] != "mode" {
			continue
		}
		for _, value := range jsonx.AsRecordList(option["options"]) {
			if value["value"] == "yolo" {
				return true
			}
		}
		break
	}
	return false
}

// RefusedSessionOptions is what kimi cannot honor.
var RefusedSessionOptions = oar.RefusedSessionOptions{
	oar.OptionOutputSchema:       "Kimi ACP and launch configuration expose no final-output schema channel",
	oar.OptionName:               "kimi exposes no verified session name setting",
	oar.OptionServiceTier:        "kimi exposes no verified per-session service-tier setting and readback",
	oar.OptionDisallowedTools:    "kimi ACP exposes no session tool denylist; its agent-profile disallowedTools cannot be overlaid through the ACP launch or session options",
	oar.OptionSystemPrompt:       "kimi acp has no per-session system prompt input; its launcher does not forward --agent-file or --agent",
	oar.OptionAppendSystemPrompt: "kimi acp has no per-session system prompt append input; its launcher does not forward --agent-file or --agent",
}

// Profile is kimi's ACP profile (kimiAcpProfile).
var Profile = acp.Profile{
	Args: acp.StaticArgs("acp"),
	// `kimi acp` binds the native session's `main` agent only (kimi-code
	// f9ca33376 acp-server session.ts), so children exist natively but never
	// reach this transport: opaque (tier #1), honestly root-only. The ACP
	// method set has no steer, so the profile has no SteerParams and the
	// session no Steer.
	Capabilities:     acp.Capabilities{Attribution: "opaque"},
	RequestTimeout:   30 * time.Second,
	SelectAuthMethod: SelectAuthMethod,
	ValidateOptions: func(options oar.SessionOptions) error {
		if err := shared.RefuseSessionOptions(RefusedSessionOptions, options); err != nil {
			return err
		}
		if options.Resume != "" && len(options.AdditionalDirectories) > 0 {
			return &oar.UnsupportedOptionError{Option: "additionalDirectories", Message: "kimi applies additionalDirectories only when creating a session; they have no effect on resume"}
		}
		return nil
	},
	// kimi-code f9ca33376 acp-server session.ts onTurnEnded: prompt answered
	// first, usage_update pushed afterwards from an un-awaited async task.
	UsageUpdateAfterPrompt: true,
	// A resume naming another directory ran in the session's own (2.1.1,
	// probed 2026-10-03), so a resume elsewhere is refused (profile.go).
	ResumeKeepsSessionCwd: true,
	// These runtimes lack a unique native missing-session code (#294).
	IsResumeNotFound: func(_ jsonx.Record, listed *bool) bool { return listed != nil && !*listed },
	ConfigureSession: func(configure acp.ConfigureContext) error {
		if SupportsYolo(configure.Response) {
			_, err := configure.Request(acp.MethodSessionSetMode, map[string]any{"sessionId": configure.SessionID, "modeId": "yolo"})
			return err
		}
		return nil
	},
}

// Session opens a kimi session.
var Session = acp.Session(Profile)
