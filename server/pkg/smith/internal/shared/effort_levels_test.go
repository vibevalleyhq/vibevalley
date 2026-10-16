package shared

import (
	"reflect"
	"testing"
)

func TestEffortLevels(t *testing.T) {
	if got := EffortLevelsOf(nil); got != nil {
		t.Errorf("undefined: %v", got)
	}
	if got := EffortLevelsOf("high"); got != nil {
		t.Errorf("a string: %v", got)
	}
	if got := EffortLevelsOf([]any{}); got == nil || len(got) != 0 {
		t.Errorf("empty: %#v", got)
	}
	got := EffortLevelsOf([]any{"low", map[string]any{"effort": "high", "description": "x"}, map[string]any{"id": "max"}, map[string]any{}, 3.0})
	if !reflect.DeepEqual(got, []string{"low", "high", "max"}) {
		t.Errorf("got %v", got)
	}
	if level, ok := EffortLevelOf("medium"); !ok || level != "medium" {
		t.Errorf("medium: %q", level)
	}
	if level, ok := EffortLevelOf(map[string]any{"effort": "xhigh"}); !ok || level != "xhigh" {
		t.Errorf("xhigh: %q", level)
	}
	if level, ok := EffortLevelOf(""); ok {
		t.Errorf("empty: %q", level)
	}
	// effort ?? id: a present non-string effort does not fall back to id.
	if level, ok := EffortLevelOf(map[string]any{"effort": 3.0, "id": "x"}); ok {
		t.Errorf("non-string effort: %q", level)
	}
}
