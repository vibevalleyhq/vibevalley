package ai

// Provider adapters receive only tool calls with results and results with a preceding call.
// Keep the persisted transcript intact: interruption can legitimately leave unmatched calls there.
func requestMessages(messages []Message) []Message {
	answered := map[string]bool{}
	for _, m := range messages {
		if result, ok := m.(ToolResultMessage); ok {
			answered[result.ToolCallID] = true
		}
	}
	called := map[string]bool{}
	out := make([]Message, 0, len(messages))
	for _, m := range messages {
		switch message := m.(type) {
		case AssistantMessage:
			content := message.Content
			message.Content = make([]Content, 0, len(content))
			for _, block := range content {
				if block.Type == TypeToolCall {
					if !answered[block.ID] {
						continue
					}
					called[block.ID] = true
				}
				message.Content = append(message.Content, block)
			}
			out = append(out, message)
		case ToolResultMessage:
			if called[message.ToolCallID] {
				out = append(out, message)
			}
		default:
			out = append(out, m)
		}
	}
	return out
}
