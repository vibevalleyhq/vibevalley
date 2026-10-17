package runtime

import (
	"context"
	"sync/atomic"
	"testing"

	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
)

func TestASlowProbeDoesNotOverwriteANewerOne(t *testing.T) {
	r := &Service{core: core.New(t.TempDir()), cache: map[string]protocol.RuntimeInfo{}, reads: map[string]uint64{}, readOf: map[string]uint64{}}
	release := make(chan struct{})
	var probes atomic.Int64
	r.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
		n := probes.Add(1)
		if n == 1 {
			<-release
		}
		return protocol.RuntimeInfo{ID: id, CheckedAt: n}
	}
	slow := make(chan struct{})
	go func() {
		r.Refresh(context.Background(), "pi")
		close(slow)
	}()
	testkit.Until(t, "the first probe started", func() bool { return probes.Load() == 1 })
	testkit.Eq(t, r.Refresh(context.Background(), "pi").CheckedAt, int64(2), "the second, quick")
	close(release)
	<-slow
	testkit.Eq(t, r.Info(context.Background(), "pi").CheckedAt, int64(2), "the first, which started earlier, is dropped")
}
