//go:build !race

package vibevalley_test

import "time"

const (
	maxPKMSearchLatency       = 300 * time.Millisecond
	maxArtifactCompileLatency = 10 * time.Millisecond
)
