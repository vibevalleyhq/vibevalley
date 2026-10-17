package cli

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/smith/voyage"
)

func TestRunRecordingOwnsCompleteSessionLog(t *testing.T) {
	runtime := oartest.Runtime(oartest.Options{ID: "fake", Turn: echo})
	open := runtime.Session
	var session oar.Session
	runtime.Session = func(ctx context.Context, i oar.AvailableInstallation, o oar.SessionOptions) (oar.Session, error) {
		var err error
		session, err = open(ctx, i, o)
		return session, err
	}
	registry, err := oar.NewRuntimeRegistry(runtime)
	if err != nil {
		t.Fatal(err)
	}
	app := &cli{name: "test", registry: registry, stdout: io.Discard, stderr: io.Discard}
	path := filepath.Join(t.TempDir(), "run.jsonl")
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := app.run(ctx, []string{"fake", "task", "--record", path, "--json"}); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	got, err := voyage.ReadRecords(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, session.Records()) {
		t.Fatalf("log has %d records, session has %d", len(got), len(session.Records()))
	}
	if strings.Count(string(raw), `"kind":"end"`) != 1 || !strings.Contains(string(raw), `"reason":"disposed"`) {
		t.Fatal("CLI recording did not end once as disposed")
	}
}
