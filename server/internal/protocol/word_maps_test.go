package protocol

import "testing"

// Every enum value must have its word. Adding a member without a word fails here, not as an empty label.
func TestEveryWordMapCoversItsEnum(t *testing.T) {
	for _, s := range PlaybookStateValues {
		if PlaybookStateText[s] == "" || PlaybookStateTag[s] == "" {
			t.Errorf("playbook state %q has no text or tag", s)
		}
	}
	for _, a := range PlaybookActionValues {
		if PlaybookActionText[a] == "" {
			t.Errorf("playbook action %q has no word", a)
		}
	}
	for _, s := range NodeStateValues {
		if NodeStateText[s] == "" {
			t.Errorf("node state %q has no word", s)
		}
	}
	for _, a := range NodeActionValues {
		if NodeActionText[a] == "" {
			t.Errorf("node action %q has no word", a)
		}
	}
	for _, a := range PlaybookActorValues {
		if ActorText[a] == "" {
			t.Errorf("playbook actor %q has no word", a)
		}
	}
}
