// Package dsh is the DeepSeek Harness runtime: `dsh --profile acp` (DeepSeek Harness's automation ACP server, dsh
// 0.2.1-rc.1, ACP v1) driven through the shared ACP layer. It is no OAR port; a host adds Runtime() to its registry.
//
// What the server offers, probed 2026-10-17: initialize with no auth methods, session/new, session/resume, session/list
// and session/close, one prompt at a time, session/cancel, and session/set_config_option with a `model` select
// grouped by provider and a `reasoning_effort` select in the thought_level category (off, low, high, max).
package dsh

import (
	"context"
	"encoding/json"
	"strings"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Runtime is the DeepSeek Harness runtime.
func Runtime() oar.Runtime {
	return oar.DefineRuntime(oar.Runtime{
		ID:                    "dsh",
		Brand:                 oar.RuntimeBrand{Name: "DeepSeek Harness"},
		Installation:          Installation,
		ListModels:            ListModels,
		Session:               Session,
		RefusedSessionOptions: RefusedSessionOptions,
	})
}

// Installation probes `dsh` (OAR_DSH_BIN pins one); its version is `dsh --version`, which loads the CLI, slowly.
var Installation = shared.ExecutableInstallation("OAR_DSH_BIN", "dsh", nil, nil, shared.ExecutableInstallationOptions{VersionTimeout: 30 * time.Second})

// RefusedSessionOptions is what dsh-acp has no channel for: its automation surface omits session prompts, tool
// denylists, names, tiers, extra directories and output schemas (packages/acp/acp/README.md).
var RefusedSessionOptions = oar.RefusedSessionOptions{
	oar.OptionSystemPrompt:          "dsh-acp has no per-session system prompt input",
	oar.OptionAppendSystemPrompt:    "dsh-acp has no per-session system prompt append input",
	oar.OptionDisallowedTools:       "dsh-acp has no session tool denylist",
	oar.OptionName:                  "dsh-acp has no session name setting",
	oar.OptionServiceTier:           "dsh-acp has no service tier setting",
	oar.OptionAdditionalDirectories: "dsh-acp does not support additional directories",
	oar.OptionOutputSchema:          "dsh-acp has no final-output schema channel",
}

// Profile is dsh's ACP profile.
var Profile = acp.Profile{
	Args: acp.StaticArgs("--profile", "acp"),
	// Its subagents are its own: none of them reaches this transport.
	Capabilities:   acp.Capabilities{Attribution: "opaque"},
	RequestTimeout: 30 * time.Second,
	// The model is the `model` config option, valued by its opaque provider/model pair.
	ModelViaConfigOption: true,
	ModelName:            ModelID,
	ValidateOptions: func(options oar.SessionOptions) error {
		return shared.RefuseSessionOptions(RefusedSessionOptions, options)
	},
	// session/resume of an unknown id is refused without a code of its own; session/list tells.
	IsResumeNotFound: func(_ jsonx.Record, listed *bool) bool { return listed != nil && !*listed },
}

var open = acp.Session(Profile)

// Session opens a dsh session; the model may be written provider/model or as the bare model of DeepSeek's own provider.
func Session(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
	options.Model = OptionValue(options.Model)
	return open(ctx, installation, options)
}

// The provider dsh's catalog names DeepSeek's own API by.
const deepseek = "deepseek-official"

// OptionValue is the `model` option's value for a model: dsh values it by the JSON pair ["provider","model"].
// "deepseek-flash" is DeepSeek's; "provider/model" is that provider's; an empty model or a pair is left as it is.
func OptionValue(model string) string {
	model = strings.TrimSpace(model)
	if model == "" || strings.HasPrefix(model, "[") {
		return model
	}
	provider, id, ok := strings.Cut(model, "/")
	if !ok {
		provider, id = deepseek, model
	}
	pair, _ := json.Marshal([]string{provider, id})
	return string(pair)
}

// ModelID is how a model is written outside dsh, provider/model, from its option value; a value that is no pair is
// itself.
func ModelID(value string) string {
	var pair []string
	if json.Unmarshal([]byte(value), &pair) != nil || len(pair) != 2 {
		return value
	}
	return pair[0] + "/" + pair[1]
}
