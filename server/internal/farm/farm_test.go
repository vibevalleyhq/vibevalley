package farm

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"vibevalley/internal/base"
)

func TestFarmReadiesInTheOrderItsServicesStarted(t *testing.T) {
	t.Setenv("VIBEVALLEY_VOICE_LINE_PORT", "0")
	f, err := New(base.Config{Home: t.TempDir(), WorkRoot: t.TempDir(), DBPath: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, s := range f.Readied() {
		got = append(got, reflect.TypeOf(s).Elem().Name())
	}
	// The commit count before the crew that reads it, the crew back on its beds before the schedules run and the
	// connectors bring messages in.
	if want := []string{"Commits", "Crew", "Schedules", "Connectors"}; !slices.Equal(got, want) {
		t.Fatalf("readied %q, want %q", got, want)
	}
}
