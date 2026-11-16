//go:build race

package artifact_test

import "time"

// Allow extra overhead under Go's -race instrumentation and parallel ./... test contention,
// while non-race builds strictly enforce the < 10ms budget.
const maxCompileLatency = 100 * time.Millisecond
