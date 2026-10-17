package manager

import (
	"encoding/json"

	"github.com/google/jsonschema-go/jsonschema"
	"vibevalley/pkg/agentcore"
)

// Argument types own field names, types and requiredness; jsonschema tags carry model-facing descriptions.
func managerSchema[Args any]() agentcore.JsonSchemaObject {
	schema, err := jsonschema.For[Args](nil)
	if err != nil {
		panic(err)
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
	return out
}
