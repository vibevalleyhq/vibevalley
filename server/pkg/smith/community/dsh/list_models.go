package dsh

import (
	"context"
	"errors"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// ProjectModels projects a `session/new` response; nil when it has no `model` config option. dsh has no model-list
// method: the catalog rides on every new session as the `model` option, its choices grouped by provider
// ({group, name, options[]}) or flat, each valued by a JSON pair (OptionValue). The effort menu is the thought_level
// option and is the same for every model; `off` is a toggle, not a level, and is dropped.
func ProjectModels(response any) []oar.ModelEntry {
	root := jsonx.AsRecord(response)
	var model jsonx.Record
	for _, option := range jsonx.AsRecordList(root["configOptions"]) {
		if option["id"] == "model" {
			model = option
		}
	}
	if model == nil {
		return nil
	}
	var levels []string
	defaultEffort := ""
	if thinking := acp.ThoughtLevelOption(root); thinking != nil {
		for _, option := range jsonx.AsRecordList(thinking["options"]) {
			if level, ok := shared.EffortLevelOf(option["value"]); ok && level != "off" {
				levels = append(levels, level)
			}
		}
		if level, ok := shared.EffortLevelOf(thinking["currentValue"]); ok && level != "off" {
			defaultEffort = level
		}
	}
	current, _ := model["currentValue"].(string)
	entries := []oar.ModelEntry{}
	add := func(choice jsonx.Record) {
		value, _ := choice["value"].(string)
		if value == "" {
			return
		}
		name := displayName(value, choice)
		entries = append(entries, oar.ModelEntry{ID: ModelID(value), DisplayName: name, EffortLevels: levels, DefaultEffort: defaultEffort,
			Default: value == current})
	}
	for _, choice := range jsonx.AsRecordList(model["options"]) {
		if group := jsonx.AsRecordList(choice["options"]); group != nil {
			for _, inner := range group {
				add(inner)
			}
			continue
		}
		add(choice)
	}
	return entries
}

func readNewSession(ctx context.Context, command, cwd string, timeout time.Duration) (jsonx.Record, error) {
	process, err := acp.StartProcess(command, []string{"--profile", "acp"}, nil, acp.ProcessOptions{Dir: cwd})
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
	response, err := process.Request(ctx, acp.MethodSessionNew, map[string]any{"cwd": cwd, "mcpServers": []any{}}, timeout)
	if err != nil {
		return nil, err
	}
	record := jsonx.ParseRecord(response)
	if record == nil {
		record = jsonx.Record{}
	}
	if id, _ := record["sessionId"].(string); id != "" {
		// Best effort: the list is already in hand and the process is killed next.
		_ = acp.CloseSession(ctx, process, id)
	}
	return record, nil
}

// ListModels opens a throwaway session in the listing's cwd and reads its model option.
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if !installation.IsExecutable() {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "dsh model listing requires the dsh executable"}, nil
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	response, err := readNewSession(ctx, installation.Command, shared.ListingCwd(options), timeout)
	if err != nil {
		var failure *acp.RequestError
		if errors.As(err, &failure) && failure.Code == -32601 {
			return oar.ListModelsResult{Kind: "unsupported", Reason: "this dsh build has no session/new method"}, nil
		}
		return oar.ListModelsResult{}, err
	}
	models := ProjectModels(response)
	if models == nil {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "this dsh build returns no model config option on session/new"}, nil
	}
	return oar.ListModelsResult{Kind: "ok", Models: models}, nil
}

// displayName is the choice's name, with the release dsh's own selector badges it with
// (dsh-client-ui-deepseek-model-label-1017): DeepSeek's deepseek-flash named exactly DeepSeek-V4.1-Flash is the 1017 build.
func displayName(value string, choice jsonx.Record) string {
	name, _ := choice["name"].(string)
	provider, model, _ := strings.Cut(ModelID(value), "/")
	if (provider == deepseek || provider == "deepseek-account") && model == "deepseek-flash" && name == "DeepSeek-V4.1-Flash" {
		return name + "-1017"
	}
	return name
}
