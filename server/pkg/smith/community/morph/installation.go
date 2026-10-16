package morph

import (
	"context"
	"regexp"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

var probe = shared.ExecutableInstallation("OAR_MORPH_BIN", "morph", shared.Fallbacks("mistermorph"), nil, shared.ExecutableInstallationOptions{})

var versionLine = regexp.MustCompile(`(?m)^(?:morph|mistermorph)\s+(\S+)`)

// Installation probes morph. `morph` rejects `--version`; its version is the
// `version` subcommand's "morph <version>" line.
func Installation(ctx context.Context) (oar.InstallationSnapshot, error) {
	snapshot, err := probe(ctx)
	if err != nil || snapshot.Kind != "available" || !snapshot.Available.IsExecutable() || snapshot.Available.Version != "" {
		return snapshot, err
	}
	result := executable.Run(ctx, snapshot.Available.Command, []string{"version"}, executable.RunOptions{Timeout: 10 * time.Second})
	if match := versionLine.FindStringSubmatch(result.Stdout); result.OK && match != nil {
		snapshot.Available.Version = match[1]
	}
	return snapshot, nil
}
