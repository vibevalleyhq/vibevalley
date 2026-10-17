package workspace

import (
	"context"
	"path"
	"reflect"
	"slices"
	"testing"

	"vibevalley/internal/testkit/fixture"
)

func TestReadiesInTheOrderItsServicesStarted(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	cfg.Voice.Line.Port = 0
	f, err := New(cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, s := range f.Readied() {
		got = append(got, path.Base(reflect.TypeOf(s).Elem().PkgPath()))
	}
	// The commit count before the workers that read it, the workers back on their beds before the schedules run and the
	// connectors bring messages in.
	if want := []string{"game", "worker", "schedule", "connector"}; !slices.Equal(got, want) {
		t.Fatalf("readied %q, want %q", got, want)
	}
}
