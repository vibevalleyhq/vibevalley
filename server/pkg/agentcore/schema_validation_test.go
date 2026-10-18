package agentcore

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestToolArgumentsUseTheWholeAdvertisedSchema(t *testing.T) {
	var schema JsonSchemaObject
	if err := json.Unmarshal([]byte(`{"type":"object","properties":{"count":{"type":"integer","minimum":1},"choice":{"oneOf":[{"type":"string","enum":["auto"]},{"type":"integer","minimum":1}]},"label":{"$ref":"#/$defs/label"}},"required":["count","choice"],"additionalProperties":false,"$defs":{"label":{"type":"string","minLength":2}}}`), &schema); err != nil {
		t.Fatal(err)
	}
	tool := AgentTool{Parameters: schema, CheckArguments: true}
	for _, tc := range []struct {
		input string
		valid bool
	}{
		{`{"count":1,"choice":"auto","label":"ok"}`, true},
		{`{"count":1,"choice":2}`, true},
		{`{"count":0,"choice":"auto"}`, false},
		{`{"count":1,"choice":true}`, false},
		{`{"count":1,"choice":"auto","extra":1}`, false},
		{`{"count":1,"choice":"auto","label":"x"}`, false},
		{`{"choice":"auto"}`, false},
	} {
		_, err := DecodeArguments(tool, json.RawMessage(tc.input))
		if (err == nil) != tc.valid {
			t.Fatalf("%s: %v", tc.input, err)
		}
	}
}

func TestToolSchemaDoesNotFetchExternalReferences(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.Write([]byte(`{"type":"object"}`)) }))
	defer server.Close()
	tool := AgentTool{Parameters: JsonSchemaObject{"$ref": server.URL + "/schema"}, CheckArguments: true}
	if _, err := DecodeArguments(tool, json.RawMessage(`{}`)); err == nil {
		t.Fatal("external reference accepted")
	}
	if requests.Load() != 0 {
		t.Fatal("validator fetched network schema")
	}
}
