package agentcore

// The tool's own JSON Schema is the check (required keys, each property's type), then the arguments are decoded into the tool's Go type.

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"strings"

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
	if why := checkSchema(tool.Parameters, args, nil); why != "" {
		return nil, fmt.Errorf("参数不对：%s", why)
	}
	return args, nil
}

func pathOf(path []string) string {
	if len(path) == 0 {
		return ""
	}
	quoted := make([]string, len(path))
	for i, p := range path {
		quoted[i] = fmt.Sprintf("%q", p)
	}
	return "\n  at [" + strings.Join(quoted, "][") + "]"
}

func checkSchema(schema map[string]any, value json.RawMessage, path []string) string {
	if schema == nil {
		return ""
	}
	var v any
	if err := json.Unmarshal(value, &v); err != nil {
		return "not JSON" + pathOf(path)
	}
	if t, ok := schema["type"].(string); ok && !fitsType(t, v) {
		return fmt.Sprintf("Expected %s, got %s%s", t, string(value), pathOf(path))
	}
	if enum, ok := schema["enum"].([]any); ok {
		found := false
		for _, e := range enum {
			if fmt.Sprint(e) == fmt.Sprint(v) {
				found = true
			}
		}
		if !found {
			return fmt.Sprintf("Expected one of %v, got %s%s", enum, string(value), pathOf(path))
		}
	}
	if _, isObject := v.(map[string]any); isObject {
		entries := ai.ObjectEntries(value)
		present := map[string]json.RawMessage{}
		for _, e := range entries {
			present[e.Key] = e.Value
		}
		for _, r := range requiredOf(schema) {
			if _, ok := present[r]; !ok {
				return "Missing key" + pathOf(append(path, r))
			}
		}
		properties, _ := schema["properties"].(map[string]any)
		for _, e := range entries {
			sub, ok := properties[e.Key].(map[string]any)
			if !ok {
				continue
			}
			if why := checkSchema(sub, e.Value, append(path, e.Key)); why != "" {
				return why
			}
		}
	}
	if items, ok := schema["items"].(map[string]any); ok {
		var list []json.RawMessage
		if json.Unmarshal(value, &list) == nil {
			for i, item := range list {
				if why := checkSchema(items, item, append(path, fmt.Sprint(i))); why != "" {
					return why
				}
			}
		}
	}
	return ""
}

func requiredOf(schema map[string]any) []string {
	switch r := schema["required"].(type) {
	case []string:
		return r
	case []any:
		out := make([]string, 0, len(r))
		for _, x := range r {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

func fitsType(t string, v any) bool {
	switch t {
	case "string":
		_, ok := v.(string)
		return ok
	case "number":
		_, ok := v.(float64)
		return ok
	case "integer":
		n, ok := v.(float64)
		return ok && n == math.Trunc(n)
	case "boolean":
		_, ok := v.(bool)
		return ok
	case "object":
		_, ok := v.(map[string]any)
		return ok
	case "array":
		_, ok := v.([]any)
		return ok
	case "null":
		return v == nil
	}
	return true
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
