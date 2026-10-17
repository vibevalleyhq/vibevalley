package manager

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/agentcore"
)

func TestTypedToolSchemasKeepRequiredArguments(t *testing.T) {
	fm := &manager{}
	tools := fm.tools()
	for _, tc := range []struct{ name, valid, invalid string }{
		{"open_channel", `{"name":"notes"}`, `{}`},
		{"tell", `{"session":"w1","message":"hello"}`, `{"session":"w1"}`},
		{"read_chat", `{}`, `{"target":3}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var tool *agentcore.AgentTool
			for i := range tools {
				if tools[i].Name == tc.name {
					tool = &tools[i]
					break
				}
			}
			if tool == nil {
				t.Fatal("tool missing")
			}
			if _, err := agentcore.DecodeArguments(*tool, json.RawMessage(tc.valid)); err != nil {
				t.Fatal(err)
			}
			if _, err := agentcore.DecodeArguments(*tool, json.RawMessage(tc.invalid)); err == nil {
				t.Fatal("invalid arguments accepted")
			}
		})
	}
}
