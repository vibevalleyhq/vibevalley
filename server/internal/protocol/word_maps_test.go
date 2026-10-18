package protocol

import "testing"

// Every enum value must have its word. Adding a member without a word fails here, not as an empty label.
func TestEveryWordMapCoversItsEnum(t *testing.T) {
	for _, s := range GraphStateValues {
		if GraphStateText[s] == "" || GraphStateTag[s] == "" {
			t.Errorf("task state %q has no text or tag", s)
		}
	}
	for _, a := range GraphActionValues {
		if GraphActionText[a] == "" {
			t.Errorf("task action %q has no word", a)
		}
	}
	for _, s := range TaskStateValues {
		if TaskStateText[s] == "" {
			t.Errorf("node state %q has no word", s)
		}
	}
	for _, a := range TaskActionValues {
		if TaskActionText[a] == "" {
			t.Errorf("node action %q has no word", a)
		}
	}
	for _, a := range GraphActorValues {
		if ActorText[a] == "" {
			t.Errorf("task actor %q has no word", a)
		}
	}
}
