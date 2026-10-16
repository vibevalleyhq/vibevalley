package antigravity

import (
	"context"
	"errors"
	"regexp"
	"runtime"
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

// ProjectModels projects a `session/new` response; nil when it has no
// `model` config option. agy_acp_server 1.2.1 has no model-list method; the
// account's models ride on every new session as the `configOptions` entry
// with id `model`, the option the session switches through
// `session/set_config_option`. Effort is part of the model id
// (`gemini-3.8-flash-high`, `-medium`, `-low`) and no `thought_level` option
// exists, so no entry carries effort levels.
func ProjectModels(response any) []oar.ModelEntry {
	var modelOption jsonx.Record
	for _, option := range jsonx.AsRecordList(jsonx.AsRecord(response)["configOptions"]) {
		if option["id"] == "model" {
			modelOption = option
			break
		}
	}
	if modelOption == nil {
		return nil
	}
	// A new session's current model: what a session uses with no `model` set.
	current := text(modelOption["currentValue"])
	entries := []oar.ModelEntry{}
	for _, model := range jsonx.AsRecordList(modelOption["options"]) {
		id := text(model["value"])
		if id == "" {
			continue
		}
		entry := oar.ModelEntry{ID: id}
		if displayName := text(model["name"]); displayName != "" && displayName != id {
			entry.DisplayName = displayName
		}
		entry.Default = id == current
		entries = append(entries, entry)
	}
	return entries
}

func readNewSession(ctx context.Context, command, cwd string, timeout time.Duration) (jsonx.Record, error) {
	process, err := acp.StartProcess(command, AcpArgs(runtime.GOOS), nil, acp.ProcessOptions{Dir: cwd})
	if err != nil {
		return nil, err
	}
	defer func() {
		process.Kill()
		<-process.Exited()
	}()
	if _, err := process.Request(ctx, acp.MethodInitialize, acp.InitializeParams(false, nil), timeout); err != nil {
		return nil, err
	}
	// No `authenticate` and no `session/close`: the server signs in from its
	// own persisted login, and the process is killed once the list is read.
	response, err := process.Request(ctx, acp.MethodSessionNew, map[string]any{"cwd": cwd, "mcpServers": []any{}}, timeout)
	if err != nil {
		return nil, err
	}
	record := jsonx.ParseRecord(response)
	if record == nil {
		record = jsonx.Record{}
	}
	return record, nil
}

var authWords = regexp.MustCompile(`(?i)auth(?:entication)?|log(?:ged)? ?in`)

// causedError is TS `new Error(message, { cause })`: the cause's text
// travels in the message (errors are strings in Go, GAPS.md).
type causedError struct {
	message string
	cause   error
}

func (e *causedError) Error() string { return e.message + ": " + e.cause.Error() }
func (e *causedError) Unwrap() error { return e.cause }

// ListModels opens a throwaway session in the listing's cwd and reads its model option.
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if !installation.IsExecutable() {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "antigravity model listing requires the agy_acp_server executable"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	response, err := readNewSession(ctx, installation.Command, shared.ListingCwd(options), timeout)
	if err != nil {
		var failure *acp.RequestError
		if errors.As(err, &failure) && (failure.Code == -32000 || authWords.MatchString(failure.Message)) {
			return oar.ListModelsResult{Kind: "unauthenticated", Detail: failure.Message}, nil
		}
		return oar.ListModelsResult{}, &causedError{message: "Failed to list Antigravity models", cause: err}
	}
	models := ProjectModels(response)
	if models == nil {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "this agy_acp_server build returns no model config option on session/new"}, nil
	}
	return oar.ListModelsResult{Kind: "ok", Models: models}, nil
}
