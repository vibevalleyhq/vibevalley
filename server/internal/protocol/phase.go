package protocol

import (
	"fmt"
	"strings"

	"vibevalley/pkg/x/num"
)

// It takes one of the places for those working at once.
func IsBusy(h Session) bool {
	switch h.Phase.Value.(type) {
	case PhaseArriving, PhaseWorking:
		return true
	}
	return false
}

func DoingOf(h Session) Doing {
	if p, ok := h.Phase.Value.(PhaseWorking); ok {
		return p.Doing
	}
	return Doing{Action: SessionActionNone, Label: ""}
}

// What each action is, in words: seeds.json's actionText, which the client reads too.
var ActionText map[SessionAction]string

func coreSpan(ms int64) string {
	if ms < 60_000 {
		return fmt.Sprintf("%d 秒", int64(max(1, num.Round(float64(ms)/1000))))
	}
	return fmt.Sprintf("%d 分钟", int64(num.Round(float64(ms)/60_000)))
}

// The span placeholder in PhaseWords.
const phaseSpan = "{span}"

// PhaseText is PhaseWords as said at now.
func PhaseText(h Session, now int64) string {
	words := PhaseWords(h)
	if need := NeedOf(h); need != nil && need.Kind == "quiet" {
		words = strings.ReplaceAll(words, phaseSpan, coreSpan(now-need.Since))
	}
	return words
}

// PhaseWords is what a session is doing in words, how long it has been quiet left as {span}.
func PhaseWords(h Session) string {
	need := NeedOf(h)
	conflict := ""
	if need != nil && need.Kind == "conflict" {
		conflict = "，合进 " + need.Conflict.Base + " 会冲突（" + strings.Join(need.Conflict.Files, "、") + "）"
	}
	switch p := h.Phase.Value.(type) {
	case PhaseArriving:
		return "刚派出去，正在开工"
	case PhaseWorking:
		what := "在" + ActionText[p.Doing.Action]
		if p.Doing.Label != "" {
			what += "：" + p.Doing.Label
		}
		if need != nil && need.Kind == "quiet" {
			return what + "（已经 " + phaseSpan + "没动静了）"
		}
		if need != nil && need.Kind == "retrying" {
			of := ""
			if need.Retry.Of != nil && *need.Retry.Of != 0 {
				of = fmt.Sprintf("/%d", *need.Retry.Of)
			}
			return fmt.Sprintf("%s（模型调用失败，在重试第 %d%s 次）", what, need.Retry.Attempt, of)
		}
		return what
	case PhaseRipe:
		return "这一轮做完了，等收获" + conflict
	case PhaseFailed:
		return "这一轮失败了"
	case PhaseResting:
		last := "没做完"
		if h.LastRun != nil {
			switch h.LastRun.Outcome {
			case OutcomeInterrupted:
				last = "被叫停"
			case OutcomeCompleted:
				last = "做完了"
			default:
				last = "失败了"
			}
		}
		return "歇着（上一轮" + last + "）" + conflict
	}
	return ""
}
