// Each handler only forwards to the service that owns the rule.
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"time"

	vvagent "vibevalley/internal/agent/brain"
	"vibevalley/internal/protocol"
	"vibevalley/internal/workspace"
)

// Keeps proxies from closing a quiet event stream.
const heartbeat = 20 * time.Second

// It hands the yard gate its part (apiMux) before the farm starts: the gate answers the API, and the API answers for every service, the gate's own
// pages too.
func New(f *workspace.Workspace) http.Handler {
	f.Gate.API = apiMux(f)
	mux := apiMux(f)
	mux.Handle("/mcp", f.MCP.Handler())
	mux.Handle("/mcp/", f.MCP.Handler())
	mux.Handle(protocol.ChatCompletionsPath, vvagent.ChatCompletions{Answerer: f.Manager.Answerer, Logf: log.Printf})
	return mux
}

// All the yard gate lets through.
func apiMux(f *workspace.Workspace) *http.ServeMux {
	a := api{f}
	mux := http.NewServeMux()
	protocol.Mount(mux, a)
	streams := map[string]http.HandlerFunc{"state": a.stateFrames, "events": a.sideEvents, "live": a.liveEvents}
	for _, s := range protocol.Streams {
		h, ok := streams[s.Name]
		if !ok {
			panic("no handler for stream " + s.Name)
		}
		mux.HandleFunc("GET "+s.Path, h)
	}
	return mux
}

func sse(w http.ResponseWriter) (func(any) bool, func() bool, bool) {
	controller := http.NewResponseController(w)
	prepare := func() bool {
		err := controller.SetWriteDeadline(time.Now().Add(heartbeat))
		return err == nil || errors.Is(err, http.ErrNotSupported)
	}
	flush := func() bool {
		if err := controller.Flush(); err != nil {
			return false
		}
		// The deadline bounds a write, not the idle time before the next heartbeat.
		err := controller.SetWriteDeadline(time.Time{})
		return err == nil || errors.Is(err, http.ErrNotSupported)
	}
	if _, ok := w.(http.Flusher); !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	if !prepare() {
		return nil, nil, false
	}
	w.WriteHeader(http.StatusOK)
	if !flush() {
		return nil, nil, false
	}
	send := func(v any) bool {
		body, err := json.Marshal(v)
		if err != nil {
			return false
		}
		if !prepare() {
			return false
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", body); err != nil {
			return false
		}
		return flush()
	}
	ping := func() bool {
		if !prepare() {
			return false
		}
		if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
			return false
		}
		return flush()
	}
	return send, ping, true
}

// serveStream owns heartbeat, response errors and cancellation for every SSE surface.
func serveStream[T any](w http.ResponseWriter, r *http.Request, events <-chan T, initial ...T) {
	send, ping, ok := sse(w)
	if !ok {
		return
	}
	for _, event := range initial {
		if !send(event) {
			return
		}
	}
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case event, open := <-events:
			if !open || !send(event) {
				return
			}
		case <-tick.C:
			if !ping() {
				return
			}
		}
	}
}

func (a api) liveEvents(w http.ResponseWriter, r *http.Request) {
	events, stop := a.f.Core.Live()
	defer stop()
	serveStream(w, r, events)
}

func (a api) sideEvents(w http.ResponseWriter, r *http.Request) {
	snapshot, events, stop := a.f.Core.Events()
	defer stop()
	serveStream(w, r, events, snapshot)
}

func (a api) stateFrames(w http.ResponseWriter, r *http.Request) {
	// End the producer when the response fails, even if the request is still live.
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	serveStream(w, r, a.f.Core.States(ctx.Done()))
}
