package brain

import (
	"os"

	"vibevalley/pkg/agentcore"
)

// Every line of a session file as written, the compactions among them and what they fold: Replay reads them as Load does.
// Empty when there is no file.
func ReadLines(file string) []agentcore.AgentMessage {
	text, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	return parseLines(string(text))
}
