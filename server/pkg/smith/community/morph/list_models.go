package morph

import (
	"context"
	"encoding/json"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// ProjectModels reads Console's LLM profiles as models: the profile name is
// the selector, the model it names today is ResolvedID. The default first.
func ProjectModels(catalog json.RawMessage) []oar.ModelEntry {
	record := jsonx.ParseRecord(catalog)
	models := []oar.ModelEntry{}
	seen := map[string]bool{}
	for _, profile := range append([]jsonx.Record{jsonx.AsRecord(record["default"])}, jsonx.AsRecordList(record["items"])...) {
		name, ok := profile["name"].(string)
		if !ok || name == "" || seen[name] {
			continue
		}
		seen[name] = true
		entry := oar.ModelEntry{ID: name}
		if model, ok := profile["model"].(string); ok && model != "" {
			entry.ResolvedID = model
		}
		models = append(models, entry)
	}
	return models
}

// ListModels lists Console's profiles.
func ListModels(ctx context.Context, installation oar.AvailableInstallation, _ oar.ListModelsOptions) (oar.ListModelsResult, error) {
	if !installation.IsExecutable() {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "morph models are listed by its Console, which needs the morph executable"}, nil
	}
	lease, err := Acquire(ctx, installation.Command, HostStateDir())
	if err != nil {
		return oar.ListModelsResult{}, err
	}
	defer lease.Release()
	catalog, err := lease.Client().Expect(ctx, "GET", "/llm/profiles", nil)
	if err != nil {
		return oar.ListModelsResult{}, err
	}
	return oar.ListModelsResult{Kind: "ok", Models: ProjectModels(catalog)}, nil
}
