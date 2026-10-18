package tool

import (
	"encoding/json"
	"reflect"

	"github.com/google/jsonschema-go/jsonschema"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/agentcore"
)

// Argument types own field names, types and requiredness; jsonschema tags carry model-facing descriptions.
func schemaOf[Args any]() agentcore.JsonSchemaObject {
	schema, err := jsonschema.For[Args](&jsonschema.ForOptions{TypeSchemas: map[reflect.Type]*jsonschema.Schema{
		reflect.TypeFor[protocol.GraphAction](): enumSchema(protocol.GraphActionValues),
		reflect.TypeFor[protocol.TaskAction]():  enumSchema(protocol.TaskActionValues),
		reflect.TypeFor[scheduleKind]():         enumSchema(scheduleKinds()),
	}})
	if err != nil {
		panic(err)
	}
	// Optional pointers and slices mean omitted, not explicit null, in the existing tool contract.
	for _, property := range schema.Properties {
		if len(property.Types) == 2 && property.Types[0] == "null" {
			property.Type, property.Types = property.Types[1], nil
		}
	}
	body, err := json.Marshal(schema)
	if err != nil {
		panic(err)
	}
	var out agentcore.JsonSchemaObject
	if err := json.Unmarshal(body, &out); err != nil {
		panic(err)
	}
	// Match TextTool's existing unknown-field policy.
	out["additionalProperties"] = true
	if out["properties"] == nil {
		out["properties"] = map[string]any{}
	}
	return out
}

// The flattened schedule tool uses the protocol union's discriminators.
type scheduleKind string

func scheduleKinds() []scheduleKind {
	kinds := make([]scheduleKind, 0, len(protocol.ScheduleWhenMembers))
	for _, member := range protocol.ScheduleWhenMembers {
		body, err := json.Marshal(member)
		if err != nil {
			panic(err)
		}
		var value struct {
			Kind scheduleKind `json:"kind"`
		}
		if err := json.Unmarshal(body, &value); err != nil {
			panic(err)
		}
		kinds = append(kinds, value.Kind)
	}
	return kinds
}

func enumSchema[T ~string](values []T) *jsonschema.Schema {
	enum := make([]any, len(values))
	for i, value := range values {
		enum[i] = string(value)
	}
	return &jsonschema.Schema{Type: "string", Enum: enum}
}
