package acp

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// AdditionalDirectories is the open's `additionalDirectories` param: only
// the advertised ACP extension may receive directory parameters. nil when
// none are given.
func AdditionalDirectories(options oar.SessionOptions, initialized jsonx.Record) ([]string, error) {
	directories, err := shared.ResolvedAdditionalDirectories(options)
	if err != nil || len(directories) == 0 {
		return nil, err
	}
	if !HasCapability(jsonx.Get(initialized, "agentCapabilities", "sessionCapabilities", "additionalDirectories")) {
		return nil, &oar.UnsupportedOptionError{Option: "additionalDirectories", Message: "ACP runtime declares no sessionCapabilities.additionalDirectories, so the requested directories cannot be applied"}
	}
	return directories, nil
}
