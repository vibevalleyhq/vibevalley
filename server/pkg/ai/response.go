package ai

// Response owns the consumer's accumulated answer. Providers keep emitting the same
// events; completion and agent loops share how a partial stream becomes a final message.
type Response struct {
	partial AssistantMessage
	final   *AssistantMessage
}

func NewResponse(model Model) *Response { return &Response{partial: NewAnswer(model, "").Partial()} }

func (r *Response) Observe(event AssistantMessageEvent) {
	if final, ok := event.Final(); ok {
		r.final = &final
		return
	}
	r.partial = event.Partial
}

func (r *Response) Result() AssistantMessage {
	if r.final != nil {
		return *r.final
	}
	message := r.partial
	message.StopReason, message.ErrorMessage = StopError, "模型没有回答完"
	return message
}

func (r *Response) Aborted() AssistantMessage {
	message := r.Result()
	message.StopReason, message.ErrorMessage = StopAborted, "已停下"
	return message
}
