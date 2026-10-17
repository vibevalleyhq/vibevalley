package manager

import (
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/clock"
)

func TestPatrolWakesTheManagerOnce(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	news, stop := f.Manager.News().Subscribe()
	defer stop()
	start := clock.NowMs()
	var clock atomic.Int64
	clock.Store(start)
	f.Manager.PatrolNow = clock.Load

	f.Core.Apply(protocol.FactHired{Session: protocol.Session{ID: "w7", Name: "实验员", Agent: "lab", Runtime: "pi", Task: "加个 CHANGELOG", HiredAt: start, Phase: protocol.Phase{Value: protocol.PhaseWorking{Since: start}}}})
	f.Core.Apply(protocol.FactReport{ID: "w7", Outcome: protocol.OutcomeCompleted, Summary: "加好了", Runs: 1})
	quiet := func(why string) {
		t.Helper()
		select {
		case n := <-news:
			t.Fatalf("%s: %+v", why, n)
		case <-time.After(50 * time.Millisecond):
		}
	}
	f.Manager.Patrol()
	quiet("not yet past its grace")
	clock.Add(3 * 3_600_000)
	f.Manager.Patrol()
	select {
	case n := <-news:
		if n.Channel != f.Channel.General() || !strings.HasPrefix(n.Text, "【巡查】#田头 里有几件事放着没人管：\n") ||
			!strings.Contains(n.Text, "实验员（w7）的活做完 3 小时了还没收：「加个 CHANGELOG」") {
			t.Fatalf("news: %+v", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no news")
	}
	clock.Add(3_600_000 / 2)
	f.Manager.Patrol()
	quiet("reported once")
}
