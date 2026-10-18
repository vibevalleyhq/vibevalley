package tool

import (
	"context"
	"encoding/json"
	"testing"

	"vibevalley/internal/testkit"
	"vibevalley/pkg/agentcore"
)

// Words in a helper's report or a page it read can ask for a task to start or be merged; only the owner's can.
func TestATaskStartsAndMergesOnlyOnTheOwnersWords(t *testing.T) {
	notOwner := func(context.Context) (Caller, error) { return Caller{Agent: "manager"}, nil }
	tool := (&Service{}).graphAction(notOwner)
	for action, want := range map[string]string{"start": startNotAsked, "merge": mergeNotAsked} {
		r, err := tool.Execute(context.Background(), "c1", json.RawMessage(`{"graph":"p1","action":"`+action+`"}`), nil)
		if err != nil {
			t.Fatal(err)
		}
		testkit.Eq(t, agentcore.ResultText(r.Content), want, action)
	}
}
