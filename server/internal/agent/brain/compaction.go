package brain

// The older part is cut where a user's message begins, so a tool call and its result stay together.

import (
	"context"
	"math"
	"slices"
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

const SUMMARY_IN_PLACE = "上面的对话要压成一份摘要，给接下来继续这段对话的你自己看；只写摘要，不调工具。保留：用户要的是什么、做出的决定、已经完成的事和结果、改过的文件和关键内容、还没做完的事、要注意的坑。去掉寒暄和已经没用的工具输出。用中文，条理清楚，不超过 1500 字。"

// Where a user's (or custom) message begins, at least keepRecent messages from the end, and further back until at least
// keepSaid assistant messages with words in them follow; 0 for nowhere.
func CutPoint(messages []agentcore.AgentMessage, keepRecent, keepSaid int) int {
	cut := len(messages) - keepRecent
	said := 0
	for _, m := range messages[max(cut, 0):] {
		if spoke(m) {
			said++
		}
	}
	for cut > 0 && (cut >= len(messages) || (messages[cut].Role() != "user" && messages[cut].Role() != "custom") || said < keepSaid) {
		cut--
		if cut >= 0 && cut < len(messages) && spoke(messages[cut]) {
			said++
		}
	}
	return max(cut, 0)
}

func spoke(m agentcore.AgentMessage) bool {
	return m.Role() == "assistant" && strings.TrimSpace(MessageText(m)) != ""
}

type CompactionOptions struct {
	Home          string
	Session       string
	Model         ai.Model
	StreamOptions ai.StreamOptions
	Budget        int
	KeepRecent    int
	// The assistant's last words kept as they were, when that keeps the kept part under half the budget.
	KeepSaid int
	// Written after the summary, as it stands when the fold is made (the open task graph); nil or "" for none.
	Append func() string
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
	cut := CutPoint(messages, options.KeepRecent, options.KeepSaid)
	// Keeping the words would keep too much, or all of it: then fold as if they did not count.
	if cut <= 0 || EstimateTokens(messages[cut:]) > options.Budget/2 {
		cut = CutPoint(messages, options.KeepRecent, 0)
	}
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

func summaryOf(task compactionPlan, said, where string, options CompactionOptions) *CompactionSummaryMessage {
	if said == "" {
		said = "（摘要没生成出来，原文见归档。）"
	}
	if options.Append != nil {
		if more := options.Append(); more != "" {
			said += "\n\n" + more
		}
	}
	return &CompactionSummaryMessage{Summary: said, TokensBefore: task.tokens, Timestamp: time.Now().UnixMilli(), Archive: where, Kept: len(task.messages) - task.cut}
}

// The summary of the whole conversation, asked after it with the same start (prefix, tools) its requests have, so the
// cache covers all but the last message; with nothing to call. An answer that failed, is empty or called a tool anyway
// is asked again on its own (compact).
func compactInPlace(ctx context.Context, task compactionPlan, options CompactionOptions, prefix string, tools []ai.Tool) (*CompactionSummaryMessage, *ai.Usage) {
	streamOptions := options.StreamOptions
	streamOptions.Reasoning = ""
	streamOptions.ToolChoice = "none"
	messages := append(ConvertToLlm(ctx, task.messages), ai.UserMessage{Content: ai.StringContent(SUMMARY_IN_PLACE), Timestamp: time.Now().UnixMilli()})
	answer := ai.Complete(ctx, options.Model, ai.Context{SystemPrompt: prefix, Messages: messages, Tools: tools}, streamOptions)
	said := strings.TrimSpace(MessageText(answer))
	called := slices.ContainsFunc(answer.Content, func(c ai.Content) bool { return c.Type == ai.TypeToolCall })
	if answer.StopReason == ai.StopError || answer.StopReason == ai.StopAborted || said == "" || called {
		return compact(ctx, task, options)
	}
	where, _ := Archive(options.Home, options.Session, Transcript(task.messages[:task.cut]), time.Now())
	return summaryOf(task, said, where, options), &answer.Usage
}

func compact(ctx context.Context, task compactionPlan, options CompactionOptions) (*CompactionSummaryMessage, *ai.Usage) {
	text := Transcript(task.messages[:task.cut])
	where, _ := Archive(options.Home, options.Session, text, time.Now())
	streamOptions := options.StreamOptions
	streamOptions.Reasoning = ""
	answer := ai.Complete(ctx, options.Model, ai.Context{
		SystemPrompt: SUMMARY_INSTRUCTIONS,
		Messages:     []ai.Message{ai.UserMessage{Content: ai.StringContent(text), Timestamp: time.Now().UnixMilli()}},
	}, streamOptions)
	said := strings.TrimSpace(MessageText(answer))
	if answer.StopReason == ai.StopError {
		said = ""
	}
	return summaryOf(task, said, where, options), &answer.Usage
}
