package protocol

import (
	"fmt"
	"strings"
)

// It takes one of the places for those working at once.
func IsBusy(h Helper) bool {
	switch h.Phase.Value.(type) {
	case PhaseArriving, PhaseWorking:
		return true
	}
	return false
}

func DoingOf(h Helper) Doing {
	if p, ok := h.Phase.Value.(PhaseWorking); ok {
		return p.Doing
	}
	return Doing{Action: WorkerActionNone, Label: ""}
}

// A stopped turn may have work too.
func CanHarvest(h Helper) bool {
	switch h.Phase.Value.(type) {
	case PhaseRipe, PhaseResting:
		return true
	}
	return false
}

var ActionText = map[WorkerAction]string{
	WorkerActionRunCommand:   "跑命令",
	WorkerActionReadFile:     "读文件",
	WorkerActionEditFile:     "改文件",
	WorkerActionSearch:       "搜索",
	WorkerActionWeb:          "查网页",
	WorkerActionMCP:          "调 MCP 工具",
	WorkerActionWait:         "等待",
	WorkerActionOther:        "用工具",
	WorkerActionThinking:     "思考",
	WorkerActionSpeakingText: "写汇报",
	WorkerActionNone:         "",
}

func coreSpan(ms int64) string {
	if ms < 60_000 {
		return fmt.Sprintf("%d 秒", int64(max(1, coreRound(float64(ms)/1000))))
	}
	return fmt.Sprintf("%d 分钟", int64(coreRound(float64(ms)/60_000)))
}

func PhaseText(h Helper, now int64) string {
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
			return what + "（已经 " + coreSpan(now-need.Since) + "没动静了）"
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
		if h.Last != nil {
			switch h.Last.Outcome {
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
