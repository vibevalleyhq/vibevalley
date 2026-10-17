package voyage

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/smith/observe"
)

func recordedSession(t *testing.T) oar.Session {
	t.Helper()
	runtime := oartest.Runtime(oartest.Options{Turn: func(turn *oartest.Turn) error { turn.Say("hello"); return nil }})
	install, err := runtime.Installation(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	session, err := runtime.Session(context.Background(), install.Available, oar.SessionOptions{Cwd: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { session.Dispose(context.Background()) })
	return session
}

func TestSessionRecordingOwnsReplayTailAndEnd(t *testing.T) {
	session := recordedSession(t)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := observe.PromptAndWait(ctx, session, "before attach", observe.PromptRunOptions{}); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(t.TempDir(), "session.jsonl")
	recording, err := Attach(file, session, Header{Runtime: "test", Recorder: "test"}, "disposed")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := observe.PromptAndWait(ctx, session, "after attach", observe.PromptRunOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := session.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	if err := recording.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := recording.Close(ctx); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	records, err := ReadRecords(strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(records, session.Records()) {
		t.Fatalf("recorded %d records, session has %d", len(records), len(session.Records()))
	}
	if strings.Count(string(raw), `"kind":"end"`) != 1 || !strings.Contains(string(raw), `"reason":"disposed"`) {
		t.Fatalf("bad end: %s", raw)
	}
	if !recording.closed {
		t.Fatal("recording still subscribed after close")
	}
}

func TestSessionRecordingReportsWriteFailureWithoutEndMarker(t *testing.T) {
	session := recordedSession(t)
	file := filepath.Join(t.TempDir(), "session.jsonl")
	recording, err := Attach(file, session, Header{Runtime: "test"}, "exited")
	if err != nil {
		t.Fatal(err)
	}
	recording.recorder.mu.Lock()
	err = recording.recorder.file.Close()
	recording.recorder.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := observe.PromptAndWait(ctx, session, "write to closed file", observe.PromptRunOptions{}); err != nil {
		t.Fatal(err)
	}
	session.Dispose(ctx)
	if err := recording.Close(ctx); err == nil {
		t.Fatal("recording swallowed write failure")
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"kind":"end"`) {
		t.Fatal("failed recording claims complete capture")
	}
}

type delayedRecordingSession struct {
	oar.Session
	held    atomic.Bool
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *delayedRecordingSession) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.Session.RawEvents(func(record oar.RawEvent) {
		if s.held.Load() {
			s.once.Do(func() { close(s.entered) })
			<-s.release
		}
		observer(record)
	}, cursor)
}
func TestSessionRecordingTimeoutDoesNotClaimCompletion(t *testing.T) {
	session := &delayedRecordingSession{Session: recordedSession(t), entered: make(chan struct{}), release: make(chan struct{})}
	defer close(session.release)
	path := filepath.Join(t.TempDir(), "partial.jsonl")
	recording, err := Attach(path, session, Header{Runtime: "test"}, "exited")
	if err != nil {
		t.Fatal(err)
	}
	session.held.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, err := observe.PromptAndWait(ctx, session.Session, "held recording", observe.PromptRunOptions{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-session.entered:
	case <-ctx.Done():
		t.Fatal("recording callback never entered")
	}
	deadline, stop := context.WithTimeout(context.Background(), time.Millisecond)
	defer stop()
	if err := recording.Close(deadline); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"kind":"end"`) {
		t.Fatal("incomplete log claimed completion")
	}
}
