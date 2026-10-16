package pi

import (
	"context"
	"errors"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// Installation probes the `pi` executable (OAR_PI_BIN pins one), reporting
// its `--version`. The TS package's pi is its bundled SDK instead.
var Installation = shared.ExecutableInstallation("OAR_PI_BIN", "pi", nil, nil, shared.ExecutableInstallationOptions{})

// executableOf is the pi executable for an installation. A `bundled` one
// (the TS package's pi, as a host written for it hands over) resolves to the
// pi executable this port drives, found the way Installation finds it.
func executableOf(ctx context.Context, installation oar.AvailableInstallation) (oar.AvailableInstallation, error) {
	if installation.IsExecutable() {
		return installation, nil
	}
	snapshot, err := Installation(ctx)
	if err != nil {
		return installation, err
	}
	if snapshot.Kind != "available" || !snapshot.Available.IsExecutable() {
		return installation, errors.New("the pi session adapter needs an executable installation, and no pi executable was found (set OAR_PI_BIN)")
	}
	return snapshot.Available, nil
}
