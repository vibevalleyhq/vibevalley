package shared

import (
	"os"

	"vibevalley/pkg/smith/oar"
)

// ListingCwd is ListModelsOptions.Cwd resolved against the host's cwd, which is also its default.
func ListingCwd(options oar.ListModelsOptions) string {
	cwd, err := os.Getwd()
	if err != nil {
		cwd = "."
	}
	if options.Cwd == "" {
		return resolvePath(cwd, ".")
	}
	return resolvePath(cwd, options.Cwd)
}
