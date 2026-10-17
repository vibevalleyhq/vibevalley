package main

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// issue run starts the issue, waits while it is in progress, and prints the changes once it is in review.
func TestIssueRunWaitsForTheReview(t *testing.T) {
	runPoll = time.Millisecond
	var looks atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/issues/t1/start", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, `{"worker":"w1"}`) })
	mux.HandleFunc("GET /api/issues/t1", func(w http.ResponseWriter, r *http.Request) {
		status := "in_progress"
		if looks.Add(1) > 2 {
			status = "in_review"
		}
		io.WriteString(w, `{"id":"t1","title":"x","priority":"medium","rank":1,"createdAt":1,"workers":["w1"],"status":"`+status+`"}`)
	})
	mux.HandleFunc("GET /api/issues/t1/changes", func(w http.ResponseWriter, r *http.Request) {
		io.WriteString(w, `{"project":"demo","base":"main","commits":[],"files":[],"uncommitted":[],"conflicts":[],"behind":0}`)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	out := capture(t, func() error { return issueRun(context.Background(), []string{"t1", "--server", srv.URL}) })
	if !strings.Contains(out, `"project": "demo"`) || looks.Load() != 3 {
		t.Fatalf("looked %d times, printed %s", looks.Load(), out)
	}
}

func capture(t *testing.T, f func() error) string {
	t.Helper()
	r, w, _ := os.Pipe()
	stdout := os.Stdout
	os.Stdout = w
	err := f()
	os.Stdout = stdout
	w.Close()
	b, _ := io.ReadAll(r)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
