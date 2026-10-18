package agentcore

// The tool's own JSON Schema is the check (required keys, each property's type), then the arguments are decoded into the tool's Go type.

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/google/jsonschema-go/jsonschema"

	"vibevalley/pkg/ai"
)

type ToolSpec[P any] struct {
	Name          string
	Label         string
	Description   string
	Parameters    JsonSchemaObject
	ExecutionMode ToolExecutionMode
	Execute       func(ctx context.Context, toolCallID string, params P, onUpdate AgentToolUpdateCallback) (AgentToolResult, error)
}

func DefineTool[P any](spec ToolSpec[P]) AgentTool {
	label := spec.Label
	if label == "" {
		label = spec.Name
	}
	return AgentTool{
		Name: spec.Name, Label: label, Description: spec.Description, Parameters: spec.Parameters,
		CheckArguments: true, ExecutionMode: spec.ExecutionMode,
		Execute: func(ctx context.Context, toolCallID string, raw json.RawMessage, onUpdate AgentToolUpdateCallback) (AgentToolResult, error) {
			var params P
			if len(raw) > 0 {
				if err := json.Unmarshal(raw, &params); err != nil {
					return AgentToolResult{}, fmt.Errorf("参数不对：%s", err.Error())
				}
			}
			return spec.Execute(ctx, toolCallID, params, onUpdate)
		},
	}
}

type TextResultOptions struct {
	IsError   bool
	Terminate bool
}

func TextResult(text string, options ...TextResultOptions) AgentToolResult {
	var o TextResultOptions
	if len(options) > 0 {
		o = options[0]
	}
	return AgentToolResult{Content: []ai.Content{ai.NewText(text)}, IsError: o.IsError, Terminate: o.Terminate}
}

func ResultText(content []ai.Content) string {
	parts := make([]string, 0, len(content))
	for _, c := range content {
		if c.Type == ai.TypeText {
			parts = append(parts, c.Text)
		} else {
			parts = append(parts, "[图片]")
		}
	}
	return strings.Join(parts, "\n")
}

func ParametersSchema(tool AgentTool) JsonSchemaObject {
	if tool.Parameters["type"] == "object" {
		return tool.Parameters
	}
	return JsonSchemaObject{"type": "object", "properties": map[string]any{}}
}

func ToolOf(tool AgentTool) ai.Tool {
	return ai.Tool{Name: tool.Name, Description: tool.Description, Parameters: ParametersSchema(tool)}
}

// A tool that does not check takes them as they are.
func DecodeArguments(tool AgentTool, args json.RawMessage) (json.RawMessage, error) {
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	if !tool.CheckArguments {
		return args, nil
	}
	if tool.Parameters == nil {
		return args, nil
	}
	body, err := json.Marshal(tool.Parameters)
	if err != nil {
		return nil, fmt.Errorf("工具参数定义不对：%w", err)
	}
	var schema jsonschema.Schema
	if err := json.Unmarshal(body, &schema); err != nil {
		return nil, fmt.Errorf("工具参数定义不对：%w", err)
	}
	// The default resolver rejects external references; tool validation never fetches a URL.
	resolved, err := schema.Resolve(nil)
	if err != nil {
		return nil, fmt.Errorf("工具参数定义不对：%w", err)
	}
	var value any
	if err := json.Unmarshal(args, &value); err != nil {
		return nil, fmt.Errorf("参数不对：%w", err)
	}
	if err := resolved.Validate(value); err != nil {
		return nil, fmt.Errorf("参数不对：%w", err)
	}
	return args, nil
}

// No properties is an empty object.
func ObjectSchema(properties map[string]any, required ...string) JsonSchemaObject {
	if len(properties) == 0 {
		return JsonSchemaObject{"type": "object", "properties": map[string]any{}}
	}
	schema := JsonSchemaObject{"type": "object", "properties": properties, "additionalProperties": true}
	if len(required) > 0 {
		schema["required"] = required
	}
	return schema
}

func StringSchema() map[string]any  { return map[string]any{"type": "string"} }
func IntegerSchema() map[string]any { return map[string]any{"type": "integer"} }
func NumberSchema() map[string]any  { return map[string]any{"type": "number"} }
func BooleanSchema() map[string]any { return map[string]any{"type": "boolean"} }
