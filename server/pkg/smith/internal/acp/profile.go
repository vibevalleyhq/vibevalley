package acp

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Capabilities is what a runtime's ACP surface lets the adapter carry.
type Capabilities struct {
	QueueDurable bool
	Attribution  oar.AttributionTier
	// What `initialize` advertised (nil), unless set on evidence that it is wrong.
	Images *bool
}

// SpontaneousTokens is an independent root ledger a vendor notification reports.
type SpontaneousTokens struct {
	// The native key deduplicates delivery.
	Key      string
	Tokens   oar.TokenTotals
	Replayed bool
}

// ConfigureContext is what Profile.ConfigureSession gets.
type ConfigureContext struct {
	Context context.Context
	// Each native call keeps its own deadline and protocol error context.
	Request   func(method string, params any) (json.RawMessage, error)
	SessionID string
	Response  jsonx.Record
	Options   oar.SessionOptions
}

// Profile is a runtime's vendor bits over the shared ACP session (profile.ts AcpSessionProfile).
// A nil function is an absent member.
type Profile struct {
	// Vendor attribution for forwarded updates. The original notification is always recorded verbatim.
	AttributeUpdate func(notification jsonx.Record) *Attribution
	Args            func(options oar.SessionOptions) []string
	// Where SessionOptions.LaunchArgs join Args when not after them (grok: before `stdio`).
	WithLaunchArgs func(args, launchArgs []string) []string
	Capabilities   Capabilities
	// 0: 15 s.
	RequestTimeout time.Duration
	// 0: 10 s.
	AbortTimeout time.Duration
	// Compatibility for agents that put a fully quoted shell line in `command`.
	TerminalShellCommand bool
	// Vendor notifications to record verbatim (children, tasks, usage).
	// Unlisted methods are dropped unseen: list every known method.
	ExtensionNotifications []string
	// Credential-only exception to verbatim recording, applied before a
	// notification is recorded: params in, params to record out.
	RedactExtensionNotification func(method string, params json.RawMessage) json.RawMessage
	InitializeMeta              func(options oar.SessionOptions) jsonx.Record
	// Switch models with `session/set_config_option` on `model`, for agents
	// whose `set_model` answers `{}` and pushes nothing (agy_acp_server 1.2.1).
	ModelViaConfigOption bool
	// How the session reports a model the agent names by an opaque option value (dsh: ["provider","model"]); nil
	// reports the value as it is.
	ModelName func(value string) string
	// The agent resumes a session in the directory it was created in,
	// whatever `cwd` the resume names (kimi 2.1.1); OAR reads the session's
	// own directory from `session/list` and refuses a resume elsewhere.
	ResumeKeepsSessionCwd bool
	// Native resume/load refusal only. listed is false only after a complete
	// session/list walk, nil when unknown.
	IsResumeNotFound func(native jsonx.Record, listed *bool) bool
	SessionMeta      func(options oar.SessionOptions) jsonx.Record
	// Native metadata on every prompt RPC, including held queue entries and steer.
	PromptMeta       func(options oar.SessionOptions) jsonx.Record
	SelectAuthMethod func(initialized jsonx.Record) string
	ValidateOptions  func(options oar.SessionOptions) error
	ConfigureSession func(configure ConfigureContext) error
	// Prompt-level extension fields for the runtime's native steer; nil when
	// the runtime cannot steer, and then the session has no Steer.
	SteerParams func(input string) jsonx.Record
	// A steer replaces the native prompt: fold all admitted answers as one
	// turn (grok sendNow). Otherwise only the original prompt ends the turn.
	SteerSupersedesPrompt bool
	PromptContextUsage    func(response jsonx.Record) *oar.ContextUsage
	// Tokens billed by ONE prompt (grok `_meta.usage`), summed over that
	// prompt's model calls, not the session.
	PromptTokenUsage func(response jsonx.Record) *oar.TokenTotals
	// Independent root ledger, never overlapping PromptTokenUsage.
	SpontaneousTokenUsage func(method string, params jsonx.Record) *SpontaneousTokens
	// nil answer: DefaultPromptOutcome.
	PromptOutcome  func(response jsonx.Record) *oar.TurnOutcome
	FailureOutcome FailureReader
	// The agent answers `session/prompt` BEFORE it pushes the turn's
	// `usage_update` (kimi-code f9ca33376): the session holds the answer's
	// record back until that update lands, bounded by UsageUpdateTimeout.
	UsageUpdateAfterPrompt bool
	// 0: 500 ms.
	UsageUpdateTimeout time.Duration
}

// StaticArgs is a profile's fixed argv.
func StaticArgs(args ...string) func(oar.SessionOptions) []string {
	return func(oar.SessionOptions) []string { return append([]string{}, args...) }
}

func (p Profile) requestTimeout() time.Duration {
	if p.RequestTimeout > 0 {
		return p.RequestTimeout
	}
	return 15 * time.Second
}

// Opened is an opened native session.
type Opened struct {
	Initialized jsonx.Record
	Response    jsonx.Record
	SessionID   string
	// "session/new" | "session/resume" | "session/load".
	OpenMethod string
	// The agent advertised `session/close`.
	SupportsClose bool
	// The model switch response, when a model was requested.
	SetModelResponse jsonx.Record
}

// HasCapability is an ACP capability given as `true` or an object.
func HasCapability(value any) bool {
	if value == true {
		return true
	}
	return jsonx.AsRecord(value) != nil
}

func responseRecord(method string, value json.RawMessage) (jsonx.Record, error) {
	response := jsonx.ParseRecord(value)
	if response == nil {
		return nil, &namedError{name: "TypeError", message: "ACP " + method + " returned a non-object response"}
	}
	return response, nil
}

// CloseSession sends session/close (2 s bound).
func CloseSession(ctx context.Context, process *Process, sessionID string) error {
	_, err := process.Request(ctx, MethodSessionClose, map[string]any{"sessionId": sessionID}, 2*time.Second)
	return err
}

// InitializeParams is the initialize request OAR sends; meta nil is none.
func InitializeParams(terminal bool, meta jsonx.Record) map[string]any {
	params := map[string]any{
		"protocolVersion":    ProtocolVersion,
		"clientCapabilities": map[string]any{"fs": map[string]any{"readTextFile": false, "writeTextFile": false}, "terminal": terminal},
		"clientInfo":         map[string]any{"name": "oar", "version": "0.0.0"},
	}
	if meta != nil {
		params["_meta"] = meta
	}
	return params
}

func initialize(ctx context.Context, process *Process, profile Profile, options oar.SessionOptions, observe OpenObserver) (jsonx.Record, error) {
	var meta jsonx.Record
	if profile.InitializeMeta != nil {
		meta = profile.InitializeMeta(options)
	}
	answer, err := process.Request(ctx, MethodInitialize, InitializeParams(true, meta), profile.requestTimeout())
	if err != nil {
		return nil, err
	}
	response, err := responseRecord(MethodInitialize, answer)
	if err != nil {
		return nil, err
	}
	observe(OpenStep{Method: MethodInitialize, Response: answer})
	if profile.SelectAuthMethod != nil {
		if method := profile.SelectAuthMethod(response); method != "" {
			authenticated, err := process.Request(ctx, MethodAuthenticate, map[string]any{"methodId": method}, profile.requestTimeout())
			if err != nil {
				return nil, err
			}
			observe(OpenStep{Method: MethodAuthenticate, Response: objectOrEmpty(authenticated)})
		}
	}
	return response, nil
}

func createOrResume(ctx context.Context, process *Process, profile Profile, initialized jsonx.Record, options oar.SessionOptions, meta jsonx.Record) (jsonx.Record, json.RawMessage, string, string, error) {
	sessionCapabilities := jsonx.AsRecord(jsonx.Get(initialized, "agentCapabilities", "sessionCapabilities"))
	params := map[string]any{"cwd": options.Cwd}
	directories, err := AdditionalDirectories(options, initialized)
	if err != nil {
		return nil, nil, "", "", err
	}
	if directories != nil {
		params["additionalDirectories"] = directories
	}
	servers, err := McpServersParam(options.MCPServers, initialized)
	if err != nil {
		return nil, nil, "", "", err
	}
	params["mcpServers"] = servers
	if meta != nil {
		params["_meta"] = meta
	}
	timeout := profile.requestTimeout()
	if options.Resume != "" {
		sessionID := options.Resume
		var listed *bool
		if profile.ResumeKeepsSessionCwd && HasCapability(sessionCapabilities["list"]) {
			if listed, err = RefuseResumeElsewhere(ctx, process, sessionID, options.Cwd, timeout); err != nil {
				return nil, nil, "", "", err
			}
		}
		params["sessionId"] = sessionID
		method := ""
		if HasCapability(sessionCapabilities["resume"]) {
			method = MethodSessionResume
		} else if jsonx.Get(initialized, "agentCapabilities", "loadSession") == true {
			method = MethodSessionLoad
		}
		if method == "" {
			return nil, nil, "", "", errors.New("ACP runtime does not support session resume")
		}
		resumed, err := process.Request(ctx, method, params, timeout)
		if err != nil {
			return nil, nil, "", "", ResumeFailure(err, method, sessionID, func(native jsonx.Record) bool {
				return profile.IsResumeNotFound != nil && profile.IsResumeNotFound(native, listed)
			})
		}
		response, err := responseRecord(method, resumed)
		if err != nil {
			return nil, nil, "", "", err
		}
		return response, resumed, sessionID, method, nil
	}
	created, err := process.Request(ctx, MethodSessionNew, params, timeout)
	if err != nil {
		return nil, nil, "", "", err
	}
	response, err := responseRecord(MethodSessionNew, created)
	if err != nil {
		return nil, nil, "", "", err
	}
	sessionID, _ := response["sessionId"].(string)
	if sessionID == "" {
		return nil, nil, "", "", &namedError{name: "TypeError", message: "ACP session/new returned no session id"}
	}
	return response, created, sessionID, MethodSessionNew, nil
}

// OpenSession runs the handshake (openAcpSession): initialize (and
// authenticate), session/new or resume/load, the model and effort, and the
// profile's own configuration. A refused login or model rejects the open as
// a RuntimeFailureError (failure.go).
func OpenSession(ctx context.Context, process *Process, profile Profile, options oar.SessionOptions, observe OpenObserver) (Opened, error) {
	if observe == nil {
		observe = func(OpenStep) {}
	}
	initialized, err := initialize(ctx, process, profile, options, observe)
	if err != nil {
		return Opened{}, OpenFailure(err, "open")
	}
	var meta jsonx.Record
	if profile.SessionMeta != nil {
		meta = profile.SessionMeta(options)
	}
	response, raw, sessionID, openMethod, err := createOrResume(ctx, process, profile, initialized, options, meta)
	if err != nil {
		return Opened{}, OpenFailure(err, "open")
	}
	observe(OpenStep{Method: openMethod, Response: raw})
	opened := Opened{Initialized: initialized, Response: response, SessionID: sessionID, OpenMethod: openMethod}
	if options.Model != "" {
		setModel, err := ApplyModel(ctx, process, sessionID, options.Model, profile.ModelViaConfigOption, profile.requestTimeout(), observe)
		if err != nil {
			return Opened{}, OpenFailure(err, "model")
		}
		opened.SetModelResponse = setModel
	}
	if options.Effort != "" {
		// The effort menu belongs to the model in effect: a model switch
		// whose answer lists the options (`set_config_option`, opencode
		// 1.18.30 where the open model has no effort option and the requested
		// one does) is read instead of the open's.
		menu := OpenedHandshake{Response: response, SessionID: sessionID, OpenMethod: openMethod}
		if _, isList := opened.SetModelResponse["configOptions"].([]any); isList {
			menu = OpenedHandshake{Response: opened.SetModelResponse, SessionID: sessionID, OpenMethod: MethodSessionSetConfig}
		}
		if err := ApplyEffort(ctx, process, menu, options.Effort, profile.requestTimeout(), observe); err != nil {
			return Opened{}, err
		}
	}
	if profile.ConfigureSession != nil {
		err := profile.ConfigureSession(ConfigureContext{
			Context: ctx,
			Request: func(method string, params any) (json.RawMessage, error) {
				return process.Request(ctx, method, params, profile.requestTimeout())
			},
			SessionID: sessionID,
			Response:  response,
			Options:   options,
		})
		if err != nil {
			return Opened{}, err
		}
	}
	opened.SupportsClose = HasCapability(jsonx.Get(initialized, "agentCapabilities", "sessionCapabilities", "close"))
	return opened, nil
}
