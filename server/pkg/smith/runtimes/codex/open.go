package codex

import (
	"fmt"
	"path/filepath"
	"regexp"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// Opening a codex thread (open.ts): the `thread/start` / `thread/resume`
// request built from SessionOptions, and the reply read back against it. The
// record-stream mapping lives in session.go; this is the open-time policy it wraps.

// codexMcpServerName is the names codex starts an MCP server under; any
// other fails that server's startup after the thread opened ([env] 0.160.1).
var codexMcpServerName = regexp.MustCompile(`^[\w:@/.-]+$`)

const codexMcpServerNameSource = `^[\w:@/.-]+$`

// codexMcpServersConfig is SessionOptions.MCPServers as codex's
// `mcp_servers` config table, one entry per server: stdio `{command, args,
// env}`, http `{url, http_headers}` ([env] 0.160.1 against a scripted
// provider: both start and their tools are called). codex merges config
// overrides into the user's config.toml field by field, so an entry named
// like one of the user's own is merged into it: oar sets `args` (an array is
// replaced whole) and `enabled = true` so the user's `args` or `enabled =
// false` cannot change or silently drop the session's server; the user's
// other fields of that entry (more `env` keys, `env_vars`, `cwd`, timeouts,
// tool filters) stay, and an entry of the other transport fails the open
// ("url is not supported for stdio"). Nested under one `mcp_servers` key
// rather than dotted `mcp_servers.<name>` keys, which a `.` in a name would
// split. Errors on a list with an empty, repeated or codex-invalid name.
func codexMcpServersConfig(servers []oar.McpServer) (jsonx.Record, error) {
	if err := shared.CheckMcpServerNames(servers); err != nil {
		return nil, err
	}
	for _, server := range servers {
		if !codexMcpServerName.MatchString(server.Name) {
			return nil, fmt.Errorf("codex starts no MCP server named %s: its names match %s", jsonText(server.Name), codexMcpServerNameSource)
		}
	}
	config := jsonx.Record{}
	for _, server := range servers {
		if server.IsHTTP() {
			entry := jsonx.Record{"url": server.URL}
			if server.Headers != nil {
				entry["http_headers"] = stringRecord(server.Headers)
			}
			entry["enabled"] = true
			config[server.Name] = entry
			continue
		}
		args := []any{}
		for _, arg := range server.Args {
			args = append(args, arg)
		}
		entry := jsonx.Record{"command": server.Command, "args": args}
		if server.Env != nil {
			entry["env"] = stringRecord(server.Env)
		}
		entry["enabled"] = true
		config[server.Name] = entry
	}
	return config, nil
}

func stringRecord(values map[string]string) jsonx.Record {
	record := jsonx.Record{}
	for key, value := range values {
		record[key] = value
	}
	return record
}

// workspaceRoots: native runtime roots replace the list, so retain the primary cwd too. Nil when no additional directory is given.
func workspaceRoots(options oar.SessionOptions) ([]string, error) {
	directories, err := shared.ResolvedAdditionalDirectories(options)
	if err != nil || len(directories) == 0 {
		return nil, err
	}
	cwd, err := filepath.Abs(options.Cwd)
	if err != nil {
		cwd = options.Cwd
	}
	roots := []string{cwd}
	seen := map[string]bool{cwd: true}
	for _, directory := range directories {
		if !seen[directory] {
			seen[directory] = true
			roots = append(roots, directory)
		}
	}
	return roots, nil
}

// codexThreadOpenRequest is the open request for some options: a new
// thread, or a resume of options.Resume; and the redactor for the MCP
// credentials its `config` carries, through which every error codex reports
// for this session goes.
type codexThreadOpenRequest struct {
	Method string
	Params jsonx.Record
	Redact func(string) string
}

const (
	methodThreadStart  = "thread/start"
	methodThreadResume = "thread/resume"
)

// codexThreadOpen builds the open request, refusing what it cannot build before anything starts.
func codexThreadOpen(options oar.SessionOptions) (codexThreadOpenRequest, error) {
	if err := validateCodexToolDenials(options); err != nil {
		return codexThreadOpenRequest{}, err
	}
	if err := shared.CheckSessionName(options); err != nil {
		return codexThreadOpenRequest{}, err
	}
	redact := kernel.NewRedactor(options).Text
	params := jsonx.Record{}
	// System prompt seams (probed 2026-08-24 via the aimock journal):
	// baseInstructions REPLACES codex's base prompt; developerInstructions
	// APPENDS as a developer message. "instructions"/"userInstructions" are
	// silently ignored by thread/start.
	instructions := func() {
		if options.SystemPrompt != nil {
			params["baseInstructions"] = *options.SystemPrompt
		}
		if options.AppendSystemPrompt != nil {
			params["developerInstructions"] = *options.AppendSystemPrompt
		}
	}
	// Effort seam on a NEW thread (probed 2026-09-29, codex 0.155.1, aimock
	// provider): the config override `model_reasoning_effort` reaches every
	// turn's Responses request as `reasoning.effort`, a turn codex starts on
	// its own from its queue included, and is persisted with the thread. Not
	// on thread/resume: any config override there rebuilds the thread's
	// settings from config.toml, so a resumed thread without `model` came back
	// on the configured default model instead of its own ([env] live: a
	// gpt-6-luna thread resumed as gpt-6-astra). A resume sets the effort on
	// the loaded thread instead (codexResumeEffort). Per-turn `turn/start
	// {effort}` would miss a turn codex starts from its queue.
	config := jsonx.Record{}
	if options.Effort != "" && options.Resume == "" {
		config["model_reasoning_effort"] = options.Effort
	}
	// SessionOptions.MCPServers on BOTH methods: codex remembers none for a
	// thread. A resume carrying this override kept the thread's own model and
	// effort ([env] 0.160.1, scripted provider, pinned by the codex vendor
	// test), unlike the live rebuild above; not yet re-checked on a login.
	if servers := shared.GivenMcpServers(options.MCPServers); servers != nil {
		mcp, err := codexMcpServersConfig(servers)
		if err != nil {
			return codexThreadOpenRequest{}, err
		}
		config["mcp_servers"] = mcp
	}
	roots, err := workspaceRoots(options)
	if err != nil {
		return codexThreadOpenRequest{}, err
	}
	common := func() {
		params["cwd"] = options.Cwd
		if roots != nil {
			params["runtimeWorkspaceRoots"] = stringList(roots)
		}
		// Same-runtime model switch = resume the same thread id with a new
		// model. thread/resume accepts `model` (codex rust-v0.153.4,
		// protocol/v2/thread.rs ThreadResumeParams) and applies it when the
		// thread is loaded cold, which is the normal case here because every
		// oar session owns its own app-server process.
		if options.Model != "" {
			params["model"] = options.Model
		}
		if options.ServiceTier != "" {
			params["serviceTier"] = options.ServiceTier
		}
		params["approvalPolicy"] = "never"
	}
	if options.Resume == "" {
		common()
		// Required in addition to initialize.experimentalApi. This exposes
		// the completed Responses API reasoning item, whose encrypted_content
		// lets us distinguish redaction from genuinely empty reasoning.
		params["experimentalRawEvents"] = true
		instructions()
		if len(config) > 0 {
			params["config"] = config
		}
		return codexThreadOpenRequest{Method: methodThreadStart, Params: params, Redact: redact}, nil
	}
	params["threadId"] = options.Resume
	params["excludeTurns"] = true
	common()
	instructions()
	if len(config) > 0 {
		params["config"] = config
	}
	return codexThreadOpenRequest{Method: methodThreadResume, Params: params, Redact: redact}, nil
}

func stringList(values []string) []any {
	list := make([]any, 0, len(values))
	for _, value := range values {
		list = append(list, value)
	}
	return list
}

// codexThreadName is SessionOptions.Name (#368): the name to give the opened
// thread, or nil. A new thread gets it; a resumed one only when the resume
// reply shows no name, so a name the user gave in their app is kept. The
// name reads back on the thread ([env] codex 0.162.0, experiments/codex-session-name.ts).
func codexThreadName(method string, options oar.SessionOptions, reply jsonx.Record) *string {
	if options.Name == nil {
		return nil
	}
	if method == methodThreadResume {
		if current, ok := jsonx.AsRecord(reply["thread"])["name"].(string); ok && current != "" {
			return nil
		}
	}
	return options.Name
}

// effortIn is a reply's `reasoningEffort` (or `threadSettings.effort`): "" when codex runs no explicit level (the model's default).
func effortIn(record jsonx.Record) string {
	effort := record["reasoningEffort"]
	if effort == nil {
		effort = record["effort"]
	}
	text, _ := effort.(string)
	return text
}

// codexOpenReadback is the open reply read back: the model and effort codex
// says the thread runs (the open frame's events), why that is not what was
// requested ("" when it is), and the effort a resume still has to set on the
// loaded thread ("" for none).
//
// Both replies report the model actually active. Still check it against the
// request: codex's resume_running_thread ignores overrides for a thread that
// is already loaded and busy (warn "thread/resume overrides ignored for
// loaded thread") and answers with the old model; a caller who asked for a
// model must not get one silently running another. The same holds for
// effort: `reasoningEffort` is the level the thread runs ("": no explicit
// level, the model's default). A resume answers the level the thread last
// ran with; when that is not the requested one, it is set next
// (resumeEffort). codex echoes an unknown level as given and forwards it to
// the provider, whose refusal then fails the first turn.
func codexOpenReadback(method string, options oar.SessionOptions, reply jsonx.Record) (events []oar.EventBody, refusal string, resumeEffort string) {
	model, _ := reply["model"].(string)
	effort := effortIn(reply)
	events = []oar.EventBody{}
	if _, isString := reply["model"].(string); isString {
		events = append(events, oar.Model{Model: model})
	}
	if effort != "" {
		events = append(events, oar.Effort{Effort: effort})
	}
	events = append(events, codexServiceTierEvents(reply)...)
	roots, _ := workspaceRoots(options)
	if roots != nil {
		reported, isList := reply["runtimeWorkspaceRoots"].([]any)
		confirmed := isList
		for _, root := range roots {
			found := false
			for _, entry := range reported {
				found = found || entry == root
			}
			confirmed = confirmed && found
		}
		if !confirmed {
			return events, "codex " + method + " did not confirm the requested additionalDirectories in runtimeWorkspaceRoots", ""
		}
	}
	if _, isString := reply["model"].(string); options.Model != "" && isString && model != options.Model {
		return events, fmt.Sprintf("codex %s kept model %s although %s was requested", method, model, options.Model), ""
	}
	if options.ServiceTier != "" {
		if tier, ok := codexServiceTier(reply); !ok || tier != options.ServiceTier {
			if !ok {
				tier = "unreported"
			}
			return events, fmt.Sprintf("codex %s reports serviceTier %s although %s was requested", method, tier, options.ServiceTier), ""
		}
	}
	if options.Effort == "" || effort == options.Effort {
		return events, "", ""
	}
	if method == methodThreadResume {
		return events, "", options.Effort
	}
	said := "reports no reasoningEffort"
	if _, present := reply["reasoningEffort"]; present {
		said = "kept effort " + effortOrDefault(effort)
	}
	return events, fmt.Sprintf("codex %s %s although effort %s was requested", method, said, options.Effort), ""
}

func effortOrDefault(effort string) string {
	if effort == "" {
		return "none (the model's default)"
	}
	return effort
}

// settingsReportTimeout is how long a resume waits for codex's
// `thread/settings/updated` after its `thread/settings/update`
// (CODEX_SETTINGS_REPORT_MS); a var so tests can shorten it.
var settingsReportTimeout = 10 * time.Second

// codexResumeEffortRefusal says why the resumed thread does not run
// requested after `thread/settings/update {effort}` ([env] 0.155.1: answered
// `{}`, then `thread/settings/updated` with the thread's settings), or ""
// when codex reports exactly that level. updateError is the RPC's failure
// (nil: it succeeded), settings the notification's params (nil when none came).
func codexResumeEffortRefusal(requested string, updateError *string, settings jsonx.Record) string {
	if updateError != nil {
		return fmt.Sprintf("codex thread/settings/update effort=%s failed: %s", requested, *updateError)
	}
	if settings == nil {
		return fmt.Sprintf("codex reported no thread/settings/updated within %d ms, so effort %s cannot be confirmed", settingsReportTimeout.Milliseconds(), requested)
	}
	effort := effortIn(jsonx.AsRecord(settings["threadSettings"]))
	if effort == requested {
		return ""
	}
	return fmt.Sprintf("codex thread/settings/update left effort %s although %s was requested", effortOrDefault(effort), requested)
}

// codexServiceTier reads a record's `serviceTier`: null explicitly means no
// tier ("default"); an absent field is no evidence (false).
func codexServiceTier(record jsonx.Record) (string, bool) {
	value, present := record["serviceTier"]
	if present && value == nil {
		return "default", true
	}
	tier, ok := value.(string)
	return tier, ok && tier != ""
}

func codexServiceTierEvents(record jsonx.Record) []oar.EventBody {
	if tier, ok := codexServiceTier(record); ok {
		return []oar.EventBody{oar.ServiceTier{ServiceTier: tier}}
	}
	return nil
}
