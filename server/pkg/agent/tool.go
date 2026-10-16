package agent

// Tools that answer in words: most of this agent's (files, commands, memory, schedules, the farm's) do, so
// TextTool makes an agentcore tool from a function that ends in text, or fails with a sentence for the model.
// Long output is cut in the middle. For a runtime other than agentcore (pi), a tool's parameters as JSON Schema
// and a call with the arguments checked first.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"vibevalley/pkg/agentcore"
)

// ToolContext is what a tool run knows of its call.
type ToolContext struct {
	// The tool call's id.
	CallID string
}

// MAX_RESULT_CHARS: a tool result longer than this is cut in the middle: the model gets the head and the tail, and a note.
const MAX_RESULT_CHARS = 30_000

// Clip cuts text longer than limit (MAX_RESULT_CHARS when 0) in the middle.
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

// TextToolSpec is a tool with parameters decoded into P whose result is text.
type TextToolSpec[P any] struct {
	Name        string
	Label       string
	Description string
	Parameters  agentcore.JsonSchemaObject
	Run         func(ctx context.Context, params P, tc ToolContext) (string, error)
}

// TextTool is a tool with typed parameters whose result is text; an error is the model's sentence.
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

// JsonToolSpec is a tool found at run time (MCP's): JSON Schema parameters, taken as they come.
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

// ParametersJsonSchema is a tool's parameters as JSON Schema, for a runtime other than agentcore (pi).
func ParametersJsonSchema(tool agentcore.AgentTool) agentcore.JsonSchemaObject {
	return agentcore.ParametersSchema(tool)
}

// CallTool runs a tool on arguments nobody checked yet: checked first, a bad one said as an error; the result as text.
func CallTool(ctx context.Context, tool agentcore.AgentTool, params json.RawMessage, tc ToolContext) (string, error) {
	args, err := agentcore.DecodeArguments(tool, params)
	if err != nil {
		return "", err
	}
	result, err := tool.Execute(ctx, tc.CallID, args, func(agentcore.AgentToolResult) {})
	if err != nil {
		return "", err
	}
	text := agentcore.ResultText(result.Content)
	if result.IsError {
		return "", errors.New(text)
	}
	return text, nil
}
