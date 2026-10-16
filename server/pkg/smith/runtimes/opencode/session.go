package opencode

import (
	"context"
	"errors"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// RefusedSessionOptions: `opencode acp` (1.18.30, live 2026-10-05; source
// packages/opencode/src/acp at v1.18.34) is opencode's own ACP layer over
// its HTTP server, so the mapping is upstream's.
var RefusedSessionOptions = oar.RefusedSessionOptions{
	oar.OptionOutputSchema:    "OpenCode ACP exposes no final-output schema channel; its HTTP prompt format is not configurable through ACP",
	oar.OptionName:            "opencode ACP exposes no verified session name setting",
	oar.OptionServiceTier:     "opencode exposes no verified per-session service-tier setting and readback",
	oar.OptionDisallowedTools: "opencode ACP has no session tool denylist; global permission rules can be overridden by agent rules and do not use the tool-name vocabulary consistently",
}

func withRefusals(base oar.RefusedSessionOptions, extra oar.RefusedSessionOptions) oar.RefusedSessionOptions {
	out := oar.RefusedSessionOptions{}
	for option, reason := range base {
		out[option] = reason
	}
	for option, reason := range extra {
		out[option] = reason
	}
	return out
}

// V1RefusedSessionOptions are what OpenCode 1 also refuses.
var V1RefusedSessionOptions = withRefusals(RefusedSessionOptions, oar.RefusedSessionOptions{
	oar.OptionAdditionalDirectories: "opencode v1 ACP exposes no additional workspace directory setting",
})

// V2RefusedSessionOptions are what OpenCode 2 also refuses.
var V2RefusedSessionOptions = withRefusals(RefusedSessionOptions, oar.RefusedSessionOptions{
	oar.OptionAppendSystemPrompt: "opencode v2 does not load the instructions configuration used for session-local appended prompts; ACP exposes no equivalent transient instruction channel",
	oar.OptionSystemPrompt:       "opencode v2 uses agents.<id>.system, but ACP exposes no per-session replacement and OAR cannot yet safely resolve and override the selected agent across new sessions and resume",
})

// Profile is OpenCode 1's ACP profile (opencodeAcpProfile).
var Profile = acp.Profile{
	Args: acp.StaticArgs("acp"),
	ValidateOptions: func(options oar.SessionOptions) error {
		return shared.RefuseSessionOptions(V1RefusedSessionOptions, options)
	},
	// The ACP layer forwards only its own sessions' parts: a `task` subagent
	// runs in a child session whose frames never reach this transport, so the
	// call shows only as the parent's tool call (opaque, tier #1).
	Capabilities: acp.Capabilities{Attribution: "opaque"},
	// Startup loads providers and the models.dev catalog before answering.
	RequestTimeout: 30 * time.Second,
	// No `authenticate`: the advertised `opencode-login` method answers `{}`;
	// credentials come from `opencode auth login` or provider env vars, and the
	// free opencode models need none.
	// `session/set_model` answers `{}` and 1.18.30 pushes nothing, though the
	// switch applies; `set_config_option` on `model` answers every option with
	// its current value, the new model's effort menu included.
	ModelViaConfigOption: true,
	// A prompt sent while one runs is admitted as a user message and the
	// running loop reads it at its next step (session/prompt.ts runLoop); both
	// prompt RPCs are answered when the session goes idle. Live: a steer sent
	// 2.5 s into a shell call changed that turn's final reply.
	SteerParams: func(string) jsonx.Record { return jsonx.Record{} },
	// A resume naming another directory ran in the session's own (live
	// 2026-10-05: `pwd` printed the original directory), so a resume
	// elsewhere is refused from `session/list` (internal/acp profile.go).
	ResumeKeepsSessionCwd: true,
	// These runtimes lack a unique native missing-session code (#294).
	IsResumeNotFound: func(_ jsonx.Record, listed *bool) bool { return listed != nil && !*listed },
}

// V2Profile is OpenCode 2's ACP profile (opencodeV2AcpProfile): v1's
// without steer, with v2's child attribution.
var V2Profile = func() acp.Profile {
	profile := Profile
	profile.SteerParams = nil
	profile.Capabilities = acp.Capabilities{Attribution: "nested"}
	profile.AttributeUpdate = ChildAttribution
	profile.ValidateOptions = func(options oar.SessionOptions) error {
		return shared.RefuseSessionOptions(V2RefusedSessionOptions, options)
	}
	return profile
}()

// acpSession opens an ACP session on a profile; tests replace it (TS: vi.mock of acpSession).
var acpSession = acp.Session

// promptCleanupSession removes the session's prompt files once it is
// disposed or its runtime exits (withPromptCleanup).
type promptCleanupSession struct {
	oar.Session
	cleanup     func()
	unsubscribe func()
	disposal    sync.Once
	disposeErr  error
}

func withPromptCleanup(session oar.Session, cleanup func()) oar.Session {
	wrapped := &promptCleanupSession{Session: session, cleanup: cleanup}
	var mu sync.Mutex
	var unsubscribe oar.Unsubscribe
	stopped := false
	stop := func() {
		mu.Lock()
		stopped = true
		release := unsubscribe
		unsubscribe = nil
		mu.Unlock()
		if release != nil {
			release()
		}
	}
	// The replay runs inside RawEvents: an exit already recorded stops the
	// subscription before it is even returned.
	subscription := session.RawEvents(func(record oar.RawEvent) {
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
			// Dispose also runs this same cleanup; whichever comes first removes the file.
			cleanup()
			stop()
		}
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
	mu.Lock()
	already := stopped
	if !already {
		unsubscribe = subscription
	}
	mu.Unlock()
	if already {
		subscription()
	}
	for _, record := range session.Records() {
		if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
			stop()
			break
		}
	}
	wrapped.unsubscribe = stop
	return wrapped
}

func (s *promptCleanupSession) Dispose(ctx context.Context) error {
	s.disposal.Do(func() {
		defer func() {
			s.unsubscribe()
			s.cleanup()
		}()
		s.disposeErr = s.Session.Dispose(ctx)
	})
	return s.disposeErr
}

// Session opens an opencode session on the installation's release line (opencodeSession).
var Session = kernel.WithSessionCredentials(func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions, _ kernel.Credentials) (oar.Session, error) {
	if err := shared.RefuseSessionOptions(RefusedSessionOptions, options); err != nil {
		return nil, err
	}
	// Invalid MCP entries fail before even the release-line helper can start.
	if err := shared.CheckMcpServerNames(options.MCPServers); err != nil {
		return nil, err
	}
	if !installation.IsExecutable() {
		return nil, errors.New("opencode requires an executable installation")
	}
	major, err := Major(ctx, installation, &options)
	if err != nil {
		return nil, err
	}
	if major == 2 {
		return acpSession(V2Profile)(ctx, installation, options)
	}
	if err := shared.RefuseSessionOptions(V1RefusedSessionOptions, options); err != nil {
		return nil, err
	}
	if options.SystemPrompt == nil && options.AppendSystemPrompt == nil {
		return acpSession(Profile)(ctx, installation, options)
	}
	// The prompts travel in OPENCODE_CONFIG_CONTENT, the session's MCP servers
	// in the ACP open as on the direct path, after validation above.
	if err := ValidatePrompts(options); err != nil {
		return nil, err
	}
	prepared, err := PreparePrompts(ctx, installation.Command, options, nil)
	if err != nil {
		return nil, err
	}
	profile := Profile
	profile.ConfigureSession = func(configure acp.ConfigureContext) error {
		if prepared.Agent != "" {
			return VerifyAgent(configure.Response, prepared.Agent)
		}
		return nil
	}
	session, err := acpSession(profile)(ctx, installation, prepared.Options)
	if err != nil {
		prepared.Cleanup()
		return nil, err
	}
	return withPromptCleanup(session, prepared.Cleanup), nil
})
