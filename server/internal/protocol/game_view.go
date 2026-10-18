package protocol

import (
	"fmt"
	"hash/fnv"
	"slices"
)

func XPToNext(level int64) int64 { return 10 * level }

func LevelForCommits(total int64) (level, xp int64) {
	level, rest := int64(1), max(0, total)
	for rest >= XPToNext(level) {
		rest -= XPToNext(level)
		level++
	}
	return level, rest
}

func FarmLevelOf(state CoreState) FarmLevel {
	var total int64
	if state.Commits != nil {
		total = state.Commits.Total
	}
	level, xp := LevelForCommits(total)
	return FarmLevel{Level: level, Xp: xp, Need: XPToNext(level)}
}

type Need struct {
	Kind     string // conflict, harvest, fix, quiet, retrying
	Conflict *Conflict
	Since    int64
	Retry    *Retry
}

func NeedOf(h Session) *Need {
	switch p := h.Phase.Value.(type) {
	case PhaseWorking:
		if p.QuietSince != nil {
			return &Need{Kind: "quiet", Since: *p.QuietSince}
		}
		if p.Retry != nil {
			return &Need{Kind: "retrying", Retry: p.Retry}
		}
	case PhaseRipe:
		if h.Conflict != nil {
			return &Need{Kind: "conflict", Conflict: h.Conflict}
		}
		return &Need{Kind: "harvest"}
	case PhaseFailed:
		return &Need{Kind: "fix"}
	case PhaseResting:
		if h.Conflict != nil {
			return &Need{Kind: "conflict", Conflict: h.Conflict}
		}
	}
	return nil
}

func ripeCrop(h Session) Crop {
	// The same session ripens to the same crop every time.
	f := fnv.New32a()
	f.Write([]byte(h.ID))
	if f.Sum32()%2 == 1 {
		return CropCarrot
	}
	return CropWheat
}

func growth(h Session) Crop {
	play := PlayOf(h)
	since := h.HiredAt
	if play.RunStartedAt != nil {
		since = *play.RunStartedAt
	}
	crop := CropSprout
	for _, step := range play.History {
		if step.At < since {
			continue
		}
		if step.Action == SessionActionEditFile && crop == CropSprout {
			crop = CropLeafy
		} else if step.Action == SessionActionRunCommand && crop == CropLeafy {
			crop = CropFlowering
		}
	}
	return crop
}

var (
	badgeRipe     = Badge{Text: "可收获", Tone: BadgeToneRipe}
	badgeBugs     = Badge{Text: "有虫", Tone: BadgeToneBug}
	badgeConflict = Badge{Text: "有冲突", Tone: BadgeToneBug}
	badgeQuiet    = Badge{Text: "没动静", Tone: BadgeToneStuck}
	badgeRetrying = Badge{Text: "重试中", Tone: BadgeToneStuck}
	badgeRest     = Badge{Text: "歇着", Tone: BadgeToneRest}
	badgeReview   = Badge{Text: "等验收", Tone: BadgeToneWait}
	badgeAsks     = Badge{Text: "缺肥", Tone: BadgeToneWait}
)

func badge(b Badge) *Badge { return &b }

// The weeds a failed acceptance left standing.
func OpenFindings(t Issue) int {
	n := 0
	for _, f := range t.Findings {
		if !f.Pulled {
			n++
		}
	}
	return n
}

// A plot is an issue: what the session on it is doing, then where the issue stands — waiting on the owner's answer
// (缺肥), its acceptance (抽穗, or weeds after a failed one), or passed (ripe).
func PlotOf(h Session, issue *Issue) PlotView {
	plot := PlotOfSession(h)
	if issue == nil {
		return plot
	}
	need := NeedOf(h)
	if need != nil && need.Kind == "conflict" {
		return plot
	}
	weeds := OpenFindings(*issue)
	switch h.Phase.Value.(type) {
	case PhaseWorking:
		if weeds > 0 && plot.Badge == nil {
			return PlotView{Crop: CropWeeds, Badge: badge(Badge{Text: fmt.Sprintf("除草中 %d", weeds), Tone: BadgeToneBug})}
		}
	case PhaseRipe, PhaseResting:
		switch {
		case len(issue.Asks) > 0:
			return PlotView{Crop: CropDry, Badge: badge(badgeAsks)}
		case issue.AcceptedAt != nil:
			return PlotView{Crop: ripeCrop(h), Badge: badge(badgeRipe)}
		case weeds > 0:
			return PlotView{Crop: CropWeeds, Badge: badge(Badge{Text: fmt.Sprintf("%d 棵草", weeds), Tone: BadgeToneBug})}
		case isRipe(h):
			return PlotView{Crop: CropFlowering, Badge: badge(badgeReview)}
		}
	}
	return plot
}

func isRipe(h Session) bool { _, ok := h.Phase.Value.(PhaseRipe); return ok }

func PlotOfSession(h Session) PlotView {
	need := NeedOf(h)
	conflict := need != nil && need.Kind == "conflict"
	switch h.Phase.Value.(type) {
	case PhaseArriving:
		return PlotView{Crop: CropSeeded}
	case PhaseWorking:
		if need != nil && need.Kind == "quiet" {
			return PlotView{Crop: CropDry, Badge: badge(badgeQuiet)}
		}
		if need != nil && need.Kind == "retrying" {
			return PlotView{Crop: growth(h), Badge: badge(badgeRetrying)}
		}
		return PlotView{Crop: growth(h)}
	case PhaseRipe:
		if conflict {
			return PlotView{Crop: ripeCrop(h), Badge: badge(badgeConflict)}
		}
		return PlotView{Crop: ripeCrop(h), Badge: badge(badgeRipe)}
	case PhaseFailed:
		return PlotView{Crop: CropWithered, Badge: badge(badgeBugs)}
	case PhaseResting:
		if conflict {
			return PlotView{Crop: growth(h), Badge: badge(badgeConflict)}
		}
		return PlotView{Crop: growth(h), Badge: badge(badgeRest)}
	}
	return PlotView{Crop: CropEmpty}
}

// None on a farm's first count.
func LevelUps(before *int64, after int64) []GameEffect {
	if before == nil {
		return nil
	}
	var out []GameEffect
	from, _ := LevelForCommits(*before)
	to, _ := LevelForCommits(after)
	for l := from + 1; l <= to; l++ {
		out = append(out, GameEffect{GameEffectLevelUp{Level: l}})
	}
	return out
}

func EffectsOf(before CoreState, fact Fact) []GameEffect {
	switch f := fact.Value.(type) {
	case FactCommits:
		var was *int64
		if before.Commits != nil {
			was = &before.Commits.Total
		}
		return LevelUps(was, f.Commits.Total)
	case FactProgress:
		if f.News == nil {
			return nil
		}
		var out []GameEffect
		if f.News.Coins != nil && *f.News.Coins != 0 {
			session := ""
			if f.News.Session != nil {
				session = *f.News.Session
			}
			out = append(out, GameEffect{GameEffectReward{SessionID: session, Coins: *f.News.Coins, Streak: f.Progress.Streak}})
		}
		for _, u := range f.News.Unlocked {
			out = append(out, GameEffect{achievementEffect(u.ID, u.Tier)})
		}
		return out
	case FactReport:
		if f.Outcome == OutcomeFailed && SessionOf(before, f.ID) != nil {
			return []GameEffect{{GameEffectPenalty{SessionID: f.ID}}}
		}
	}
	return nil
}

// The issue a session works is its plot; a session with none (not sent for an issue) is its own.
func PlotKey(h Session) string {
	if h.Issue != nil && *h.Issue != "" {
		return *h.Issue
	}
	return h.ID
}

func ViewOf(state CoreState) FarmView {
	plots := make(map[string]PlotView, len(state.Sessions))
	for _, h := range state.Sessions {
		var issue *Issue
		if i := slices.IndexFunc(state.Issues, func(t Issue) bool { return t.ID == PlotKey(h) }); i >= 0 {
			issue = &state.Issues[i]
		}
		plots[PlotKey(h)] = PlotOf(h, issue)
	}
	return FarmView{Level: FarmLevelOf(state), Plots: plots, Achievements: standingsOf(state.Progress)}
}
