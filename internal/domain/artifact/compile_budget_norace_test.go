//go:build !race

package artifact_test

import "time"

const maxCompileLatency = 10 * time.Millisecond
