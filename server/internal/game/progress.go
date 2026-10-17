package game

// The ledger's fold: what each entry pays and unlocks, and which entries a fact makes. Outcomes earn, not effort: what
// counts is work that went into the main branch, never commands run or tokens spent
// (.agents/notes/implemented/feature/2026-10-11-achievements.md). Nothing here changes what it is given: what it changes, it
// copies.

import (
	"maps"
	"math"
	"slices"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/num"
)

func achievementOf(id string) *protocol.AchievementDef {
	for i := range protocol.Achievements {
		if protocol.Achievements[i].ID == id {
			return &protocol.Achievements[i]
		}
	}
	return nil
}

func isTitle(a protocol.AchievementDef) bool {
	return a.Category != protocol.AchievementCategoryStarter
}

func tierOf(p protocol.Progress, id string) int64 {
	var t int64
	for _, u := range p.Unlocked {
		if u.ID == id && u.Tier > t {
			t = u.Tier
		}
	}
	return t
}

// What reaching that tier (from 1) pays: seeds.json says, for each achievement.
func tierCoins(a protocol.AchievementDef, tier int64) int64 {
	if tier < 1 || tier > int64(len(a.Coins)) {
		return 0
	}
	return a.Coins[tier-1]
}

func streakMultiplier(streak int64) float64 {
	// The conversion stops Go fusing it into one FMA (on arm64): JavaScript's 1+0.1*7 is 1.7000000000000002, not 1.7.
	return math.Min(2, 1+float64(0.1*float64(max(0, streak-1))))
}

func harvestCoins(commits, streak int64) int64 {
	return int64(num.Round(float64(30+min(commits*5, 30)) * streakMultiplier(streak)))
}

func playbookCoins(merged int64) int64 { return 30 + 10*merged }

// cheapCNY: under this, a harvested job is cheap (一分钱一分货).
const cheapCNY = 0.05

// progressRound is JavaScript's Math.round: halves go up.
type ledgerSeen struct {
	Told       []string `json:"told"`
	Failed     []string `json:"failed"`
	Conflicted []string `json:"conflicted"`
	Reviewed   []string `json:"reviewed"`
	Runtimes   []string `json:"runtimes"`
}

type ledgerFolded struct {
	Progress protocol.Progress `json:"progress"`
	Seen     ledgerSeen        `json:"seen"`
}

func emptyFolded() ledgerFolded {
	return ledgerFolded{Progress: protocol.EmptyProgress(), Seen: ledgerSeen{Told: []string{}, Failed: []string{}, Conflicted: []string{}, Reviewed: []string{}, Runtimes: []string{}}}
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

func progressTallied(p protocol.Progress, e protocol.LedgerEntryValue) protocol.Progress {
	var agent *string
	var bump func(*protocol.AgentTally)
	switch v := e.(type) {
	case protocol.LedgerEntryHired:
		agent, bump = v.Agent, func(t *protocol.AgentTally) { t.Hired++ }
	case protocol.LedgerEntryHarvested:
		agent, bump = v.Agent, func(t *protocol.AgentTally) { t.Harvested++ }
	case protocol.LedgerEntryFailed:
		agent, bump = v.Agent, func(t *protocol.AgentTally) { t.Failed++ }
	}
	if agent == nil || *agent == "" {
		return p
	}
	agents := maps.Clone(p.Agents)
	if agents == nil {
		agents = map[string]protocol.AgentTally{}
	}
	was := agents[*agent]
	bump(&was)
	agents[*agent] = was
	p.Agents = agents
	return p
}

func progressAtOf(e protocol.LedgerEntryValue) int64 {
	switch v := e.(type) {
	case protocol.LedgerEntryHarvested:
		return v.At
	case protocol.LedgerEntryFailed:
		return v.At
	case protocol.LedgerEntryConflicted:
		return v.At
	case protocol.LedgerEntryTold:
		return v.At
	case protocol.LedgerEntryReviewed:
		return v.At
	case protocol.LedgerEntryPlaybook:
		return v.At
	case protocol.LedgerEntryHandoff:
		return v.At
	case protocol.LedgerEntryCalled:
		return v.At
	case protocol.LedgerEntryHired:
		return v.At
	case protocol.LedgerEntryMoment:
		return v.At
	case protocol.LedgerEntryLevel:
		return v.At
	case protocol.LedgerEntryTitled:
		return v.At
	case protocol.LedgerEntryCarried:
		return v.At
	}
	return 0
}

// Night and weekend are told in the server's own time zone (time.Local), as JavaScript's Date does.
func progressStep(folded ledgerFolded, entry protocol.LedgerEntry) (ledgerFolded, protocol.ProgressNews) {
	p, seen := folded.Progress, folded.Seen
	counts := p.Counts
	var coins int64
	session := ""
	at := progressAtOf(entry.Value)
	switch e := entry.Value.(type) {
	case protocol.LedgerEntryHarvested:
		streak := p.Streak + 1
		p.Streak, p.BestStreak = streak, max(p.BestStreak, streak)
		coins += harvestCoins(e.Commits, streak)
		session = e.Session
		told := slices.Contains(seen.Told, e.Session)
		failed := slices.Contains(seen.Failed, e.Session)
		counts = progressBump(counts, "harvests", 1)
		if e.Runs <= 1 && !told && !failed {
			counts = progressBump(counts, "first_try", 1)
		}
		if slices.Contains(seen.Conflicted, e.Session) {
			counts = progressBump(counts, "untangle", 1)
		}
		if failed {
			counts = progressBump(counts, "comeback", 1)
		}
		if e.CNY != nil && *e.CNY < cheapCNY {
			counts = progressBump(counts, "thrifty", 1)
		}
		if slices.Contains(seen.Reviewed, e.Session) {
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
	case protocol.LedgerEntryFailed:
		p.Streak = 0
		seen.Failed = progressAdd(seen.Failed, e.Session)
	case protocol.LedgerEntryConflicted:
		seen.Conflicted = progressAdd(seen.Conflicted, e.Session)
	case protocol.LedgerEntryTold:
		seen.Told = progressAdd(seen.Told, e.Session)
		counts = progressAtLeast(counts, "s_tell", 1)
	case protocol.LedgerEntryReviewed:
		seen.Reviewed = progressAdd(seen.Reviewed, e.Session)
	case protocol.LedgerEntryPlaybook:
		coins += playbookCoins(e.Merged)
		counts = progressAtLeast(counts, "big_playbook", e.Merged)
		if e.Parallel {
			counts = progressBump(counts, "parallel_plan", 1)
		}
	case protocol.LedgerEntryHandoff:
		counts = progressBump(counts, "handoff", 1)
	case protocol.LedgerEntryCalled:
		counts = progressAtLeast(counts, "s_call", 1)
	case protocol.LedgerEntryHired:
		counts = progressAtLeast(counts, "s_hire", 1)
	case protocol.LedgerEntryMoment:
		switch e.Kind {
		case protocol.LedgerEntryMomentKindOpened:
			counts = progressAtLeast(counts, "s_open", 1)
		case protocol.LedgerEntryMomentKindPlanned:
			counts = progressAtLeast(counts, "s_plan", 1)
		case protocol.LedgerEntryMomentKindVoice:
			counts = progressAtLeast(counts, "s_voice", 1)
		case protocol.LedgerEntryMomentKindBusy6:
			counts = progressAtLeast(counts, "full_house", 1)
		}
	case protocol.LedgerEntryLevel:
		counts = progressAtLeast(counts, "farm_level", e.Level)
	case protocol.LedgerEntryTitled:
		// Only a tier reached can be worn, and not a starter task's; anything else takes the title off.
		p.Title = nil
		if e.Achievement != nil && *e.Achievement != "" && e.Tier != nil && *e.Tier != 0 {
			if worn := achievementOf(*e.Achievement); worn != nil && isTitle(*worn) && tierOf(p, worn.ID) >= *e.Tier {
				p.Title = &protocol.ProgressTitle{ID: worn.ID, Tier: *e.Tier}
			}
		}
	case protocol.LedgerEntryCarried:
		coins += e.Coins
	}
	counts = progressAtLeast(counts, "steady", p.BestStreak)

	// Tiers reached by this entry: each earns its coins once.
	var unlocked []protocol.Unlock
	for _, a := range protocol.Achievements {
		count := counts[a.ID]
		had := tierOf(p, a.ID)
		for i, need := range a.Tiers {
			if tier := int64(i + 1); tier > had && count >= need {
				unlocked = append(unlocked, protocol.Unlock{ID: a.ID, Tier: tier, At: at})
				coins += tierCoins(a, tier)
			}
		}
	}
	next := progressTallied(p, entry.Value)
	next.Coins = p.Coins + coins
	next.Counts = counts
	next.Unlocked = append(slices.Clip(p.Unlocked), unlocked...)
	next.Multiplier = streakMultiplier(next.Streak)
	var news protocol.ProgressNews
	if coins != 0 {
		news.Coins = &coins
	}
	if session != "" {
		news.Session = &session
	}
	if len(unlocked) > 0 {
		news.Unlocked = unlocked
	}
	return ledgerFolded{Progress: next, Seen: seen}, news
}

func progressFold(entries []protocol.LedgerEntry, from ledgerFolded) ledgerFolded {
	for _, e := range entries {
		from, _ = progressStep(from, e)
	}
	return from
}

const fullHouse = 6

func progressWorking(state protocol.CoreState) int {
	n := 0
	for _, h := range state.Sessions {
		if _, ok := h.Phase.Value.(protocol.PhaseWorking); ok {
			n++
		}
	}
	return n
}

func progressPlaybookEntry(pb protocol.Playbook) protocol.LedgerEntry {
	merged := map[string]bool{}
	for _, n := range pb.Nodes {
		if n.State == protocol.NodeStateMerged {
			merged[n.ID] = true
		}
	}
	parallel := slices.ContainsFunc(protocol.LayersOf(pb.Nodes), func(layer []string) bool {
		n := 0
		for _, id := range layer {
			if merged[id] {
				n++
			}
		}
		return n >= 2
	})
	return protocol.LedgerEntry{Value: protocol.LedgerEntryPlaybook{Playbook: pb.ID, Merged: int64(len(merged)), Parallel: parallel}}
}

// Only what the person does in the app (a voice call, a review, coins carried, a title) is recorded where it happens: everything the farm does is
// told by its facts.
func entriesFor(before protocol.CoreState, fact protocol.Fact, after protocol.CoreState) []protocol.LedgerEntry {
	out := []protocol.LedgerEntry{}
	switch f := fact.Value.(type) {
	case protocol.FactReport:
		h := protocol.SessionOf(after, f.ID)
		if h == nil {
			h = protocol.SessionOf(before, f.ID)
		}
		if f.Outcome == protocol.OutcomeFailed {
			e := protocol.LedgerEntryFailed{Session: f.ID}
			if h != nil && h.Agent != "" {
				agent := h.Agent
				e.Agent = &agent
			}
			out = append(out, protocol.LedgerEntry{Value: e})
		}
	case protocol.FactConflict:
		if f.Conflict != nil {
			out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryConflicted{Session: f.ID}})
		}
	case protocol.FactCall:
		if f.State == protocol.CallStateLive {
			out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryMoment{Kind: protocol.LedgerEntryMomentKindOpened}})
		}
	case protocol.FactHired:
		agent := f.Session.Agent
		out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryHired{Session: f.Session.ID, Agent: &agent}})
	case protocol.FactIssue:
		if f.Issue.Plan == nil {
			break
		}
		var was *protocol.PlaybookState
		if pb := protocol.PlaybookOf(before, f.Issue.ID); pb != nil {
			was = &pb.State
		}
		now := f.Issue.Plan.State
		if now == protocol.PlaybookStateDraft && was != nil && *was == protocol.PlaybookStatePlanning {
			out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryMoment{Kind: protocol.LedgerEntryMomentKindPlanned}})
		}
		if now == protocol.PlaybookStateDone && (was == nil || *was != protocol.PlaybookStateDone) {
			if pb := protocol.PlaybookOf(after, f.Issue.ID); pb != nil {
				out = append(out, progressPlaybookEntry(*pb))
			}
		}
	case protocol.FactLeft:
		// Harvested: only when something went into the main branch, which is what earns.
		h := protocol.SessionOf(before, f.ID)
		if h != nil && f.Closed != nil && *f.Closed == protocol.IssueCloseMerged && f.Merged != nil && *f.Merged > 0 {
			agent := h.Agent
			e := protocol.LedgerEntryHarvested{Session: f.ID, Agent: &agent, Runtime: h.Runtime, Commits: *f.Merged, Runs: h.Runs}
			if h.Project != nil {
				e.Project = *h.Project
			}
			if h.Spent != nil && h.Spent.CNY != nil {
				cny := *h.Spent.CNY
				e.CNY = &cny
			}
			out = append(out, protocol.LedgerEntry{Value: e})
		}
	case protocol.FactMessage:
		if !progressNewMessage(before, f.Message.Seq) {
			break
		}
		switch f.Message.FromKind {
		case protocol.SenderKindUser:
			if f.Thread != nil {
				out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryTold{Session: *f.Thread}})
			}
			for _, named := range f.Message.Mentions {
				if named != protocol.ManagerAgent && named != "user" && named != protocol.Everyone && protocol.SessionOf(before, named) != nil {
					out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryCalled{Session: named}})
				}
			}
		case protocol.SenderKindAgent:
			if f.Answers != nil {
				out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryHandoff{Session: *f.Answers, To: f.Message.From}})
			}
		}
	case protocol.FactCommits:
		level, _ := protocol.LevelForCommits(f.Commits.Total)
		var total int64
		if before.Commits != nil {
			total = before.Commits.Total
		}
		if was, _ := protocol.LevelForCommits(total); level > was {
			out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryLevel{Level: level}})
		}
	}
	// Six beds busy: once for each time the farm fills up.
	if progressWorking(before) < fullHouse && progressWorking(after) >= fullHouse {
		out = append(out, protocol.LedgerEntry{Value: protocol.LedgerEntryMoment{Kind: protocol.LedgerEntryMomentKindBusy6}})
	}
	return out
}

// progressNewMessage is whether a message is new to the state: the manager's words change as they stream in, and count
// once.
func progressNewMessage(state protocol.CoreState, seq int64) bool {
	return state.Chat == nil || !slices.ContainsFunc(state.Chat.Messages, func(m protocol.ChatMessage) bool { return m.Seq == seq })
}

func catchUp(state protocol.CoreState) []protocol.LedgerEntry {
	var total int64
	if state.Commits != nil {
		total = state.Commits.Total
	}
	level, _ := protocol.LevelForCommits(total)
	known := int64(1)
	if state.Progress != nil {
		if v, ok := state.Progress.Counts["farm_level"]; ok {
			known = v
		}
	}
	if level > known {
		return []protocol.LedgerEntry{{Value: protocol.LedgerEntryLevel{Level: level}}}
	}
	return []protocol.LedgerEntry{}
}
