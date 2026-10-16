package shared

import (
	"context"
	"io"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

const (
	esc = "\x1b"
	bel = "\x07"
)

func TestTerminalEscapesGoHyperlinkTextStays(t *testing.T) {
	url := "https://example.com/sign-in?state=abc"
	printed := strings.Join([]string{
		esc + "[1m" + esc + "[32mvisit:" + esc + "[0m ",
		esc + "]8;;" + url + bel + url + esc + "]8;;" + bel,
		" " + esc + "]8;;" + url + esc + `\here` + esc + "]8;;" + esc + `\`,
		esc + "]0;window title" + bel + esc + "[2K" + esc + "=" + esc + "(Bdone",
	}, "")
	if got := StripTerminalEscapes(printed); got != "visit: "+url+" heredone" {
		t.Fatalf("got %q", got)
	}
}

func TestLoginSecretsRedaction(t *testing.T) {
	secrets := &LoginSecrets{}
	secrets.Add("pasted-authorization-code#state")
	secrets.Add("pasted-authorization-code")
	secrets.Add("#")
	jwt := "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl"
	got := secrets.Redact("code pasted-authorization-code#state, again pasted-authorization-code; key sk-ant-oat01-abcdefghijklmnopqrstuvwxyz; jwt " + jwt + "; #")
	if want := "code [redacted], again [redacted]; key [redacted]; jwt [redacted]; #"; got != want {
		t.Fatalf("got %q", got)
	}
	if got := secrets.Redact(strings.Repeat("x", 600)); len(got) != 503 {
		t.Fatalf("length %d", len(got))
	}
	if got := secrets.Line("\n  fatal: pasted-authorization-code rejected\nat stack frame\n"); got != "fatal: [redacted] rejected" {
		t.Fatalf("got %q", got)
	}
}

func TestLoginExecutable(t *testing.T) {
	got := LoginExecutableOf(oar.AvailableInstallation{Via: "bundled"}, "pi", "1.0.0")
	want := LoginExecutable{Kind: "settled", Result: ExecutableRefusal{Kind: "unsupported", Reason: "unsupported_installation", Detail: "not a machine-installed executable"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
	// An executable that is there, on every platform: this test binary.
	command, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	if got := LoginExecutableOf(oar.AvailableInstallation{Via: "executable", Command: command}, "fake", "1.0.0"); got.Kind != "executable" {
		t.Fatalf("got %+v", got)
	}
	if got := LoginExecutableOf(oar.AvailableInstallation{Via: "executable", Command: command, Version: "fake 1.0.0"}, "fake", "1.0.0"); got.Kind != "executable" {
		t.Fatalf("got %+v", got)
	}
	old := LoginExecutableOf(oar.AvailableInstallation{Via: "executable", Command: command, Version: "fake 0.9.0"}, "fake", "1.0.0")
	if old.Kind != "settled" || old.Result.Reason != "version_unsupported" || old.Result.Detail != "fake 1.0.0 or later is required; this is 0.9.0" {
		t.Fatalf("got %+v", old)
	}
	missing := LoginExecutableOf(oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/fake"}, "fake", "")
	if missing.Kind != "settled" || missing.Result.LoginResult() != (oar.LoginResult{Kind: "failed", Reason: "process_failed", Detail: "fake executable not found: /nonexistent/fake"}) {
		t.Fatalf("got %+v", missing)
	}
}

type streamEvent struct {
	kind, text string
	stream     LoginStream
}

func TestReadLoginStream(t *testing.T) {
	reader, writer := io.Pipe()
	var mu sync.Mutex
	var events []streamEvent
	done := make(chan struct{})
	go func() {
		ReadLoginStream(reader, LoginStderr, LoginOutputHandlers{
			OnLine: func(line string, stream LoginStream) {
				mu.Lock()
				events = append(events, streamEvent{"line", line, stream})
				mu.Unlock()
			},
			OnPartial: func(text string, stream LoginStream) {
				mu.Lock()
				events = append(events, streamEvent{"partial", text, stream})
				mu.Unlock()
			},
		})
		close(done)
	}()
	wave := []byte("🌊")
	for _, chunk := range [][]byte{
		[]byte(esc + "[1mfirst" + esc + "[0m\r\n  \nsec"), []byte("ond\rPaste code "), wave[:2], append(wave[2:], []byte(" >")...),
	} {
		if _, err := writer.Write(chunk); err != nil {
			t.Fatal(err)
		}
	}
	_ = writer.Close()
	<-done
	want := []streamEvent{
		{"line", "first", LoginStderr}, {"partial", "sec", LoginStderr},
		{"line", "second", LoginStderr}, {"partial", "Paste code ", LoginStderr},
		{"partial", "Paste code ", LoginStderr}, {"partial", "Paste code 🌊 >", LoginStderr},
		{"line", "Paste code 🌊 >", LoginStderr},
	}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("events = %q", events)
	}
}

func TestLoginBounds(t *testing.T) {
	bounds := NewLoginBounds(context.Background(), 20*time.Millisecond)
	if stop := <-bounds.Stopped; stop != LoginTimedOut {
		t.Fatalf("stop = %s", stop)
	}
	bounds.Dispose()
	ctx, cancel := context.WithCancel(context.Background())
	cancelled := NewLoginBounds(ctx, time.Hour)
	cancel()
	if stop := <-cancelled.Stopped; stop != LoginCancelled {
		t.Fatalf("stop = %s", stop)
	}
	cancelled.Dispose()
	already := NewLoginBounds(ctx, time.Hour)
	if stop := <-already.Stopped; stop != LoginCancelled {
		t.Fatalf("stop = %s", stop)
	}
	disposed := NewLoginBounds(context.Background(), 20*time.Millisecond)
	disposed.Dispose()
	select {
	case stop := <-disposed.Stopped:
		t.Fatalf("a disposed bound stopped: %s", stop)
	case <-time.After(60 * time.Millisecond):
	}
	if got := StoppedResult(LoginTimedOut, 1500*time.Millisecond); got != (oar.LoginResult{Kind: "failed", Reason: "timed_out", Detail: "no sign-in within 1500 ms"}) {
		t.Fatalf("got %+v", got)
	}
	if got := StoppedResult(LoginCancelled, time.Second); got != (oar.LoginResult{Kind: "cancelled"}) {
		t.Fatalf("got %+v", got)
	}
}
