package protocol

import (
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestPhaseText(t *testing.T) {
	working := Worker{ID: "w1", Phase: Phase{PhaseWorking{Since: 2, Doing: Doing{Action: WorkerActionRunCommand, Label: "pnpm test"}}}}
	testkit.Eq(t, PhaseText(working, 4), "在跑命令：pnpm test")
	testkit.Eq(t, IsBusy(working), true)
	testkit.Eq(t, DoingOf(working).Label, "pnpm test")
	quiet := working
	quiet.Phase = Phase{PhaseWorking{Since: 2, Doing: Doing{Action: WorkerActionRunCommand, Label: "pnpm test"}, QuietSince: ptr.To[int64](3)}}
	testkit.Match(t, PhaseText(quiet, 240_003), `4 分钟没动静了`)
	testkit.Match(t, PhaseText(quiet, 503), `（已经 1 秒没动静了）`)
	retrying := working
	retrying.Phase = Phase{PhaseWorking{Since: 2, Doing: Doing{Action: WorkerActionThinking}, Retry: &Retry{Attempt: 2, Of: ptr.To[int64](3)}}}
	testkit.Match(t, PhaseText(retrying, 4), `重试第 2/3 次`)
	resting := Worker{Phase: Phase{PhaseResting{}}, Conflict: &Conflict{Base: "main", Files: []string{"a.ts", "b.ts"}}}
	testkit.Eq(t, PhaseText(resting, 0), "歇着（上一轮没做完），合进 main 会冲突（a.ts、b.ts）")
	testkit.Eq(t, DoingOf(resting), Doing{Action: WorkerActionNone})
}

func TestMoneyWords(t *testing.T) {
	testkit.Eq(t, Yuan(0.004), "不到 ¥0.01")
	testkit.Eq(t, Yuan(0.125), "¥0.13")
	testkit.Eq(t, Yuan(1.005), "¥1.00", "1.005 is a little under")
}

func TestTheSameAgainIsNoNews(t *testing.T) {
	state := EmptyCoreState()
	for _, f := range []FactValue{
		FactCall{State: CallStateLive},
		FactManager{State: ManagerStateThinking},
		FactCommits{Commits: CommitCount{Total: 3}},
		FactProgress{Progress: EmptyProgress()},
	} {
		next, changed := Reduce(state, Fact{f})
		testkit.Eq(t, changed, true, "first", f)
		_, again := Reduce(next, Fact{f})
		testkit.Eq(t, again, false, "again", f)
		state = next
	}
	_, changed := Reduce(state, Fact{FactCall{State: CallStateLive, Reason: ptr.To("挂了")}})
	testkit.Eq(t, changed, true, "a new reason is news")
}

func TestEveryActionHasWords(t *testing.T) {
	for _, a := range WorkerActionValues {
		if _, ok := ActionText[a]; !ok {
			t.Errorf("seeds.json's actionText has no %s", a)
		}
	}
}
