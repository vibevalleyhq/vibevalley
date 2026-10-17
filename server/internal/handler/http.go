// Each handler only forwards to the service that owns the rule.
package handler

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

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
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return nil, nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	send := func(v any) bool {
		body, err := json.Marshal(v)
		if err != nil {
			return true
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", body); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	ping := func() bool {
		if _, err := fmt.Fprint(w, ": ping\n\n"); err != nil {
			return false
		}
		flusher.Flush()
		return true
	}
	return send, ping, true
}

// The client's stream: no facts, no snapshot; the StateFrame already carries the state.
func (a api) liveEvents(w http.ResponseWriter, r *http.Request) {
	send, ping, ok := sse(w)
	if !ok {
		return
	}
	_, events, stop := a.f.Core.Events()
	defer stop()
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, open := <-events:
			if !open {
				return
			}
			live, ok := protocol.LiveEventOf(e)
			if !ok {
				continue
			}
			if !send(live) {
				return
			}
		case <-tick.C:
			if !ping() {
				return
			}
		}
	}
}

func (a api) sideEvents(w http.ResponseWriter, r *http.Request) {
	send, ping, ok := sse(w)
	if !ok {
		return
	}
	snapshot, events, stop := a.f.Core.Events()
	defer stop()
	if !send(snapshot) {
		return
	}
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case e, open := <-events:
			if !open || !send(e) {
				return
			}
		case <-tick.C:
			if !ping() {
				return
			}
		}
	}
}

func (a api) stateFrames(w http.ResponseWriter, r *http.Request) {
	send, ping, ok := sse(w)
	if !ok {
		return
	}
	frames := a.f.Core.States(r.Context().Done())
	tick := time.NewTicker(heartbeat)
	defer tick.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case frame, open := <-frames:
			if !open || !send(frame) {
				return
			}
		case <-tick.C:
			if !ping() {
				return
			}
		}
	}
}
