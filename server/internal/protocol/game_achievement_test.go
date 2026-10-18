package protocol

import (
	"slices"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestAchievementsInWords(t *testing.T) {
	all := AchievementsInWords()
	testkit.Eq(t, len(all), len(Achievements), "every one")
	byID := map[string]Achievement{}
	for i, a := range all {
		testkit.Eq(t, a.ID, Achievements[i].ID, "in the page's order", i)
		testkit.Eq(t, len(a.Tiers), len(Achievements[i].Tiers), "every tier", a.ID)
		byID[a.ID] = a
	}
	harvests := byID["harvests"]
	testkit.Eq(t, harvests.Tiers[0], AchievementTier{Need: 1, Title: "开张大吉", Coins: 10, Reached: "解锁成就"}, "its own tier titles")
	testkit.Eq(t, harvests.Tiers[2].Reached, "升到金牌")
	testkit.Eq(t, harvests.Wearable, true, "worn as a title")
	steady := byID["steady"]
	testkit.Eq(t, []string{steady.Tiers[0].Title, steady.Tiers[1].Title, steady.Tiers[2].Title}, []string{"稳如老农", "银牌稳如老农", "金牌稳如老农"}, "silver and gold before the title")
	testkit.Eq(t, steady.Tiers[1].Reached, "升到银牌")
	open := byID["s_open"]
	testkit.Eq(t, open.Wearable, false, "a starter task is not a title")
	testkit.Eq(t, open.Tiers, []AchievementTier{{Need: 1, Title: "开门", Coins: 20, Reached: "新手任务做完了"}}, "a starter task")
	testkit.Eq(t, byID["night_owl"].Tiers[0].Reached, "发现一个彩蛋")
	testkit.Eq(t, byID["night_owl"].Tiers[0].Coins, int64(50))
}

func TestTheViewSaysHowFarEachAchievementIs(t *testing.T) {
	state := EmptyCoreState()
	testkit.Eq(t, ViewOf(state).Achievements[0], AchievementStanding{ID: "s_open", Next: ptr.To[int64](1)}, "none yet, with no progress")
	state.Progress = &Progress{
		Counts:   map[string]int64{"harvests": 25, "s_open": 1},
		Unlocked: []Unlock{{ID: "harvests", Tier: 1, At: 1}, {ID: "harvests", Tier: 2, At: 2}, {ID: "s_open", Tier: 1, At: 1}},
	}
	view := ViewOf(state)
	ids := []string{}
	for _, s := range view.Achievements {
		ids = append(ids, s.ID)
	}
	want := []string{}
	for _, a := range Achievements {
		want = append(want, a.ID)
	}
	testkit.Eq(t, ids, want, "every one, in the page's order")
	at := func(id string) AchievementStanding {
		return view.Achievements[slices.IndexFunc(view.Achievements, func(s AchievementStanding) bool { return s.ID == id })]
	}
	testkit.Eq(t, at("harvests"), AchievementStanding{ID: "harvests", Tier: 2, Count: 25, Next: ptr.To[int64](100)}, "silver, gold at 100")
	testkit.Eq(t, at("s_open"), AchievementStanding{ID: "s_open", Tier: 1, Count: 1}, "all reached: no next")
	testkit.Eq(t, at("steady"), AchievementStanding{ID: "steady", Next: ptr.To[int64](5)}, "none yet")
}

func TestAnAchievementsEffectSaysIt(t *testing.T) {
	before := EmptyCoreState()
	effects := EffectsOf(before, Fact{FactProgress{Progress: Progress{}, News: &ProgressNews{Unlocked: []Unlock{{ID: "harvests", Tier: 3}, {ID: "weekend", Tier: 1}}}}})
	testkit.Eq(t, effects, []GameEffect{
		{GameEffectAchievement{Achievement: "harvests", Tier: 3, Title: "粮仓满了", Reached: "升到金牌", Detail: "收进主分支的活", Coins: 60}},
		{GameEffectAchievement{Achievement: "weekend", Tier: 1, Title: "周末农夫", Reached: "发现一个彩蛋", Detail: "周末收进一件活", Coins: 50, OneOff: true}},
	})
}

func TestTheFrameSaysWhatEachActionIs(t *testing.T) {
	state := EmptyCoreState()
	state.Sessions = []Session{{
		ID:    "w1",
		Phase: Phase{PhaseWorking{Since: 1, Doing: Doing{Action: SessionActionRunCommand, Label: "go test"}}},
		Play:  &SessionPlay{History: []ActionStep{{At: 1, Action: SessionActionReadFile, Label: "a.go"}, {At: 2, Action: SessionActionRunCommand, Label: "go test"}}},
	}}
	frame := FrameOf(state, nil)
	doing := frame.State.Sessions[0].Phase.Value.(PhaseWorking).Doing
	testkit.Eq(t, doing.ActionText, "跑命令", "what it is doing")
	history := frame.State.Sessions[0].Play.History
	testkit.Eq(t, []string{history[0].ActionText, history[1].ActionText}, []string{"读文件", "跑命令"}, "each step")
	testkit.Eq(t, state.Sessions[0].Phase.Value.(PhaseWorking).Doing.ActionText, "", "the state's phase keeps none")
	testkit.Eq(t, state.Sessions[0].Play.History[0].ActionText, "", "nor its history")
}
