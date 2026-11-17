package gateway

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

const (
	sseHeartbeatInterval = 15 * time.Second
	stateEveryInterval   = 200 * time.Millisecond
)

func initSSEHeaders(w http.ResponseWriter) (http.Flusher, bool) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, false
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	return flusher, true
}

func writeSSEData(w http.ResponseWriter, flusher http.Flusher, v any) bool {
	var raw []byte
	switch tv := v.(type) {
	case json.RawMessage:
		raw = tv
	case []byte:
		raw = tv
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return false
		}
		raw = b
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

func writeSSEPing(w http.ResponseWriter, flusher http.Flusher) bool {
	if _, err := w.Write([]byte(": ping\n\n")); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

func wantsSSE(r *http.Request) bool {
	accept := strings.ToLower(r.Header.Get("Accept"))
	return strings.Contains(accept, "text/event-stream")
}

func (h *Handler) handleStateStreamOrJSON(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
		return
	}

	if !wantsSSE(r) {
		frame := h.hub.buildStateFrame(r.Context())
		rev := int64(1)
		var space any
		if h.st != nil && h.st.Game != nil {
			rRev, rSpace := h.st.Game.Snapshot()
			rev = rRev
			space = rSpace
		} else {
			space = frame.State
		}
		writeJSONRaw(w, http.StatusOK, map[string]any{
			"rev":   rev,
			"space": space,
			"frame": frame,
		})
		return
	}

	flusher, ok := initSSEHeaders(w)
	if !ok {
		writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
		return
	}

	notifyCh := make(chan int64, 16)
	unsub := func() {}
	if h.st != nil {
		unsub = h.st.SubscribeStateChange(func(seq int64) {
			select {
			case notifyCh <- seq:
			default:
			}
		})
	}
	defer unsub()

	frame := h.hub.buildStateFrame(r.Context())
	if !writeSSEData(w, flusher, frame) {
		return
	}
	if r.Method == http.MethodHead {
		return
	}

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()

	lastSentSeq := frame.Seq
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !writeSSEPing(w, flusher) {
				return
			}
		case <-notifyCh:
			// Coalesce bursty notifications over stateEveryInterval (matching TS core.ts stateEveryMs).
			timer := time.NewTimer(stateEveryInterval)
			select {
			case <-r.Context().Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			for len(notifyCh) > 0 {
				<-notifyCh
			}
			nextFrame := h.hub.buildStateFrame(r.Context())
			if nextFrame.Seq != lastSentSeq {
				lastSentSeq = nextFrame.Seq
				if !writeSSEData(w, flusher, nextFrame) {
					return
				}
			}
		}
	}
}

func (h *Handler) handleLiveSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
		return
	}
	flusher, ok := initSSEHeaders(w)
	if !ok {
		writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
		return
	}
	ch, unsub := h.hub.subscribeLive()
	defer unsub()

	if !writeSSEPing(w, flusher) {
		return
	}
	if r.Method == http.MethodHead {
		return
	}

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !writeSSEPing(w, flusher) {
				return
			}
		case raw := <-ch:
			if !writeSSEData(w, flusher, raw) {
				return
			}
		}
	}
}

func (h *Handler) handleEventsSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
		return
	}
	flusher, ok := initSSEHeaders(w)
	if !ok {
		writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
		return
	}
	ch, unsub := h.hub.subscribeEvents()
	defer unsub()

	snap := h.hub.buildSpaceState(r.Context())
	if !writeSSEData(w, flusher, map[string]any{
		"type":  "snapshot",
		"at":    h.hub.nowMs(),
		"state": snap,
	}) {
		return
	}
	if r.Method == http.MethodHead {
		return
	}

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !writeSSEPing(w, flusher) {
				return
			}
		case raw := <-ch:
			if !writeSSEData(w, flusher, raw) {
				return
			}
		}
	}
}

func (h *Handler) handleIssueWatchSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
		return
	}
	issueID := strings.TrimPrefix(r.URL.Path, "/api/v1/issue/watch/")
	issueID = strings.Trim(issueID, "/")
	if issueID == "" || strings.Contains(issueID, "/") {
		writeError(w, newBizError(BizIssueNotFound, "issue not found"), BizIssueNotFound)
		return
	}

	flusher, ok := initSSEHeaders(w)
	if !ok {
		writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
		return
	}

	emitState := func() bool {
		if h.st == nil || h.st.Issues == nil {
			return writeSSEData(w, flusher, map[string]any{"kind": "missing", "issue": issueID})
		}
		iss, err := h.st.Issues.GetIssue(r.Context(), issueID)
		if err != nil {
			return writeSSEData(w, flusher, map[string]any{"kind": "missing", "issue": issueID})
		}
		h.hub.mu.RLock()
		del := h.hub.state.Issues[iss.ID] != nil && h.hub.state.Issues[iss.ID].Deleted
		h.hub.mu.RUnlock()
		if del {
			return writeSSEData(w, flusher, map[string]any{"kind": "missing", "issue": issueID})
		}
		dto := h.hub.buildProtoIssue(iss)
		sessIDs := []string{}
		sessions := []ProtoSession{}
		seen := map[string]bool{}
		h.hub.mu.RLock()
		for _, a := range dto.Assignments {
			for _, ex := range a.Executions {
				if ex.Kind == "worker" && ex.Session != "" && !seen[ex.Session] {
					seen[ex.Session] = true
					sessIDs = append(sessIDs, ex.Session)
					if s := h.hub.state.Sessions[ex.Session]; s != nil {
						sessions = append(sessions, *s)
					}
				}
			}
		}
		h.hub.mu.RUnlock()
		settled := dto.Status == "done" || dto.Status == "canceled" || dto.Status == "in_review"
		return writeSSEData(w, flusher, map[string]any{
			"kind":            "state",
			"issue":           dto,
			"sessions":        sessions,
			"sessionIds":      sessIDs,
			"settled":         settled,
			"omittedSessions": 0,
		})
	}

	if !emitState() {
		return
	}
	if r.Method == http.MethodHead {
		return
	}

	notifyCh := make(chan int64, 16)
	unsub := func() {}
	if h.st != nil {
		unsub = h.st.SubscribeStateChange(func(seq int64) {
			select {
			case notifyCh <- seq:
			default:
			}
		})
	}
	defer unsub()

	ticker := time.NewTicker(sseHeartbeatInterval)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
			if !writeSSEPing(w, flusher) {
				return
			}
		case <-notifyCh:
			for len(notifyCh) > 0 {
				<-notifyCh
			}
			if !emitState() {
				return
			}
		}
	}
}

func (h *Handler) handleSubscribeSSE(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(r.URL.Path, "/api/v1/subscribe/")
	name = strings.Trim(name, "/")
	rawPayload := strings.TrimSpace(r.URL.Query().Get("payload"))
	if rawPayload == "" {
		rawPayload = "{}"
	}

	switch name {
	case "channel.follow":
		var p struct {
			ID    string `json:"id"`
			After *int64 `json:"after"`
		}
		if err := json.Unmarshal([]byte(rawPayload), &p); err != nil || strings.TrimSpace(p.ID) == "" || p.After == nil {
			writeError(w, newBizError(BizInvalidInput, "invalid channel.follow payload"), BizInvalidInput)
			return
		}
		ch, err := h.resolveChannel(r.Context(), p.ID)
		if err != nil {
			writeError(w, err, BizChannelNotFound)
			return
		}
		events, _ := h.st.Channels.ListEvents(r.Context(), ch.ID, 0, 1000)

		flusher, ok := initSSEHeaders(w)
		if !ok {
			writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
			return
		}
		sub, unsub := h.hub.subscribeChannel()
		defer unsub()

		lastRev := *p.After
		if !writeSSEPing(w, flusher) {
			return
		}
		for _, ev := range events {
			msg := h.hub.buildChatMessage(ev)
			if msg.Revision > lastRev {
				lastRev = msg.Revision
				if !writeSSEData(w, flusher, map[string]any{"_tag": "Message", "message": msg}) {
					return
				}
			}
		}
		if r.Method == http.MethodHead {
			return
		}
		ticker := time.NewTicker(sseHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if !writeSSEPing(w, flusher) {
					return
				}
			case b := <-sub:
				if b.ChannelID == ch.ID && b.Revision > lastRev {
					lastRev = b.Revision
					if !writeSSEData(w, flusher, map[string]any{"_tag": "Message", "message": b.Message}) {
						return
					}
				}
			}
		}

	case "channel.reports":
		var p struct {
			After *string `json:"after"`
		}
		if err := json.Unmarshal([]byte(rawPayload), &p); err != nil {
			writeError(w, newBizError(BizInvalidInput, "invalid channel.reports payload"), BizInvalidInput)
			return
		}
		flusher, ok := initSSEHeaders(w)
		if !ok {
			writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
			return
		}
		sub, unsub := h.hub.subscribeChannel()
		defer unsub()

		if !writeSSEPing(w, flusher) {
			return
		}
		if r.Method == http.MethodHead {
			return
		}
		ticker := time.NewTicker(sseHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if !writeSSEPing(w, flusher) {
					return
				}
			case b := <-sub:
				if b.Message.Kind == "report" {
					if !writeSSEData(w, flusher, map[string]any{"_tag": "Message", "message": b.Message}) {
						return
					}
				}
			}
		}

	case "artifact.follow":
		var p struct {
			ID    string `json:"id"`
			After *int64 `json:"after"`
		}
		if err := json.Unmarshal([]byte(rawPayload), &p); err != nil || strings.TrimSpace(p.ID) == "" || p.After == nil {
			writeError(w, newBizError(BizInvalidInput, "invalid artifact.follow payload"), BizInvalidInput)
			return
		}
		snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), p.ID)
		if err != nil {
			writeError(w, err, BizArtifactNotFound)
			return
		}
		flusher, ok := initSSEHeaders(w)
		if !ok {
			writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
			return
		}
		sub, unsub := h.hub.subscribeArtifact()
		defer unsub()
		if !writeSSEPing(w, flusher) {
			return
		}
		if snap.Seq > *p.After {
			blocks := make([]protoBlock, 0, len(snap.Ordered))
			for _, b := range snap.Ordered {
				blocks = append(blocks, toProtoBlock(b))
			}
			if !writeSSEData(w, flusher, map[string]any{"_tag": "Blocks", "seq": snap.Seq, "blocks": blocks}) {
				return
			}
		}
		if r.Method == http.MethodHead {
			return
		}
		ticker := time.NewTicker(sseHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if !writeSSEPing(w, flusher) {
					return
				}
			case b := <-sub:
				if b.ArtifactID == p.ID && !b.Suggestions {
					nextSnap, sErr := h.st.Artifacts.Pages.Snapshot(r.Context(), p.ID)
					if sErr == nil {
						blocks := make([]protoBlock, 0, len(nextSnap.Ordered))
						for _, blk := range nextSnap.Ordered {
							blocks = append(blocks, toProtoBlock(blk))
						}
						if !writeSSEData(w, flusher, map[string]any{"_tag": "Blocks", "seq": nextSnap.Seq, "blocks": blocks}) {
							return
						}
					}
				}
			}
		}

	case "artifact.suggestion.follow":
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal([]byte(rawPayload), &p); err != nil || strings.TrimSpace(p.ID) == "" {
			writeError(w, newBizError(BizInvalidInput, "invalid artifact.suggestion.follow payload"), BizInvalidInput)
			return
		}
		snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), p.ID)
		if err != nil {
			writeError(w, err, BizArtifactNotFound)
			return
		}
		flusher, ok := initSSEHeaders(w)
		if !ok {
			writeError(w, newBizError(BizInternalError, "streaming unsupported"), BizInternalError)
			return
		}
		sub, unsub := h.hub.subscribeArtifact()
		defer unsub()
		if !writeSSEPing(w, flusher) {
			return
		}
		suggs := make([]protoSuggestion, 0, len(snap.Suggestions))
		for _, sg := range snap.Suggestions {
			suggs = append(suggs, toProtoSuggestion(sg))
		}
		if !writeSSEData(w, flusher, map[string]any{"_tag": "Suggestions", "suggestions": suggs}) {
			return
		}
		if r.Method == http.MethodHead {
			return
		}
		ticker := time.NewTicker(sseHeartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ticker.C:
				if !writeSSEPing(w, flusher) {
					return
				}
			case b := <-sub:
				if b.ArtifactID == p.ID && b.Suggestions {
					nextSnap, sErr := h.st.Artifacts.Pages.Snapshot(r.Context(), p.ID)
					if sErr == nil {
						nextSuggs := make([]protoSuggestion, 0, len(nextSnap.Suggestions))
						for _, sg := range nextSnap.Suggestions {
							nextSuggs = append(nextSuggs, toProtoSuggestion(sg))
						}
						if !writeSSEData(w, flusher, map[string]any{"_tag": "Suggestions", "suggestions": nextSuggs}) {
							return
						}
					}
				}
			}
		}

	default:
		writeError(w, newBizError(BizRouteNotFound, "unknown subscription: "+name), BizRouteNotFound)
	}
}
