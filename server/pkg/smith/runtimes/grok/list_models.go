package grok

import (
	"context"
	"errors"
	"os"
	"regexp"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

func text(value any) string {
	if s, ok := value.(string); ok {
		return strings.TrimSpace(s)
	}
	return ""
}

// firstPresent is `a ?? b ?? ...`: the first value neither absent nor null.
func firstPresent(record jsonx.Record, names ...string) any {
	for _, name := range names {
		if value := record[name]; value != nil {
			return value
		}
	}
	return nil
}

// ModelState unwraps the `_x.ai/models/list` result. The JSON-RPC result
// carries a second envelope, `{result: SessionModelState}` or `{error}`; a
// handler error wins over any result, matching grok's own client.
func ModelState(result any) (jsonx.Record, error) {
	envelope := jsonx.AsRecord(result)
	if envelope == nil {
		envelope = jsonx.Record{}
	}
	if failure, present := envelope["error"]; present {
		detail := text(jsonx.AsRecord(failure)["message"])
		if detail == "" {
			detail = text(failure)
		}
		if detail == "" {
			detail = jsonText(failure)
		}
		return nil, errors.New("grok models/list handler error: " + detail)
	}
	if state := jsonx.AsRecord(envelope["result"]); state != nil {
		return state, nil
	}
	return envelope, nil
}

// ProjectModels projects a `SessionModelState`. Grok already filters to
// what the current auth can use; entries still flagged `hidden` or not
// `user_selectable` are dropped here as well. Both camel- and snake-case
// field spellings are read because the extension's Rust serialization has
// changed between releases.
//
// The effort menu moved under the entry's `_meta` (grok 1.0.41, 2026-09-29:
// `_meta: {supportsReasoningEffort, reasoningEffort: "high",
// reasoningEfforts: [{id, value, label, description, default}]}`); the
// top-level spellings of older builds are still read. It is the same menu
// the session's `reasoning_effort` config option offers for that model.
func ProjectModels(state any) []oar.ModelEntry {
	root := jsonx.AsRecord(state)
	models := jsonx.AsRecordList(firstPresent(root, "availableModels", "available_models"))
	// The model a new session starts on, as grok reports it.
	current := text(firstPresent(root, "currentModelId", "current_model_id"))
	entries := []oar.ModelEntry{}
	for _, model := range models {
		id := text(firstPresent(model, "modelId", "model_id", "id"))
		if id == "" {
			continue
		}
		if model["hidden"] == true || model["user_selectable"] == false || model["userSelectable"] == false {
			continue
		}
		entry := oar.ModelEntry{ID: id, DisplayName: text(firstPresent(model, "displayName", "display_name", "name"))}
		meta := jsonx.AsRecord(model["_meta"])
		// A model grok says takes no effort lists none, whatever else it carries.
		if meta["supportsReasoningEffort"] != false {
			menu := firstPresent(model, "reasoningEfforts", "reasoning_efforts")
			if menu == nil {
				menu = firstPresent(meta, "reasoningEfforts", "reasoning_efforts")
			}
			entry.EffortLevels = shared.EffortLevelsOf(menu)
			effort := firstPresent(model, "defaultReasoningEffort", "default_reasoning_effort", "reasoningEffort", "reasoning_effort")
			if effort == nil {
				effort = firstPresent(meta, "reasoningEffort", "reasoning_effort")
			}
			if level, ok := shared.EffortLevelOf(effort); ok {
				entry.DefaultEffort = level
			}
		}
		entry.Default = id == current
		entries = append(entries, entry)
	}
	return entries
}

// agentArgs is the argv the account readers start grok with.
var agentArgs = []string{"agent", "--always-approve", "--no-leader", "stdio"}

// startReader starts grok for a one-shot read, initializes it with OAR's
// `_meta` for cwd and authenticates when grok offers a method. Each request
// gets what timeout says for it.
func startReader(ctx context.Context, command, dir, cwd string, timeout func() (time.Duration, error)) (*acp.Process, error) {
	process, err := acp.StartProcess(command, agentArgs, nil, acp.ProcessOptions{Dir: dir})
	if err != nil {
		return nil, err
	}
	fail := func(err error) (*acp.Process, error) {
		process.Kill()
		<-process.Exited()
		return nil, err
	}
	budget, err := timeout()
	if err != nil {
		return fail(err)
	}
	initialized, err := process.Request(ctx, acp.MethodInitialize, acp.InitializeParams(false, InitializeMeta(oar.SessionOptions{Cwd: cwd})), budget)
	if err != nil {
		return fail(err)
	}
	if method := SelectAuthMethod(jsonx.ParseRecord(initialized)); method != "" {
		if budget, err = timeout(); err != nil {
			return fail(err)
		}
		if _, err := process.Request(ctx, acp.MethodAuthenticate, map[string]any{"methodId": method}, budget); err != nil {
			return fail(err)
		}
	}
	return process, nil
}

func readModelState(ctx context.Context, command, cwd string, timeout time.Duration) (jsonx.Record, error) {
	process, err := startReader(ctx, command, cwd, cwd, func() (time.Duration, error) { return timeout, nil })
	if err != nil {
		return nil, err
	}
	defer func() {
		process.Kill()
		<-process.Exited()
	}()
	result, err := process.Request(ctx, "_x.ai/models/list", map[string]any{}, timeout)
	if err != nil {
		return nil, err
	}
	parsed, _ := jsonx.Parse(result)
	return ModelState(parsed)
}

var authWords = regexp.MustCompile(`(?i)auth(?:entication)?|log(?:ged)? ?in`)

// ListModels reads `_x.ai/models/list` (grokListModels).
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if !installation.IsExecutable() {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "grok model listing requires the grok executable"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	state, err := readModelState(ctx, installation.Command, shared.ListingCwd(options), timeout)
	if err != nil {
		var failure *acp.RequestError
		if errors.As(err, &failure) {
			if failure.Code == -32601 {
				return oar.ListModelsResult{Kind: "unsupported", Reason: "this grok build has no _x.ai/models/list method"}, nil
			}
			if failure.Code == -32000 || authWords.MatchString(failure.Message) {
				return oar.ListModelsResult{Kind: "unauthenticated", Detail: failure.Message}, nil
			}
		}
		return oar.ListModelsResult{}, &causedError{message: "Failed to list Grok models", cause: err}
	}
	return oar.ListModelsResult{Kind: "ok", Models: ProjectModels(state)}, nil
}

// causedError is TS `new Error(message, { cause })`: the cause's text
// travels in the message (errors are strings in Go, GAPS.md).
type causedError struct {
	message string
	cause   error
}

func (e *causedError) Error() string { return e.message + ": " + e.cause.Error() }
func (e *causedError) Unwrap() error { return e.cause }

// hostCwd is process.cwd().
func hostCwd() string {
	cwd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return cwd
}
