package pi

import (
	"context"
	"encoding/json"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// ListModels lists what pi's SDK reports available in the listing's cwd
// (list-models.ts, run by the host): extensions under the agent dir and the
// project register providers first; the default is the one pi's settings
// saved. pi keys on provider API keys, so "nothing configured" is an ok empty list.
func ListModels(ctx context.Context, installation oar.AvailableInstallation, options oar.ListModelsOptions) (oar.ListModelsResult, error) {
	installation, err := executableOf(ctx, installation)
	if err != nil {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "pi model listing runs through the pi SDK of an installed pi"}, nil
	}
	cwd := shared.ListingCwd(options)
	job := jsonx.Record{"type": "models", "cwd": cwd, "agentDir": AgentDir()}
	if options.Timeout > 0 {
		job["timeoutMs"] = options.Timeout.Milliseconds()
	}
	data, err := hostJob(ctx, installation, cwd, options.Timeout+5*time.Second, job)
	if err != nil {
		return oar.ListModelsResult{Kind: "unsupported", Reason: "pi SDK could not list available models: " + err.Error()}, nil
	}
	var answer struct {
		Models []oar.ModelEntry `json:"models"`
	}
	if err := json.Unmarshal(data, &answer); err != nil {
		return oar.ListModelsResult{}, err
	}
	if answer.Models == nil {
		answer.Models = []oar.ModelEntry{}
	}
	return oar.ListModelsResult{Kind: "ok", Models: answer.Models}, nil
}
