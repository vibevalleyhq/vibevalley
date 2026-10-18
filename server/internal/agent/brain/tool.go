package brain

import (
	"context"
	"encoding/json"
	"fmt"

	"vibevalley/pkg/agentcore"
)

type ToolContext struct {
	CallID string
}

// The model gets the head and the tail, and a note.
const MAX_RESULT_CHARS = 30_000

// MAX_RESULT_CHARS when limit is 0.
func Clip(text string, limit int) string {
	if limit <= 0 {
		limit = MAX_RESULT_CHARS
	}
	r := []rune(text)
	if len(r) <= limit {
		return text
	}
	head := int(float64(limit) * 0.7)
	tail := int(float64(limit) * 0.3)
	return string(r[:head]) + fmt.Sprintf("\n\n…（省略了 %d 个字符）…\n\n", len(r)-limit) + string(r[len(r)-tail:])
}

type TextToolSpec[P any] struct {
	Name        string
	Label       string
	Description string
	Parameters  agentcore.JsonSchemaObject
	Run         func(ctx context.Context, params P, tc ToolContext) (string, error)
}

func TextTool[P any](spec TextToolSpec[P]) agentcore.AgentTool {
	return agentcore.DefineTool(agentcore.ToolSpec[P]{
		Name: spec.Name, Label: spec.Label, Description: spec.Description, Parameters: spec.Parameters,
		Execute: func(ctx context.Context, id string, params P, _ agentcore.AgentToolUpdateCallback) (agentcore.AgentToolResult, error) {
			text, err := spec.Run(ctx, params, ToolContext{CallID: id})
			if err != nil {
				return agentcore.AgentToolResult{}, err
			}
			return agentcore.TextResult(Clip(text, 0)), nil
		},
	})
}

type JsonToolSpec struct {
	Name        string
	Label       string
	Description string
	Parameters  agentcore.JsonSchemaObject
	Run         func(ctx context.Context, params json.RawMessage, tc ToolContext) (string, error)
}

func JsonTool(spec JsonToolSpec) agentcore.AgentTool {
	label := spec.Label
	if label == "" {
		label = spec.Name
	}
	return agentcore.AgentTool{
		Name: spec.Name, Label: label, Description: spec.Description, Parameters: spec.Parameters,
		Execute: func(ctx context.Context, id string, params json.RawMessage, _ agentcore.AgentToolUpdateCallback) (agentcore.AgentToolResult, error) {
			text, err := spec.Run(ctx, params, ToolContext{CallID: id})
			if err != nil {
				return agentcore.AgentToolResult{}, err
			}
			return agentcore.TextResult(Clip(text, 0)), nil
		},
	}
}
