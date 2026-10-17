package handler

import (
	"errors"
	"net/http/httptest"
	"testing"
	"time"
)

type failingStream struct {
	*httptest.ResponseRecorder
	failure   error
	deadlines []time.Time
}

func (w *failingStream) FlushError() error { return w.failure }
func (w *failingStream) SetWriteDeadline(at time.Time) error {
	w.deadlines = append(w.deadlines, at)
	return nil
}

func TestStreamStopsOnFlushFailure(t *testing.T) {
	for _, action := range []string{"send", "ping", "open"} {
		t.Run(action, func(t *testing.T) {
			w := &failingStream{ResponseRecorder: httptest.NewRecorder()}
			if action == "open" {
				w.failure = errors.New("disconnected")
			}
			send, ping, ok := sse(w)
			if action == "open" {
				if ok {
					t.Fatal("opened broken stream")
				}
				return
			}
			if !ok {
				t.Fatal("cannot open stream")
			}
			w.failure = errors.New("disconnected")
			if action == "send" && send(map[string]string{"text": "hi"}) {
				t.Fatal("ignored flush failure")
			}
			if action == "ping" && ping() {
				t.Fatal("ignored ping failure")
			}
			if len(w.deadlines) != 3 || !w.deadlines[1].IsZero() || time.Until(w.deadlines[2]) > heartbeat {
				t.Fatalf("write deadline not renewed: %v", w.deadlines)
			}
		})
	}
}

func TestStreamDoesNotExpireBetweenWrites(t *testing.T) {
	w := &failingStream{ResponseRecorder: httptest.NewRecorder()}
	send, ping, ok := sse(w)
	if !ok || !send("a") || !ping() {
		t.Fatal("stream failed")
	}
	if len(w.deadlines) != 6 {
		t.Fatalf("deadlines: %v", w.deadlines)
	}
	for i, deadline := range w.deadlines {
		if deadline.IsZero() != (i%2 == 1) {
			t.Fatalf("write deadline left active while idle: %v", w.deadlines)
		}
	}
}

func TestStreamRejectsUnencodableEvent(t *testing.T) {
	send, _, ok := sse(httptest.NewRecorder())
	if !ok || send(make(chan int)) {
		t.Fatal("unencodable event reported as sent")
	}
}

func TestStreamOwnsInitialAndLiveDelivery(t *testing.T) {
	events := make(chan string, 1)
	events <- "next"
	close(events)
	w := httptest.NewRecorder()
	serveStream(w, httptest.NewRequest("GET", "/", nil), events, "snapshot")
	if got := w.Body.String(); got != "data: \"snapshot\"\n\ndata: \"next\"\n\n" {
		t.Fatal(got)
	}
}
