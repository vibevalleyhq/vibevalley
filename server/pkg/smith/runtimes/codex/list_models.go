package codex

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

const defaultListTimeout = 15 * time.Second

func trimmedText(value any) (string, bool) {
	text, ok := value.(string)
	text = strings.TrimSpace(text)
	return text, ok && text != ""
}

// ProjectCodexModels reads `model/list`, the native picker including
// service tiers; `debug models` is not (projectCodexModels).
func ProjectCodexModels(payload any) []oar.ModelEntry {
	entries := []oar.ModelEntry{}
	for _, model := range jsonx.AsRecordList(jsonx.AsRecord(payload)["data"]) {
		id, ok := trimmedText(model["model"])
		if !ok || model["hidden"] == true {
			continue
		}
		entry := oar.ModelEntry{ID: id}
		entry.DisplayName, _ = trimmedText(model["displayName"])
		if efforts, isList := model["supportedReasoningEfforts"].([]any); isList {
			levels := []any{}
			for _, level := range jsonx.AsRecordList(efforts) {
				levels = append(levels, level["reasoningEffort"])
			}
			entry.EffortLevels = shared.EffortLevelsOf(levels)
		}
		entry.DefaultEffort, _ = trimmedText(model["defaultReasoningEffort"])
		// Keep native ids verbatim, never rename priority to the CLI's fast alias.
		if tiers, isList := model["serviceTiers"].([]any); isList {
			entry.ServiceTiers = []string{}
			seen := map[string]bool{}
			for _, tier := range jsonx.AsRecordList(tiers) {
				if id, ok := trimmedText(tier["id"]); ok && !seen[id] {
					seen[id] = true
					entry.ServiceTiers = append(entry.ServiceTiers, id)
				}
			}
		}
		entry.DefaultServiceTier, _ = trimmedText(model["defaultServiceTier"])
		entry.Default = model["isDefault"] == true
		entries = append(entries, entry)
	}
	return entries
}

// codexDefaultModel marks the model a session with no `model` runs on
// (#347): the one codex's own configuration sets (`config/read`, user and
// project config for the listing's cwd) when it is listed ("" for none),
// else the catalog's `isDefault`. A configured model that is not listed
// marks nothing.
func codexDefaultModel(models []oar.ModelEntry, configured string) []oar.ModelEntry {
	out := append([]oar.ModelEntry{}, models...)
	if configured == "" {
		return out
	}
	listed := false
	for _, model := range models {
		listed = listed || model.ID == configured
	}
	for index := range out {
		out[index].Default = listed && out[index].ID == configured
	}
	return out
}

// causedError is an error with its own message and a cause (TS: Error's cause).
type causedError struct {
	message string
	cause   error
}

func (e *causedError) Error() string { return e.message }
func (e *causedError) Unwrap() error { return e.cause }

// ListModels lists codex's models (codexListModels).
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if installation.Via != "executable" {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "codex model listing requires the codex executable"}, nil
	}
	// Started where a session's app-server starts (the host's cwd, which also
	// resolves a relative CODEX_HOME); the project is the `config/read` cwd,
	// as it is the thread's cwd in a session.
	cwd := shared.ListingCwd(options)
	client := startAppServerClient(installation.Command, nil, nil, "", appServerProcessOptions{})
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = defaultListTimeout
	}
	var deadline sync.Mutex
	timedOut := false
	timer := time.AfterFunc(timeout, func() {
		deadline.Lock()
		timedOut = true
		deadline.Unlock()
		client.kill()
	})
	defer func() {
		timer.Stop()
		client.kill()
		<-client.exited()
	}()
	models, err := listModels(ctx, client, cwd)
	if err != nil {
		deadline.Lock()
		expired := timedOut
		deadline.Unlock()
		if expired {
			return oar.ListModelsResult{}, &causedError{message: fmt.Sprintf("Failed to list Codex models: timed out after %d ms", timeout.Milliseconds()), cause: err}
		}
		return oar.ListModelsResult{}, &causedError{message: "Failed to list Codex models", cause: err}
	}
	return oar.ListModelsResult{Kind: "ok", Models: models}, nil
}

func listModels(ctx context.Context, client appServerClient, cwd string) ([]oar.ModelEntry, error) {
	if err := client.spawned(ctx); err != nil {
		return nil, err
	}
	if err := client.handle(ignoredFrames); err != nil {
		return nil, err
	}
	if _, err := client.request(ctx, "initialize", jsonx.Record{"clientInfo": jsonx.Record{"name": "oar-models", "version": "0"}, "capabilities": jsonx.Record{"experimentalApi": true}}, nil); err != nil {
		return nil, err
	}
	client.notify("initialized", jsonx.Record{})
	models := []oar.ModelEntry{}
	cursors := map[string]bool{}
	cursor := ""
	for {
		params := jsonx.Record{}
		if cursor != "" {
			params["cursor"] = cursor
		}
		page, err := client.request(ctx, "model/list", params, nil)
		if err != nil {
			return nil, err
		}
		if _, ok := page.record["data"].([]any); !ok {
			return nil, errors.New("codex model/list returned no data array")
		}
		models = append(models, ProjectCodexModels(page.record)...)
		cursor, _ = trimmedText(page.record["nextCursor"])
		if cursor == "" {
			break
		}
		if cursors[cursor] {
			return nil, errors.New("codex model/list repeated a pagination cursor")
		}
		cursors[cursor] = true
	}
	effective, err := client.request(ctx, "config/read", jsonx.Record{"cwd": cwd, "includeLayers": false}, nil)
	if err != nil {
		return nil, err
	}
	configured, _ := trimmedText(jsonx.AsRecord(effective.record["config"])["model"])
	return codexDefaultModel(models, configured), nil
}
