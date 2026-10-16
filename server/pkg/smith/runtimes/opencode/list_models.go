package opencode

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

func text(value any) string {
	if value, ok := value.(string); ok {
		return strings.TrimSpace(value)
	}
	return ""
}

// orderedKeys is Object.keys of a raw JSON object: its keys in the native order.
func orderedKeys(raw json.RawMessage) []string {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	var keys []string
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return keys
		}
		key, _ := token.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := decoder.Decode(&skip); err != nil {
			return keys
		}
	}
	return keys
}

var verboseID = regexp.MustCompile(`^(\S+/\S+)$`)
var lineBreak = regexp.MustCompile(`\r?\n`)

// ProjectModels projects `opencode models --verbose` (1.18.30): for each
// model of every configured provider, a `provider/model` line, then the model
// as indented JSON closed by a `}` line. The `provider/model` line is the id
// `opencode acp` offers in its `model` config option. The model's `variants`
// keys are the values of its `effort` (`thought_level`) option. No
// defaultEffort: which variant a new session starts on is the session's to report.
func ProjectModels(stdout string) []oar.ModelEntry {
	lines := lineBreak.Split(stdout, -1)
	entries := []oar.ModelEntry{}
	index := 0
	for index < len(lines) {
		match := verboseID.FindStringSubmatch(lines[index])
		index++
		if match == nil || index >= len(lines) || lines[index] != "{" {
			continue
		}
		var body []string
		for index < len(lines) {
			line := lines[index]
			body = append(body, line)
			index++
			if line == "}" {
				break
			}
		}
		raw := []byte(strings.Join(body, "\n"))
		model := jsonx.ParseRecord(raw)
		entry := oar.ModelEntry{ID: match[1], DisplayName: text(model["name"])}
		if variants := jsonx.RawFields(raw)["variants"]; variants != nil {
			entry.EffortLevels = orderedKeys(variants)
		}
		if provider := text(model["providerID"]); provider != "" {
			entry.Provider = &oar.ModelEntryProvider{ID: provider}
		}
		entries = append(entries, entry)
	}
	return entries
}

var standaloneID = regexp.MustCompile(`^\S+/\S+$`)

// ListModels reads opencode's model catalog in the listing's cwd, whose
// project config can add providers; the first run after an install also
// fetches models.dev.
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if !installation.IsExecutable() {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "opencode model listing requires the opencode executable"}, nil
	}
	major, err := Major(ctx, installation, nil)
	if err != nil {
		return oar.ListModelsResult{}, err
	}
	// v2's default command connects to a persistent daemon. Listing must not leave one behind.
	flag := "--verbose"
	if major == 2 {
		flag = "--standalone"
	}
	timeout := options.Timeout
	if timeout <= 0 {
		timeout = 30 * time.Second
	}
	result := runExecutable(ctx, installation.Command, []string{"models", flag}, executable.RunOptions{Dir: shared.ListingCwd(options), Timeout: timeout})
	if !result.OK {
		return oar.ListModelsResult{}, failureOf("Failed to list opencode models", result)
	}
	if major == 1 {
		return oar.ListModelsResult{Kind: "ok", Models: ProjectModels(result.Stdout)}, nil
	}
	var ids []string
	for _, line := range lineBreak.Split(result.Stdout, -1) {
		if line = strings.TrimSpace(line); line != "" {
			ids = append(ids, line)
		}
	}
	if len(ids) == 0 {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "opencode 2.0.26 models --standalone exits before the cold catalog finishes loading; an empty response does not establish that no models exist (https://github.com/anomalyco/opencode/issues/53724)"}, nil
	}
	models := make([]oar.ModelEntry, 0, len(ids))
	for _, id := range ids {
		if !standaloneID.MatchString(id) {
			return oar.ListModelsResult{}, errors.New("opencode models --standalone returned an unrecognized model listing")
		}
		models = append(models, oar.ModelEntry{ID: id})
	}
	return oar.ListModelsResult{Kind: "ok", Models: models}, nil
}
