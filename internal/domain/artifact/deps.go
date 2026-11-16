package artifact

// Pin esbuild and gotextdiff in go.mod before Swarm workers branch.
import (
	_ "github.com/evanw/esbuild/pkg/api"
	_ "github.com/hexops/gotextdiff"
)
