package tool

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"vibevalley/pkg/agentcore"
)

func TestAllTypedToolSchemasPreserveTheContract(t *testing.T) {
	body, err := os.ReadFile("testdata/tool_schemas.json")
	if err != nil {
		t.Fatal(err)
	}
	var before map[string]agentcore.JsonSchemaObject
	if err := json.Unmarshal(body, &before); err != nil {
		t.Fatal(err)
	}
	tools := (&Service{}).Manager(nil)
	if len(tools) != len(before) {
		t.Fatalf("tool coverage: got %d want %d", len(tools), len(before))
	}
	for _, tool := range tools {
		t.Run(tool.Name, func(t *testing.T) {
			want, ok := before[tool.Name]
			if !ok {
				t.Fatal("missing baseline schema")
			}
			// Omitted additionalProperties has the same permissive semantics as true.
			want["additionalProperties"] = true
			if !reflect.DeepEqual(tool.Parameters, want) {
				got, _ := json.Marshal(tool.Parameters)
				expected, _ := json.Marshal(want)
				t.Fatalf("contract changed:\ngot %s\nwant %s", got, expected)
			}
			properties, _ := tool.Parameters["properties"].(map[string]any)
			valid := map[string]any{}
			for name, raw := range properties {
				valid[name] = schemaValue(raw.(map[string]any))
			}
			check := func(args map[string]any, wantValid bool) {
				t.Helper()
				raw, err := json.Marshal(args)
				if err != nil {
					t.Fatal(err)
				}
				_, err = agentcore.DecodeArguments(tool, raw)
				if (err == nil) != wantValid {
					t.Fatalf("DecodeArguments(%s) = %v; valid=%v", raw, err, wantValid)
				}
			}
			check(valid, true)
			valid["extra_field"] = map[string]any{"nested": true}
			check(valid, true)
			delete(valid, "extra_field")
			required := map[string]bool{}
			for _, name := range requiredNames(tool.Parameters) {
				required[name] = true
			}
			for name, raw := range properties {
				value := valid[name]
				delete(valid, name)
				check(valid, !required[name])
				valid[name] = nil
				check(valid, false)
				valid[name] = map[string]any{}
				check(valid, false)
				property := raw.(map[string]any)
				if enums, ok := property["enum"].([]any); ok {
					valid[name] = "not-a-domain-value"
					check(valid, false)
					for _, enum := range enums {
						valid[name] = enum
						check(valid, true)
					}
				}
				if property["type"] == "array" {
					valid[name] = []any{map[string]any{}}
					check(valid, false)
				}
				valid[name] = value
			}
		})
	}
}

func requiredNames(schema agentcore.JsonSchemaObject) []string {
	var out []string
	names, _ := schema["required"].([]any)
	for _, name := range names {
		out = append(out, name.(string))
	}
	return out
}

func schemaValue(schema map[string]any) any {
	if values, ok := schema["enum"].([]any); ok {
		return values[0]
	}
	switch schema["type"] {
	case "string":
		return "value"
	case "number":
		return 1.5
	case "boolean":
		return false
	case "array":
		return []any{schemaValue(schema["items"].(map[string]any))}
	}
	panic("unsupported fixture type")
}
