//go:build race

package vibevalley_test

import "time"

const (
	maxPKMSearchLatency       = 1500 * time.Millisecond
	maxArtifactCompileLatency = 150 * time.Millisecond
)
