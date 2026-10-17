package agent

// The older part is cut where a user's message begins, so a tool call and its result stay together.

import (
	"context"
	"math"
	"strings"
	"time"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

// Characters over three: close enough for mixed Chinese and code.
func EstimateTokens(messages []agentcore.AgentMessage) int {
	if messages == nil {
		messages = []agentcore.AgentMessage{}
	}
	return int(math.Ceil(float64(jsLength(ai.Stringify(messages))) / 3))
}

const SUMMARY_INSTRUCTIONS = "把下面这段对话压成一份摘要，给接下来继续这段对话的你自己看。保留：用户要的是什么、做出的决定、已经完成的事和结果、改过的文件和关键内容、还没做完的事、要注意的坑。去掉寒暄和已经没用的工具输出。用中文，条理清楚，不超过 1500 字。"

// 0 for nowhere.
func CutPoint(messages []agentcore.AgentMessage, keepRecent int) int {
	cut := len(messages) - keepRecent
	for cut > 0 && (cut >= len(messages) || (messages[cut].Role() != "user" && messages[cut].Role() != "custom")) {
		cut--
	}
	return max(cut, 0)
}

type CompactionOptions struct {
	Home          string
	Session       string
	Model         ai.Model
	StreamOptions ai.StreamOptions
	Budget        int
	KeepRecent    int
}

type compactionPlan struct {
	messages []agentcore.AgentMessage
	cut      int
	tokens   int
}

func planCompaction(messages []agentcore.AgentMessage, options CompactionOptions) *compactionPlan {
	tokens := EstimateTokens(messages)
	if tokens <= options.Budget || len(messages) <= options.KeepRecent+2 {
		return nil
	}
	cut := CutPoint(messages, options.KeepRecent)
	if cut <= 0 {
		return nil
	}
	return &compactionPlan{messages: messages, cut: cut, tokens: tokens}
}

func applySummary(messages []agentcore.AgentMessage, summary CompactionSummaryMessage) []agentcore.AgentMessage {
	out := []agentcore.AgentMessage{summary}
	if summary.Kept > 0 {
		out = append(out, messages[max(0, len(messages)-summary.Kept):]...)
	}
	return out
}

type compacted struct {
	summary  CompactionSummaryMessage
	messages []agentcore.AgentMessage
}

func (p compactionPlan) apply(summary CompactionSummaryMessage) *compacted {
	// A cached summary may be reused while more messages join the retained tail.
	summary.Kept = len(p.messages) - p.cut
	return &compacted{summary: summary, messages: applySummary(p.messages, summary)}
}

func Compact(ctx context.Context, messages []agentcore.AgentMessage, options CompactionOptions) *CompactionSummaryMessage {
	plan := planCompaction(messages, options)
	if plan == nil {
		return nil
	}
	return compact(ctx, *plan, options)
}

func compact(ctx context.Context, plan compactionPlan, options CompactionOptions) *CompactionSummaryMessage {
	text := Transcript(plan.messages[:plan.cut])
	where, _ := Archive(options.Home, options.Session, text, time.Now())
	streamOptions := options.StreamOptions
	streamOptions.Reasoning = ""
	answer := ai.Complete(ctx, options.Model, ai.Context{
		SystemPrompt: SUMMARY_INSTRUCTIONS,
		Messages:     []ai.Message{ai.UserMessage{Content: ai.StringContent(text), Timestamp: time.Now().UnixMilli()}},
	}, streamOptions)
	said := strings.TrimSpace(MessageText(answer))
	summary := said
	if answer.StopReason == ai.StopError || said == "" {
		summary = "（摘要没生成出来，原文见归档。）"
	}
	return &CompactionSummaryMessage{Summary: summary, TokensBefore: plan.tokens, Timestamp: time.Now().UnixMilli(), Archive: where, Kept: len(plan.messages) - plan.cut}
}
