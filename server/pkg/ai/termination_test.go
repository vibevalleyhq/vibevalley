package ai

import "testing"

func TestTruncatedAnswersAreErrors(t *testing.T) {
	for _, events := range [][]AssistantMessageEvent{
		collect(AnswerEvents(flash(), seq2(ChatChunk{Choices: []ChatChoice{{Delta: &ChatDelta{Content: "partial"}}}}))),
		collect(AnthropicAnswerEvents(claude(), seq2(AnthropicEvent{Type: "content_block_delta", Delta: &AnthropicEventDelta{Type: "text_delta", Text: "partial"}}))),
		collect(AnswerEvents(flash(), seq2[ChatChunk]())),
		collect(AnthropicAnswerEvents(claude(), seq2[AnthropicEvent]())),
	} {
		last := events[len(events)-1]
		if last.Type != EventError || last.Error.StopReason != StopError {
			t.Fatalf("truncated answer succeeded: %+v", last)
		}
	}
}
