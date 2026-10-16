package kimi

import (
	"context"
	"errors"
	"regexp"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

func configOption(response jsonx.Record, id string) jsonx.Record {
	for _, option := range jsonx.AsRecordList(response["configOptions"]) {
		if option["id"] == id {
			return option
		}
	}
	return nil
}

// ProjectModels projects a `session/new` response; nil when it has no
// `model` config option. Kimi has no model-list method; the usable list for
// the logged-in account rides on every new session as the `configOptions`
// entry with id `model` (acp-server config-options.ts). The effort menu is
// the option in ACP's `thought_level` category (kimi 2.0.0: id `thinking`,
// low/high/max on k3), the same lookup the session uses to apply
// SessionOptions.Effort (internal/acp model.go), so what is listed is what a
// session accepts. It is only emitted for the currently selected model, so
// effort levels can only be attached to that entry; an `off` value is a
// toggle, not an effort level, and is dropped.
func ProjectModels(response any) []oar.ModelEntry {
	root := jsonx.AsRecord(response)
	modelOption := configOption(root, "model")
	if modelOption == nil {
		return nil
	}
	current := text(modelOption["currentValue"])
	thinking := acp.ThoughtLevelOption(root)
	var effortLevels []string
	defaultEffort := ""
	if thinking != nil {
		for _, option := range jsonx.AsRecordList(thinking["options"]) {
			if level, ok := shared.EffortLevelOf(option["value"]); ok && level != "off" {
				effortLevels = append(effortLevels, level)
			}
		}
		if level, ok := shared.EffortLevelOf(thinking["currentValue"]); ok && level != "off" {
			defaultEffort = level
		}
	}
	entries := []oar.ModelEntry{}
	for _, model := range jsonx.AsRecordList(modelOption["options"]) {
		id := text(model["value"])
		if id == "" {
			continue
		}
		entry := oar.ModelEntry{ID: id, DisplayName: text(model["name"])}
		if id == current {
			entry.EffortLevels = effortLevels
			entry.DefaultEffort = defaultEffort
			// A new session's current model: what a session uses with no `model` set.
			entry.Default = true
		}
		entries = append(entries, entry)
	}
	return entries
}

func readNewSession(ctx context.Context, command, cwd string, timeout time.Duration) (jsonx.Record, error) {
	process, err := acp.StartProcess(command, []string{"acp"}, nil, acp.ProcessOptions{Dir: cwd})
	if err != nil {
		return nil, err
	}
	defer func() {
		process.Kill()
		<-process.Exited()
	}()
	initialized, err := process.Request(ctx, acp.MethodInitialize, acp.InitializeParams(false, nil), timeout)
	if err != nil {
		return nil, err
	}
	if method := SelectAuthMethod(jsonx.ParseRecord(initialized)); method != "" {
		if _, err := process.Request(ctx, acp.MethodAuthenticate, map[string]any{"methodId": method}, timeout); err != nil {
			return nil, err
		}
	}
	response, err := process.Request(ctx, acp.MethodSessionNew, map[string]any{"cwd": cwd, "mcpServers": []any{}}, timeout)
	if err != nil {
		return nil, err
	}
	record := jsonx.ParseRecord(response)
	if record == nil {
		record = jsonx.Record{}
	}
	if sessionID := text(record["sessionId"]); sessionID != "" {
		// Best effort: the list is already in hand and the process is killed next.
		_ = acp.CloseSession(ctx, process, sessionID)
	}
	return record, nil
}

var authWords = regexp.MustCompile(`(?i)auth(?:entication)?|log(?:ged)? ?in`)

// ListModels opens a throwaway session in the listing's cwd and reads its model option (kimiListModels).
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if !installation.IsExecutable() {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "kimi model listing requires the kimi executable"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	response, err := readNewSession(ctx, installation.Command, shared.ListingCwd(options), timeout)
	if err != nil {
		var failure *acp.RequestError
		if errors.As(err, &failure) {
			if failure.Code == -32601 {
				return oar.ListModelsResult{Kind: "unsupported", Reason: "this kimi build has no session/new method"}, nil
			}
			if failure.Code == -32000 || authWords.MatchString(failure.Message) {
				return oar.ListModelsResult{Kind: "unauthenticated", Detail: failure.Message}, nil
			}
		}
		return oar.ListModelsResult{}, &causedError{message: "Failed to list Kimi models", cause: err}
	}
	models := ProjectModels(response)
	if models == nil {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "this kimi build returns no model config option on session/new"}, nil
	}
	return oar.ListModelsResult{Kind: "ok", Models: models}, nil
}
