// Package clock is time as the farm keeps it: Unix milliseconds, and waits a context can cut short.
package clock

import (
	"context"
	"time"
)

func NowMs() int64 { return time.Now().UnixMilli() }

// Sleep waits d, and says false when ctx ended first.
func Sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
