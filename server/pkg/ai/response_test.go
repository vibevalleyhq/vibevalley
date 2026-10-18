package ai

import "testing"

func TestResponseOwnsPartialFinalAndAbortedMessages(t *testing.T) {
	model := flash()
	answer := NewAnswer(model, "response")
	response := NewResponse(model)
	for _, event := range answer.Start() {
		response.Observe(event)
	}
	for _, event := range answer.Text("partial") {
		response.Observe(event)
	}
	if got := response.Result(); got.StopReason != StopError || len(got.Content) != 1 || got.Content[0].Text != "partial" {
		t.Fatalf("incomplete: %+v", got)
	}
	for _, event := range answer.Done(StopStop, RawUsage{Output: 3}) {
		response.Observe(event)
	}
	if got := response.Result(); got.StopReason != StopStop || got.Usage.Output != 3 {
		t.Fatalf("final: %+v", got)
	}
	if got := response.Aborted(); got.StopReason != StopAborted || len(got.Content) != 1 || got.Content[0].Text != "partial" || got.Usage.Output != 3 {
		t.Fatalf("abort: %+v", got)
	}
}
