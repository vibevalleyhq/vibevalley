package protocol

// What the screens make of the core state (packages/protocol/src/view.ts): the farm's level, the calls the farm phone
// rings with, each helper's bed, and the effects to play when something is earned or lost.

import (
	"unicode/utf16"
)

// XPToNext is the commits needed to go from level to level+1.
func XPToNext(level int64) int64 { return 10 * level }

// LevelForCommits is the level a commit count reaches, and the commits into that level.
func LevelForCommits(total int64) (level, xp int64) {
	level, rest := int64(1), max(0, total)
	for rest >= XPToNext(level) {
		rest -= XPToNext(level)
		level++
	}
	return level, rest
}

func FarmLevelOf(state FarmState) FarmLevel {
	var total int64
	if state.Commits != nil {
		total = state.Commits.Total
	}
	level, xp := LevelForCommits(total)
	return FarmLevel{Level: level, Xp: xp, Need: XPToNext(level)}
}

// Need is what the farm asks of you about a helper: the most pressing thing, if any.
type Need struct {
	Kind     string // conflict, harvest, fix, quiet, retrying
	Conflict *Conflict
	Since    int64
	Retry    *Retry
}

func NeedOf(h Helper) *Need {
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

// jsHash is view.ts's hash: over UTF-16 code units of each code point's first unit, wrapping at 32 bits.
func jsHash(s string) uint32 {
	var h uint32
	for _, r := range s {
		unit := r
		if r > 0xFFFF {
			hi, _ := utf16.EncodeRune(r)
			unit = hi
		}
		h = h*31 + uint32(unit)
	}
	return h
}

func ripeCrop(h Helper) Crop {
	if jsHash(h.ID)%2 == 1 {
		return CropCarrot
	}
	return CropWheat
}

func IsRipe(crop Crop) bool { return crop == CropWheat || crop == CropCarrot }

func growth(h Helper) Crop {
	play := PlayOf(h)
	since := h.HiredAt
	if play.TurnStartedAt != nil {
		since = *play.TurnStartedAt
	}
	crop := CropSprout
	for _, step := range play.History {
		if step.At < since {
			continue
		}
		if step.Action == WorkerActionEditFile && crop == CropSprout {
			crop = CropLeafy
		} else if step.Action == WorkerActionRunCommand && crop == CropLeafy {
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
)

func badge(b Badge) *Badge { return &b }

// PlotOfHelper is what grows in a helper's bed, and the sign over it.
func PlotOfHelper(h Helper) PlotView {
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

// Clip cuts text to n UTF-16 units with an ellipsis, as JavaScript's length and slice count.
func Clip(text string, n int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= n {
		return text
	}
	return string(utf16.Decode(units[:n])) + "…"
}

// LevelUps is each level gained between two commit counts; none on a farm's first count.
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

// EffectsOf is the effects fact brings, given the state before it.
func EffectsOf(before FarmState, fact Fact) []GameEffect {
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
			helper := ""
			if f.News.Helper != nil {
				helper = *f.News.Helper
			}
			out = append(out, GameEffect{GameEffectReward{WorkerID: helper, Coins: *f.News.Coins, Streak: f.Progress.Streak}})
		}
		for _, u := range f.News.Unlocked {
			out = append(out, GameEffect{GameEffectAchievement{Achievement: u.ID, Tier: u.Tier}})
		}
		return out
	case FactReport:
		if f.Outcome == OutcomeFailed && HelperOf(before, f.ID) != nil {
			return []GameEffect{{GameEffectPenalty{WorkerID: f.ID}}}
		}
	}
	return nil
}

func ViewOf(state FarmState) FarmView {
	plots := make(map[string]PlotView, len(state.Helpers))
	for _, h := range state.Helpers {
		plots[h.ID] = PlotOfHelper(h)
	}
	return FarmView{Level: FarmLevelOf(state), Plots: plots}
}
