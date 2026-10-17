package base

import (
	"slices"
	"testing"

	"github.com/google/uuid"
)

func TestNewIDIsTimeOrderedUUIDv7(t *testing.T) {
	seen := map[string]bool{}
	ids := make([]string, 1000)
	for i := range ids {
		ids[i] = NewID()
		if seen[ids[i]] {
			t.Fatalf("duplicate id %s", ids[i])
		}
		seen[ids[i]] = true
		parsed, err := uuid.Parse(ids[i])
		if err != nil || parsed.Version() != 7 {
			t.Fatalf("not a uuidv7: %s (%v)", ids[i], err)
		}
	}
	if !slices.IsSorted(ids) {
		t.Fatal("ids do not sort in the order they were made")
	}
}
