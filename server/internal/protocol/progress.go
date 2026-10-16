package protocol

// Outcomes earn, not effort: what counts is work that went into the main branch, never commands run or tokens spent
// (.agents/notes/implemented/feature/2026-10-11-achievements.md). Nothing here changes what it is given: what it changes, it copies.

import (
	"maps"
	"math"
	"slices"
	"time"
)

func CommitsForLevel(level int64) int64 {
	var total int64
	for l := int64(1); l < level; l++ {
		total += XPToNext(l)
	}
	return total
}

type AchievementCategory string

const (
	AchievementCategoryStarter AchievementCategory = "starter"
	AchievementCategoryHarvest AchievementCategory = "harvest"
	AchievementCategoryCraft   AchievementCategory = "craft"
	AchievementCategoryThrift  AchievementCategory = "thrift"
	AchievementCategoryTeam    AchievementCategory = "team"
	AchievementCategorySecret  AchievementCategory = "secret"
)

var CategoryText = map[AchievementCategory]string{
	AchievementCategoryStarter: "新手任务",
	AchievementCategoryHarvest: "收成",
	AchievementCategoryCraft:   "手艺",
	AchievementCategoryThrift:  "精打细算",
	AchievementCategoryTeam:    "协作",
	AchievementCategorySecret:  "彩蛋",
}

type AchievementDef struct {
	ID       string              `json:"id"`
	Category AchievementCategory `json:"category"`
	// TierTitles: none, or three.
	Title      string   `json:"title"`
	TierTitles []string `json:"tierTitles,omitzero"`
	Detail     string   `json:"detail"`
	// Three for bronze, silver and gold; one for a one-off.
	Tiers []int64 `json:"tiers"`
	Unit  string  `json:"unit,omitzero"`
}

var Achievements = []AchievementDef{
	// One each, in this order.
	{ID: "s_open", Category: AchievementCategoryStarter, Title: "开门", Detail: "开工", Tiers: []int64{1}},
	{ID: "s_hire", Category: AchievementCategoryStarter, Title: "派活", Detail: "派出第一个帮工", Tiers: []int64{1}},
	{ID: "s_tell", Category: AchievementCategoryStarter, Title: "带话", Detail: "给帮工带一句话：浇水，或者在它的工单串里说", Tiers: []int64{1}},
	{ID: "s_review", Category: AchievementCategoryStarter, Title: "验收", Detail: "看过收成清单，再收进主分支", Tiers: []int64{1}},
	{ID: "s_voice", Category: AchievementCategoryStarter, Title: "说话", Detail: "用语音和管家说一次话", Tiers: []int64{1}},
	{ID: "s_plan", Category: AchievementCategoryStarter, Title: "规划", Detail: "拆一张种植计划", Tiers: []int64{1}},
	{ID: "s_call", Category: AchievementCategoryStarter, Title: "点名", Detail: "在田头 @ 一个帮工", Tiers: []int64{1}},

	{ID: "harvests", Category: AchievementCategoryHarvest, Title: "收成", TierTitles: []string{"开张大吉", "小有收成", "粮仓满了"}, Detail: "收进主分支的活", Tiers: []int64{1, 20, 100}, Unit: "件"},
	{ID: "first_try", Category: AchievementCategoryHarvest, Title: "一气呵成", Detail: "第一轮就做完、没带过话、没失败过就收进去的活", Tiers: []int64{1, 10, 50}, Unit: "件"},
	{ID: "big_playbook", Category: AchievementCategoryHarvest, Title: "五谷丰登", Detail: "收获的种植计划里，合进去的步数最多的一张", Tiers: []int64{3, 5, 10}, Unit: "步"},
	{ID: "farm_level", Category: AchievementCategoryHarvest, Title: "农场规模", TierTitles: []string{"小有规模", "远近闻名", "一方粮仓"}, Detail: "农场的等级（跟着你的 commit 数长）", Tiers: []int64{5, 10, 20}, Unit: "级"},

	{ID: "steady", Category: AchievementCategoryCraft, Title: "稳如老农", Detail: "最长连胜：连着收进去，中间没有一轮失败", Tiers: []int64{5, 15, 40}, Unit: "件"},
	{ID: "untangle", Category: AchievementCategoryCraft, Title: "解铃人", Detail: "冲突过、最后还是收进去的活", Tiers: []int64{1, 5, 20}, Unit: "件"},
	{ID: "comeback", Category: AchievementCategoryCraft, Title: "浴火重生", Detail: "没做成过、修好以后收进去的活", Tiers: []int64{1, 5, 20}, Unit: "件"},

	{ID: "thrifty", Category: AchievementCategoryThrift, Title: "一分钱一分货", Detail: "花不到 ¥0.05 就收进去的活（只算知道花费的农机）", Tiers: []int64{1, 10, 50}, Unit: "件"},
	{ID: "every_machine", Category: AchievementCategoryThrift, Title: "物尽其用", Detail: "收进过活的农机种数", Tiers: []int64{2, 3, 5}, Unit: "种"},

	{ID: "handoff", Category: AchievementCategoryTeam, Title: "交接", Detail: "帮工在田头点名另一个帮工，对方回了话", Tiers: []int64{1, 5, 20}, Unit: "次"},
	{ID: "parallel_plan", Category: AchievementCategoryTeam, Title: "运筹帷幄", Detail: "有一批步骤同时做的种植计划，收获了", Tiers: []int64{1, 3, 10}, Unit: "张"},

	{ID: "night_owl", Category: AchievementCategorySecret, Title: "夜猫子", Detail: "深夜（0–5 点）收进一件活", Tiers: []int64{1}},
	{ID: "weekend", Category: AchievementCategorySecret, Title: "周末农夫", Detail: "周末收进一件活", Tiers: []int64{1}},
	{ID: "full_house", Category: AchievementCategorySecret, Title: "满园春色", Detail: "六块地同时有帮工在干活", Tiers: []int64{1}},
}

func AchievementOf(id string) *AchievementDef {
	for i := range Achievements {
		if Achievements[i].ID == id {
			return &Achievements[i]
		}
	}
	return nil
}

func TierTitle(a AchievementDef, tier int64) string {
	if tier >= 1 && tier <= int64(len(a.TierTitles)) {
		return a.TierTitles[tier-1]
	}
	switch tier {
	case 2:
		return "银牌" + a.Title
	case 3:
		return "金牌" + a.Title
	}
	return a.Title
}

func IsTitle(a AchievementDef) bool { return a.Category != AchievementCategoryStarter }

func TierOf(p Progress, id string) int64 {
	var t int64
	for _, u := range p.Unlocked {
		if u.ID == id && u.Tier > t {
			t = u.Tier
		}
	}
	return t
}

func TierCoins(a AchievementDef, tier int64) int64 {
	switch a.Category {
	case AchievementCategoryStarter:
		return 20
	case AchievementCategorySecret:
		return 50
	}
	if tier >= 1 && tier <= 3 {
		return []int64{0, 10, 30, 60}[tier]
	}
	return 0
}

func StreakMultiplier(streak int64) float64 {
	return math.Min(2, 1+0.1*float64(max(0, streak-1)))
}

func HarvestCoins(commits, streak int64) int64 {
	return progressRound(float64(30+min(commits*5, 30)) * StreakMultiplier(streak))
}

func PlaybookCoins(merged int64) int64 { return 30 + 10*merged }

// cheapCNY: under this, a harvested job is cheap (一分钱一分货).
const cheapCNY = 0.05

// progressRound is JavaScript's Math.round: halves go up.
func progressRound(x float64) int64 { return int64(math.Floor(x + 0.5)) }

type Seen struct {
	Told       []string `json:"told"`
	Failed     []string `json:"failed"`
	Conflicted []string `json:"conflicted"`
	Reviewed   []string `json:"reviewed"`
	Runtimes   []string `json:"runtimes"`
}

type Folded struct {
	Progress Progress `json:"progress"`
	Seen     Seen     `json:"seen"`
}

func EmptyProgress() Progress {
	return Progress{Coins: 0, Streak: 0, BestStreak: 0, Counts: map[string]int64{}, Unlocked: []Unlock{}}
}

func EmptyFolded() Folded {
	return Folded{Progress: EmptyProgress(), Seen: Seen{Told: []string{}, Failed: []string{}, Conflicted: []string{}, Reviewed: []string{}, Runtimes: []string{}}}
}

// Never list's own array.
func progressAdd(list []string, item string) []string {
	if slices.Contains(list, item) {
		return list
	}
	return append(slices.Clip(list), item)
}

func progressBump(counts map[string]int64, id string, by int64) map[string]int64 {
	next := maps.Clone(counts)
	if next == nil {
		next = map[string]int64{}
	}
	next[id] += by
	return next
}

func progressAtLeast(counts map[string]int64, id string, value int64) map[string]int64 {
	if counts[id] >= value {
		return counts
	}
	next := maps.Clone(counts)
	if next == nil {
		next = map[string]int64{}
	}
	next[id] = value
	return next
}

func progressTallied(p Progress, e LedgerEntryValue) Progress {
	var agent *string
	var bump func(*AgentTally)
	switch v := e.(type) {
	case LedgerEntryHired:
		agent, bump = v.Agent, func(t *AgentTally) { t.Hired++ }
	case LedgerEntryHarvested:
		agent, bump = v.Agent, func(t *AgentTally) { t.Harvested++ }
	case LedgerEntryFailed:
		agent, bump = v.Agent, func(t *AgentTally) { t.Failed++ }
	}
	if agent == nil || *agent == "" {
		return p
	}
	agents := maps.Clone(p.Agents)
	if agents == nil {
		agents = map[string]AgentTally{}
	}
	was := agents[*agent]
	bump(&was)
	agents[*agent] = was
	p.Agents = agents
	return p
}

func progressAtOf(e LedgerEntryValue) int64 {
	switch v := e.(type) {
	case LedgerEntryHarvested:
		return v.At
	case LedgerEntryFailed:
		return v.At
	case LedgerEntryConflicted:
		return v.At
	case LedgerEntryTold:
		return v.At
	case LedgerEntryReviewed:
		return v.At
	case LedgerEntryPlaybook:
		return v.At
	case LedgerEntryHandoff:
		return v.At
	case LedgerEntryCalled:
		return v.At
	case LedgerEntryHired:
		return v.At
	case LedgerEntryOpenedPlannedVoiceBusy6:
		return v.At
	case LedgerEntryLevel:
		return v.At
	case LedgerEntryTitled:
		return v.At
	case LedgerEntryCarried:
		return v.At
	}
	return 0
}

// Night and weekend are told in the server's own time zone (time.Local), as JavaScript's Date does.
func ProgressStep(folded Folded, entry LedgerEntry) (Folded, ProgressNews) {
	p, seen := folded.Progress, folded.Seen
	counts := p.Counts
	var coins int64
	helper := ""
	at := progressAtOf(entry.Value)
	switch e := entry.Value.(type) {
	case LedgerEntryHarvested:
		streak := p.Streak + 1
		p.Streak, p.BestStreak = streak, max(p.BestStreak, streak)
		coins += HarvestCoins(e.Commits, streak)
		helper = e.Helper
		told := slices.Contains(seen.Told, e.Helper)
		failed := slices.Contains(seen.Failed, e.Helper)
		counts = progressBump(counts, "harvests", 1)
		if e.Turns <= 1 && !told && !failed {
			counts = progressBump(counts, "first_try", 1)
		}
		if slices.Contains(seen.Conflicted, e.Helper) {
			counts = progressBump(counts, "untangle", 1)
		}
		if failed {
			counts = progressBump(counts, "comeback", 1)
		}
		if e.CNY != nil && *e.CNY < cheapCNY {
			counts = progressBump(counts, "thrifty", 1)
		}
		if slices.Contains(seen.Reviewed, e.Helper) {
			counts = progressAtLeast(counts, "s_review", 1)
		}
		seen.Runtimes = progressAdd(seen.Runtimes, e.Runtime)
		counts = maps.Clone(counts)
		counts["every_machine"] = int64(len(seen.Runtimes))
		when := time.UnixMilli(e.At).Local()
		if when.Hour() < 5 {
			counts = progressAtLeast(counts, "night_owl", 1)
		}
		if day := when.Weekday(); day == time.Sunday || day == time.Saturday {
			counts = progressAtLeast(counts, "weekend", 1)
		}
	case LedgerEntryFailed:
		p.Streak = 0
		seen.Failed = progressAdd(seen.Failed, e.Helper)
	case LedgerEntryConflicted:
		seen.Conflicted = progressAdd(seen.Conflicted, e.Helper)
	case LedgerEntryTold:
		seen.Told = progressAdd(seen.Told, e.Helper)
		counts = progressAtLeast(counts, "s_tell", 1)
	case LedgerEntryReviewed:
		seen.Reviewed = progressAdd(seen.Reviewed, e.Helper)
	case LedgerEntryPlaybook:
		coins += PlaybookCoins(e.Merged)
		counts = progressAtLeast(counts, "big_playbook", e.Merged)
		if e.Parallel {
			counts = progressBump(counts, "parallel_plan", 1)
		}
	case LedgerEntryHandoff:
		counts = progressBump(counts, "handoff", 1)
	case LedgerEntryCalled:
		counts = progressAtLeast(counts, "s_call", 1)
	case LedgerEntryHired:
		counts = progressAtLeast(counts, "s_hire", 1)
	case LedgerEntryOpenedPlannedVoiceBusy6:
		switch e.Kind {
		case LedgerEntryOpenedPlannedVoiceBusy6KindOpened:
			counts = progressAtLeast(counts, "s_open", 1)
		case LedgerEntryOpenedPlannedVoiceBusy6KindPlanned:
			counts = progressAtLeast(counts, "s_plan", 1)
		case LedgerEntryOpenedPlannedVoiceBusy6KindVoice:
			counts = progressAtLeast(counts, "s_voice", 1)
		case LedgerEntryOpenedPlannedVoiceBusy6KindBusy6:
			counts = progressAtLeast(counts, "full_house", 1)
		}
	case LedgerEntryLevel:
		counts = progressAtLeast(counts, "farm_level", e.Level)
	case LedgerEntryTitled:
		// Only a tier reached can be worn, and not a starter task's; anything else takes the title off.
		p.Title = nil
		if e.Achievement != nil && *e.Achievement != "" && e.Tier != nil && *e.Tier != 0 {
			if worn := AchievementOf(*e.Achievement); worn != nil && IsTitle(*worn) && TierOf(p, worn.ID) >= *e.Tier {
				p.Title = &ProgressTitle{ID: worn.ID, Tier: *e.Tier}
			}
		}
	case LedgerEntryCarried:
		coins += e.Coins
	}
	counts = progressAtLeast(counts, "steady", p.BestStreak)

	// Tiers reached by this entry: each earns its coins once.
	var unlocked []Unlock
	for _, a := range Achievements {
		count := counts[a.ID]
		had := TierOf(p, a.ID)
		for i, need := range a.Tiers {
			if tier := int64(i + 1); tier > had && count >= need {
				unlocked = append(unlocked, Unlock{ID: a.ID, Tier: tier, At: at})
				coins += TierCoins(a, tier)
			}
		}
	}
	next := progressTallied(p, entry.Value)
	next.Coins = p.Coins + coins
	next.Counts = counts
	next.Unlocked = append(slices.Clip(p.Unlocked), unlocked...)
	var news ProgressNews
	if coins != 0 {
		news.Coins = &coins
	}
	if helper != "" {
		news.Helper = &helper
	}
	if len(unlocked) > 0 {
		news.Unlocked = unlocked
	}
	return Folded{Progress: next, Seen: seen}, news
}

func ProgressFold(entries []LedgerEntry, from Folded) Folded {
	for _, e := range entries {
		from, _ = ProgressStep(from, e)
	}
	return from
}

func ProgressOf(entries []LedgerEntry) Progress { return ProgressFold(entries, EmptyFolded()).Progress }

const fullHouse = 6

func progressWorking(state FarmState) int {
	n := 0
	for _, h := range state.Helpers {
		if _, ok := h.Phase.Value.(PhaseWorking); ok {
			n++
		}
	}
	return n
}

func progressPlaybookEntry(pb Playbook) LedgerEntry {
	merged := map[string]bool{}
	for _, n := range pb.Nodes {
		if n.State == NodeStateMerged {
			merged[n.ID] = true
		}
	}
	parallel := slices.ContainsFunc(LayersOf(pb.Nodes), func(layer []string) bool {
		n := 0
		for _, id := range layer {
			if merged[id] {
				n++
			}
		}
		return n >= 2
	})
	return LedgerEntry{LedgerEntryPlaybook{Playbook: pb.ID, Merged: int64(len(merged)), Parallel: parallel}}
}

// Only what the person does in the app (a voice call, a review, coins carried, a title) is recorded where it happens: everything the farm does is
// told by its facts.
func EntriesFor(before FarmState, fact Fact, after FarmState) []LedgerEntry {
	out := []LedgerEntry{}
	switch f := fact.Value.(type) {
	case FactReport:
		h := HelperOf(after, f.ID)
		if h == nil {
			h = HelperOf(before, f.ID)
		}
		if f.Outcome == OutcomeFailed {
			e := LedgerEntryFailed{Helper: f.ID}
			if h != nil && h.Agent != "" {
				agent := h.Agent
				e.Agent = &agent
			}
			out = append(out, LedgerEntry{e})
		}
	case FactConflict:
		if f.Conflict != nil {
			out = append(out, LedgerEntry{LedgerEntryConflicted{Helper: f.ID}})
		}
	case FactCall:
		if f.State == CallStateLive {
			out = append(out, LedgerEntry{LedgerEntryOpenedPlannedVoiceBusy6{Kind: LedgerEntryOpenedPlannedVoiceBusy6KindOpened}})
		}
	case FactHired:
		agent := f.Helper.Agent
		out = append(out, LedgerEntry{LedgerEntryHired{Helper: f.Helper.ID, Agent: &agent}})
	case FactIssue:
		if f.Issue.Plan == nil {
			break
		}
		var was *PlaybookState
		if pb := PlaybookOf(before, f.Issue.ID); pb != nil {
			was = &pb.State
		}
		now := f.Issue.Plan.State
		if now == PlaybookStateDraft && was != nil && *was == PlaybookStatePlanning {
			out = append(out, LedgerEntry{LedgerEntryOpenedPlannedVoiceBusy6{Kind: LedgerEntryOpenedPlannedVoiceBusy6KindPlanned}})
		}
		if now == PlaybookStateDone && (was == nil || *was != PlaybookStateDone) {
			if pb := PlaybookOf(after, f.Issue.ID); pb != nil {
				out = append(out, progressPlaybookEntry(*pb))
			}
		}
	case FactLeft:
		// Harvested: only when something went into the main branch, which is what earns.
		h := HelperOf(before, f.ID)
		if h != nil && f.Closed != nil && *f.Closed == IssueCloseHarvested && f.Merged != nil && *f.Merged > 0 {
			agent := h.Agent
			e := LedgerEntryHarvested{Helper: f.ID, Agent: &agent, Runtime: h.Runtime, Commits: *f.Merged, Turns: h.Turns}
			if h.Project != nil {
				e.Project = *h.Project
			}
			if h.Spent != nil && h.Spent.CNY != nil {
				cny := *h.Spent.CNY
				e.CNY = &cny
			}
			out = append(out, LedgerEntry{e})
		}
	case FactMessage:
		if !progressNewMessage(before, f.Message.Seq) {
			break
		}
		switch f.Message.FromKind {
		case SenderKindUser:
			if f.Thread != nil {
				out = append(out, LedgerEntry{LedgerEntryTold{Helper: *f.Thread}})
			}
			for _, named := range f.Message.Mentions {
				if named != "foreman" && named != "user" && named != Everyone && HelperOf(before, named) != nil {
					out = append(out, LedgerEntry{LedgerEntryCalled{Helper: named}})
				}
			}
		case SenderKindHelper:
			if f.Answers != nil {
				out = append(out, LedgerEntry{LedgerEntryHandoff{Helper: *f.Answers, To: f.Message.From}})
			}
		}
	case FactCommits:
		level, _ := LevelForCommits(f.Commits.Total)
		var total int64
		if before.Commits != nil {
			total = before.Commits.Total
		}
		if was, _ := LevelForCommits(total); level > was {
			out = append(out, LedgerEntry{LedgerEntryLevel{Level: level}})
		}
	}
	// Six beds busy: once for each time the farm fills up.
	if progressWorking(before) < fullHouse && progressWorking(after) >= fullHouse {
		out = append(out, LedgerEntry{LedgerEntryOpenedPlannedVoiceBusy6{Kind: LedgerEntryOpenedPlannedVoiceBusy6KindBusy6}})
	}
	return out
}

// progressNewMessage is whether a message is new to the state: the manager's words change as they stream in, and count
// once.
func progressNewMessage(state FarmState, seq int64) bool {
	return state.Chat == nil || !slices.ContainsFunc(state.Chat.Messages, func(m ChatMessage) bool { return m.Seq == seq })
}

func CatchUp(state FarmState) []LedgerEntry {
	var total int64
	if state.Commits != nil {
		total = state.Commits.Total
	}
	level, _ := LevelForCommits(total)
	known := int64(1)
	if state.Progress != nil {
		if v, ok := state.Progress.Counts["farm_level"]; ok {
			known = v
		}
	}
	if level > known {
		return []LedgerEntry{{LedgerEntryLevel{Level: level}}}
	}
	return []LedgerEntry{}
}

type AchievementStanding struct {
	Tier  int64  `json:"tier"`
	Count int64  `json:"count"`
	Next  *int64 `json:"next,omitzero"`
}

func Standing(p Progress, a AchievementDef) AchievementStanding {
	tier := TierOf(p, a.ID)
	out := AchievementStanding{Tier: tier, Count: p.Counts[a.ID]}
	if tier >= 0 && tier < int64(len(a.Tiers)) {
		next := a.Tiers[tier]
		out.Next = &next
	}
	return out
}
