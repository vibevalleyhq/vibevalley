package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

var validPkmTiers = map[string]bool{
	"inbox":    true,
	"project":  true,
	"area":     true,
	"resource": true,
	"archive":  true,
	"journal":  true,
}

func (h *Handler) resolveChannel(ctx context.Context, idOrName string) (channel.Channel, error) {
	if h.st == nil || h.st.Channels == nil {
		return channel.Channel{}, channel.ErrNotFound
	}
	target := strings.TrimSpace(strings.TrimPrefix(idOrName, "#"))
	if ch, err := h.st.Channels.GetChannel(ctx, target); err == nil {
		h.hub.mu.RLock()
		del := h.hub.state.Channels[ch.ID] != nil && h.hub.state.Channels[ch.ID].Deleted
		h.hub.mu.RUnlock()
		if del {
			return channel.Channel{}, channel.ErrNotFound
		}
		return ch, nil
	}
	all, err := h.st.Channels.ListChannels(ctx)
	if err != nil {
		return channel.Channel{}, err
	}
	for _, ch := range all {
		if ch.ID == target || strings.EqualFold(ch.Name, target) {
			h.hub.mu.RLock()
			del := h.hub.state.Channels[ch.ID] != nil && h.hub.state.Channels[ch.ID].Deleted
			h.hub.mu.RUnlock()
			if del {
				return channel.Channel{}, channel.ErrNotFound
			}
			return ch, nil
		}
	}
	return channel.Channel{}, channel.ErrNotFound
}

func (h *Handler) handleChannelList(w http.ResponseWriter, r *http.Request) {
	if h.st == nil || h.st.Channels == nil {
		writeSuccess(w, []ProtoChannel{})
		return
	}
	chs, err := h.st.Channels.ListChannels(r.Context())
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	out := make([]ProtoChannel, 0, len(chs))
	for _, ch := range chs {
		dto := h.hub.buildChannelDTO(r.Context(), ch)
		if dto.ID == "" {
			continue
		}
		out = append(out, dto)
	}
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Default != out[j].Default {
			return out[i].Default
		}
		return out[i].ID < out[j].ID
	})
	writeSuccess(w, out)
}

func (h *Handler) handleChannelCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name        string `json:"name"`
		Description string `json:"description"`
		Repo        string `json:"repo"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	name := strings.TrimSpace(strings.TrimPrefix(req.Name, "#"))
	if name == "" {
		writeError(w, newBizError(BizInvalidInput, "channel name is required"), BizInvalidInput)
		return
	}
	id := pkm.SlugOf(name)
	if id == "" {
		id = randomID("ch")
	}
	ch, err := h.st.Channels.CreateChannel(r.Context(), channel.Channel{
		ID:     id,
		Type:   channel.TypePublic,
		Name:   name,
		Topic:  req.Description,
		RepoID: req.Repo,
	})
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	meta.Title = name
	meta.Description = req.Description
	meta.HasDesc = true
	meta.Repo = req.Repo
	meta.LastAt = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())

	dto := h.hub.buildChannelDTO(r.Context(), ch)
	h.hub.emitServerEvent(map[string]any{
		"type":    "channelChanged",
		"at":      h.hub.nowMs(),
		"channel": dto,
	})
	writeSuccess(w, ch.ID)
}

func (h *Handler) handleChannelUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID          string   `json:"id"`
		Description *string  `json:"description"`
		Repo        *string  `json:"repo"`
		Name        *string  `json:"name"`
		Category    *string  `json:"category"`
		Before      *string  `json:"before"`
		Members     []string `json:"members"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	if req.Description != nil {
		meta.Description = *req.Description
		meta.HasDesc = true
	}
	if req.Repo != nil {
		meta.Repo = *req.Repo
	}
	if req.Name != nil && strings.TrimSpace(*req.Name) != "" {
		meta.Title = strings.TrimSpace(*req.Name)
	}
	if req.Category != nil {
		meta.Category = *req.Category
	}
	if req.Members != nil {
		meta.Members = copyStrings(req.Members)
	}
	meta.LastAt = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())

	dto := h.hub.buildChannelDTO(r.Context(), ch)
	h.hub.emitServerEvent(map[string]any{
		"type":    "channelChanged",
		"at":      h.hub.nowMs(),
		"channel": dto,
	})
	writeVoid(w)
}

func (h *Handler) handleChannelDefaultSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	h.hub.state.DefaultChannel = ch.ID
	for cid, cm := range h.hub.state.Channels {
		if cm != nil {
			cm.Default = (cid == ch.ID)
			cm.HasDefault = true
		}
	}
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	meta.Default = true
	meta.HasDefault = true
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleChannelDirectCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ag := strings.TrimSpace(req.Agent)
	if ag == "" {
		ag = "orchestrator"
	}
	dmID := "dm:" + ag
	ch, _, err := h.st.Channels.EnsureChannel(r.Context(), channel.Channel{
		ID:             dmID,
		Type:           channel.TypeDirect,
		Name:           ag,
		PeerID:         ag,
		DefaultAgentID: ag,
	})
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	meta.Deleted = false
	meta.Title = ag
	meta.Orchestrator = ag
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeSuccess(w, ch.ID)
}

func (h *Handler) handleChannelThreadCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string `json:"id"`
		RequestKey string `json:"requestKey"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := checkRequestKeyLength(req.RequestKey); err != nil {
		writeError(w, err, BizRequestKeyTooLong)
		return
	}
	chID, seq, ok := parseMessageID(req.ID)
	if !ok {
		writeError(w, newBizError(BizChannelNotFound, "invalid message id"), BizChannelNotFound)
		return
	}
	parentCh, err := h.resolveChannel(r.Context(), chID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	if _, err := h.st.Channels.GetEvent(r.Context(), parentCh.ID, seq); err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	threadID := fmt.Sprintf("thread:%s:%d", parentCh.ID, seq)
	th, _, err := h.st.Channels.EnsureChannel(r.Context(), channel.Channel{
		ID:              threadID,
		Type:            channel.TypeThread,
		Name:            fmt.Sprintf("%s:%d", firstNonEmpty(parentCh.Name, parentCh.ID), seq),
		ParentChannelID: parentCh.ID,
		ParentEventSeq:  seq,
	})
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(th.ID)
	meta.Deleted = false
	meta.LastAt = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeSuccess(w, th.ID)
}

var mentionRe = regexp.MustCompile(`@([a-zA-Z0-9._-]+)`)

func extractMentions(text string) []string {
	matches := mentionRe.FindAllStringSubmatch(text, -1)
	if len(matches) == 0 {
		return []string{}
	}
	seen := make(map[string]bool)
	out := make([]string, 0, len(matches))
	for _, m := range matches {
		id := m[1]
		if !seen[id] {
			seen[id] = true
			out = append(out, id)
		}
	}
	return out
}

func (h *Handler) handleChannelMessageSend(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID          string   `json:"id"`
		Text        string   `json:"text"`
		ReplyTo     *int64   `json:"replyTo"`
		Attachments []string `json:"attachments"`
		Station     *int     `json:"station"`
		Agent       string   `json:"agent"`
		Repo        string   `json:"repo"`
		SendKey     string   `json:"sendKey"`
		To          string   `json:"to"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	mentions := extractMentions(req.Text)
	if req.Agent != "" && !slices.Contains(mentions, req.Agent) {
		mentions = append(mentions, req.Agent)
	}
	res, _, err := h.st.PostAndPumpChannel(r.Context(), channel.AppendRequest{
		ChannelID:     ch.ID,
		Kind:          contract.ChannelEventMessage,
		AuthorID:      "user",
		ActorKind:     channel.ActorUser,
		Text:          req.Text,
		Mentions:      mentions,
		TargetAgentID: req.To,
		SendKey:       req.SendKey,
	})
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	msgID := formatMessageID(ch.ID, res.Event.Seq)
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	meta.LastAt = res.Event.CreatedAtMs
	if len(req.Attachments) > 0 {
		meta.Attachments[msgID] = copyStrings(req.Attachments)
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())

	msg := h.hub.buildChatMessage(res.Event)
	h.hub.emitChannelMessage(ch.ID, msg.Revision, msg)
	writeVoid(w)
}

func (h *Handler) handleChannelMessageList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Before *int64 `json:"before"`
		Limit  *int   `json:"limit"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	events, err := h.st.Channels.ListEvents(r.Context(), ch.ID, 0, 1000)
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	out := make([]ProtoChatMessage, 0, len(events))
	for _, ev := range events {
		if req.Before != nil && ev.Seq >= *req.Before {
			continue
		}
		out = append(out, h.hub.buildChatMessage(ev))
	}
	if req.Limit != nil && *req.Limit > 0 && len(out) > *req.Limit {
		out = out[len(out)-*req.Limit:]
	}
	writeSuccess(w, out)
}

func (h *Handler) handleChannelMessageUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID          string   `json:"id"`
		Text        string   `json:"text"`
		Attachments []string `json:"attachments"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	chID, seq, ok := parseMessageID(req.ID)
	if !ok {
		writeError(w, newBizError(BizChannelNotFound, "invalid message id"), BizChannelNotFound)
		return
	}
	ev, err := h.st.Channels.GetEvent(r.Context(), chID, seq)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	nowMs := h.hub.nowMs()
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(chID)
	rev := h.hub.allocMsgSeqLocked()
	meta.Edits[req.ID] = messageEditRecord{
		Text:     req.Text,
		EditedAt: nowMs,
		Revision: rev,
	}
	if req.Attachments != nil {
		meta.Attachments[req.ID] = copyStrings(req.Attachments)
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	msg := h.hub.buildChatMessage(ev)
	h.hub.emitChannelMessage(chID, msg.Revision, msg)
	writeSuccess(w, msg)
}

func (h *Handler) handleChannelMessageDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	chID, seq, ok := parseMessageID(req.ID)
	if !ok {
		writeError(w, newBizError(BizChannelNotFound, "invalid message id"), BizChannelNotFound)
		return
	}
	ev, err := h.st.Channels.GetEvent(r.Context(), chID, seq)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	nowMs := h.hub.nowMs()
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(chID)
	meta.MsgDeletes[req.ID] = nowMs
	delete(meta.Pins, req.ID)
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	msg := h.hub.buildChatMessage(ev)
	h.hub.emitChannelMessage(chID, msg.Revision, msg)
	writeVoid(w)
}

func (h *Handler) handleChannelMessagePreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	chID, seq, ok := parseMessageID(req.ID)
	if !ok {
		writeError(w, newBizError(BizChannelNotFound, "invalid message id"), BizChannelNotFound)
		return
	}
	if _, err := h.st.Channels.GetEvent(r.Context(), chID, seq); err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Clear content of message %s", req.ID)},
	})
}

func (h *Handler) handleChannelMessageSearch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text    string `json:"text"`
		Channel string `json:"channel"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	chs, err := h.st.Channels.ListChannels(r.Context())
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	q := strings.ToLower(strings.TrimSpace(req.Text))
	hits := []map[string]any{}
	for _, ch := range chs {
		if req.Channel != "" && ch.ID != req.Channel && ch.ParentChannelID != req.Channel {
			continue
		}
		events, _ := h.st.Channels.ListEvents(r.Context(), ch.ID, 0, 500)
		for _, ev := range events {
			msg := h.hub.buildChatMessage(ev)
			if msg.Deleted != nil {
				continue
			}
			if q == "" || strings.Contains(strings.ToLower(msg.Text), q) {
				hits = append(hits, map[string]any{
					"message": msg,
					"channel": ch.ID,
					"address": "#" + firstNonEmpty(ch.Name, ch.ID),
				})
			}
		}
	}
	writeSuccess(w, hits)
}

func (h *Handler) handleChannelReactionSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID    string `json:"id"`
		Emoji string `json:"emoji"`
		On    bool   `json:"on"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	chID, seq, ok := parseMessageID(req.ID)
	if !ok {
		writeError(w, newBizError(BizChannelNotFound, "invalid message id"), BizChannelNotFound)
		return
	}
	ev, err := h.st.Channels.GetEvent(r.Context(), chID, seq)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(chID)
	list := meta.Reactions[req.ID]
	foundIdx := -1
	for i := range list {
		if list[i].Emoji == req.Emoji {
			foundIdx = i
			break
		}
	}
	if req.On {
		if foundIdx >= 0 {
			if !slices.Contains(list[foundIdx].By, "user") {
				list[foundIdx].By = append(list[foundIdx].By, "user")
			}
		} else {
			list = append(list, ProtoReaction{Emoji: req.Emoji, By: []string{"user"}})
		}
	} else if foundIdx >= 0 {
		var nextBy []string
		for _, b := range list[foundIdx].By {
			if b != "user" {
				nextBy = append(nextBy, b)
			}
		}
		if len(nextBy) == 0 {
			list = append(list[:foundIdx], list[foundIdx+1:]...)
		} else {
			list[foundIdx].By = nextBy
		}
	}
	meta.Reactions[req.ID] = list
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	msg := h.hub.buildChatMessage(ev)
	h.hub.emitChannelMessage(chID, msg.Revision, msg)
	writeSuccess(w, msg)
}

func (h *Handler) handleChannelPinSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
		On bool   `json:"on"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	chID, seq, ok := parseMessageID(req.ID)
	if !ok {
		writeError(w, newBizError(BizChannelNotFound, "invalid message id"), BizChannelNotFound)
		return
	}
	ev, err := h.st.Channels.GetEvent(r.Context(), chID, seq)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(chID)
	if req.On {
		meta.Pins[req.ID] = h.hub.nowMs()
	} else {
		delete(meta.Pins, req.ID)
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	msg := h.hub.buildChatMessage(ev)
	h.hub.emitChannelMessage(chID, msg.Revision, msg)
	writeSuccess(w, msg)
}

func (h *Handler) handleChannelPinList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.RLock()
	meta := h.hub.state.Channels[ch.ID]
	pins := map[string]int64{}
	if meta != nil {
		for k, v := range meta.Pins {
			pins[k] = v
		}
	}
	h.hub.mu.RUnlock()
	out := []ProtoChatMessage{}
	for msgID := range pins {
		cid, seq, ok := parseMessageID(msgID)
		if !ok || cid != ch.ID {
			continue
		}
		if ev, err := h.st.Channels.GetEvent(r.Context(), cid, seq); err == nil {
			out = append(out, h.hub.buildChatMessage(ev))
		}
	}
	sort.Slice(out, func(i, j int) bool {
		pi := pins[out[i].ID]
		pj := pins[out[j].ID]
		return pi > pj
	})
	writeSuccess(w, out)
}

func (h *Handler) handleChannelMarkRead(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Number int64  `json:"number"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	_, _ = h.st.Channels.AdvanceReadCursor(r.Context(), ch.ID, "user", req.Number)
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	n := req.Number
	meta.ReadNum = &n
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleChannelMarkUnread(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Number int64  `json:"number"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	unreadSeq := req.Number - 1
	if unreadSeq < 0 {
		unreadSeq = 0
	}
	meta.ReadNum = &unreadSeq
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleChannelArchiveSet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
		On bool   `json:"on"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	if req.On {
		now := h.hub.nowMs()
		meta.Archived = &now
	} else {
		meta.Archived = nil
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleChannelDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	if h.hub.state.DefaultChannel == ch.ID || ch.IsDefault {
		h.hub.mu.Unlock()
		writeError(w, newBizError(BizChannelRefused, "cannot delete the default channel"), BizChannelRefused)
		return
	}
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	meta.Deleted = true
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.emitServerEvent(map[string]any{
		"type": "channelRemoved",
		"at":   h.hub.nowMs(),
		"id":   ch.ID,
	})
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleChannelPreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Delete channel %s", ch.ID)},
	})
}

func (h *Handler) handleChannelNotifySet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Notify string `json:"notify"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ch, err := h.resolveChannel(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizChannelNotFound)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	meta.Notify = req.Notify
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleChannelUnreadList(w http.ResponseWriter, r *http.Request) {
	chs, err := h.st.Channels.ListChannels(r.Context())
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	out := []map[string]any{}
	for _, ch := range chs {
		dto := h.hub.buildChannelDTO(r.Context(), ch)
		if dto.ID == "" || dto.Unread == nil || *dto.Unread <= 0 {
			continue
		}
		addr := "#" + firstNonEmpty(dto.Name, dto.ID)
		if dto.Type == "direct" {
			addr = "@" + firstNonEmpty(dto.Peer, dto.Name, dto.ID)
		}
		row := map[string]any{
			"channel":     addr,
			"unread":      *dto.Unread,
			"mentionsYou": false,
		}
		if dto.Last != nil {
			row["latest"] = dto.Last.Text
		}
		out = append(out, row)
	}
	writeSuccess(w, out)
}

func parseMemoryFilesToDTOs(agentID string, snap memory.Snapshot) []map[string]any {
	out := []map[string]any{}
	for _, f := range snap.Files {
		lines := strings.Split(string(f.Content), "\n")
		for idx, raw := range lines {
			line := strings.TrimSpace(raw)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			line = strings.TrimPrefix(line, "- ")
			id := fmt.Sprintf("%s:%d:%d", f.RelPath, f.Version, idx)
			out = append(out, map[string]any{
				"id":       id,
				"agent":    agentID,
				"kind":     "note",
				"text":     line,
				"author":   "user",
				"at":       f.UpdatedAtMs,
				"recalled": 0,
				"fading":   false,
				"source":   "local",
			})
		}
	}
	return out
}

func (h *Handler) handleMemoryList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	scope := firstNonEmpty(req.Agent, memory.DefaultScopeID)
	snap, err := h.st.Memory.ActiveSnapshot(r.Context(), scope)
	if err != nil {
		writeError(w, err, BizMemoryRefused)
		return
	}
	writeSuccess(w, map[string]any{
		"memories": parseMemoryFilesToDTOs(scope, snap),
		"sources": []map[string]any{
			{
				"name":        "local",
				"label":       "Local Memory",
				"on":          true,
				"off":         "",
				"canList":     true,
				"canForget":   true,
				"transcripts": false,
			},
		},
	})
}

func (h *Handler) handleMemoryRecall(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
		Repo  string `json:"repo"`
		Text  string `json:"text"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	scope := firstNonEmpty(req.Agent, memory.DefaultScopeID)
	snap, err := h.st.Memory.ActiveSnapshot(r.Context(), scope)
	if err != nil {
		writeError(w, err, BizMemoryRefused)
		return
	}
	lines := []string{}
	chars := 0
	for _, m := range parseMemoryFilesToDTOs(scope, snap) {
		txt, _ := m["text"].(string)
		if txt != "" {
			lines = append(lines, txt)
			chars += len(txt)
		}
	}
	writeSuccess(w, map[string]any{
		"lines": lines,
		"chars": chars,
		"limit": 8000,
	})
}

func (h *Handler) handleMemoryCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent      string `json:"agent"`
		Text       string `json:"text"`
		Repo       string `json:"repo"`
		RequestKey string `json:"requestKey"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if err := checkRequestKeyLength(req.RequestKey); err != nil {
		writeError(w, err, BizRequestKeyTooLong)
		return
	}
	scope := firstNonEmpty(req.Agent, memory.DefaultScopeID)
	snap, _ := h.st.Memory.ActiveSnapshot(r.Context(), scope)
	rel := "notes.md"
	existing := ""
	if f, ok := snap.File(rel); ok {
		existing = string(f.Content)
	}
	if existing != "" && !strings.HasSuffix(existing, "\n") {
		existing += "\n"
	}
	existing += "- " + strings.TrimSpace(req.Text) + "\n"
	nextSnap, err := h.st.Memory.CommitFiles(r.Context(), memory.CommitRequest{
		ScopeID: scope,
		Summary: "Add memory note",
		Files:   []memory.MemoryFileInput{{RelPath: rel, Content: []byte(existing)}},
	})
	if err != nil {
		writeError(w, err, BizMemoryRefused)
		return
	}
	all := parseMemoryFilesToDTOs(scope, nextSnap)
	if len(all) > 0 {
		out := all[len(all)-1]
		if req.Repo != "" {
			out["repo"] = req.Repo
		}
		writeSuccess(w, out)
		return
	}
	writeSuccess(w, map[string]any{
		"id":       randomID("mem"),
		"agent":    scope,
		"kind":     "note",
		"text":     req.Text,
		"author":   "user",
		"at":       h.hub.nowMs(),
		"recalled": 0,
		"fading":   false,
	})
}

func (h *Handler) handleMemorySearch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent string `json:"agent"`
		Repo  string `json:"repo"`
		Text  string `json:"text"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	scope := firstNonEmpty(req.Agent, memory.DefaultScopeID)
	snap, _ := h.st.Memory.ActiveSnapshot(r.Context(), scope)
	q := strings.ToLower(strings.TrimSpace(req.Text))
	found := []map[string]any{}
	for _, m := range parseMemoryFilesToDTOs(scope, snap) {
		txt, _ := m["text"].(string)
		if q == "" || strings.Contains(strings.ToLower(txt), q) {
			m["score"] = 1.0
			m["scope"] = map[string]any{"kind": "global"}
			found = append(found, m)
		}
	}
	writeSuccess(w, map[string]any{
		"found":    found,
		"coverage": []string{"local"},
	})
}

func (h *Handler) handleMemoryDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent  string `json:"agent"`
		Memory string `json:"memory"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	scope := firstNonEmpty(req.Agent, memory.DefaultScopeID)
	snap, err := h.st.Memory.ActiveSnapshot(r.Context(), scope)
	if err != nil {
		writeError(w, err, BizMemoryNotFound)
		return
	}
	dtos := parseMemoryFilesToDTOs(scope, snap)
	found := false
	for _, d := range dtos {
		if d["id"] == req.Memory {
			found = true
			break
		}
	}
	if !found {
		writeError(w, newBizError(BizMemoryNotFound, "memory not found"), BizMemoryNotFound)
		return
	}
	// Remove matching line from notes.md.
	if f, ok := snap.File("notes.md"); ok {
		lines := strings.Split(string(f.Content), "\n")
		kept := []string{}
		for idx, raw := range lines {
			id := fmt.Sprintf("%s:%d:%d", f.RelPath, f.Version, idx)
			if id != req.Memory {
				kept = append(kept, raw)
			}
		}
		_, _ = h.st.Memory.CommitFiles(r.Context(), memory.CommitRequest{
			ScopeID: scope,
			Summary: "Delete memory note",
			Files:   []memory.MemoryFileInput{{RelPath: f.RelPath, Content: []byte(strings.Join(kept, "\n"))}},
		})
	}
	writeVoid(w)
}

func (h *Handler) handleMemoryPreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Agent  string `json:"agent"`
		Memory string `json:"memory"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Forget memory %s for %s", req.Memory, req.Agent)},
	})
}

// --- PKM handlers ---

type protoPkmBlock struct {
	ID       string            `json:"id"`
	Parent   string            `json:"parent,omitempty"`
	Depth    int               `json:"depth"`
	Marker   string            `json:"marker,omitempty"`
	Priority string            `json:"priority,omitempty"`
	Body     string            `json:"body"`
	Props    map[string]string `json:"props"`
	Path     string            `json:"path"`
}

type protoPkmPage struct {
	Slug    string            `json:"slug"`
	Title   string            `json:"title"`
	Tier    string            `json:"tier"`
	File    string            `json:"file"`
	Props   map[string]string `json:"props"`
	TLDR    string            `json:"tldr"`
	Blocks  []protoPkmBlock   `json:"blocks"`
	Updated int64             `json:"updated"`
}

func parsePkmOutline(slug, markdown string) []protoPkmBlock {
	lines := strings.Split(strings.ReplaceAll(markdown, "\r\n", "\n"), "\n")
	blocks := []protoPkmBlock{}
	for idx, raw := range lines {
		trimmed := strings.TrimSpace(raw)
		if trimmed == "" || strings.HasPrefix(trimmed, "---") {
			continue
		}
		depth := 0
		for _, ch := range raw {
			if ch == ' ' || ch == '\t' {
				depth++
			} else {
				break
			}
		}
		depth = depth / 2
		body := strings.TrimSpace(strings.TrimPrefix(trimmed, "- "))
		marker := ""
		for _, m := range []string{"TODO", "DOING", "DONE", "NOW", "LATER", "WAITING", "CANCELED"} {
			if strings.HasPrefix(body, m+" ") {
				marker = m
				body = strings.TrimSpace(strings.TrimPrefix(body, m))
				break
			}
		}
		id := fmt.Sprintf("%s-b%d", slug, idx+1)
		blocks = append(blocks, protoPkmBlock{
			ID:     id,
			Depth:  depth,
			Marker: marker,
			Body:   body,
			Props:  map[string]string{},
			Path:   body,
		})
	}
	return blocks
}

func renderPkmOutline(blocks []protoPkmBlock) string {
	lines := make([]string, 0, len(blocks))
	for _, b := range blocks {
		indent := strings.Repeat("  ", max(0, b.Depth))
		prefix := "- "
		if b.Marker != "" {
			prefix += b.Marker + " "
		}
		lines = append(lines, indent+prefix+b.Body)
	}
	return strings.Join(lines, "\n") + "\n"
}

func (h *Handler) pkmNoteToPage(n pkm.Note) protoPkmPage {
	props := map[string]string{}
	if n.Frontmatter.Raw != nil {
		for k, v := range n.Frontmatter.Raw {
			if s, ok := v.(string); ok {
				props[k] = s
			}
		}
	}
	tier := string(n.Tier)
	if !validPkmTiers[tier] {
		tier = "inbox"
	}
	blocks := parsePkmOutline(n.Slug, n.Body)
	return protoPkmPage{
		Slug:    n.Slug,
		Title:   firstNonEmpty(n.Title, n.Slug),
		Tier:    tier,
		File:    n.RelPath,
		Props:   props,
		TLDR:    n.Frontmatter.TLDR,
		Blocks:  blocks,
		Updated: n.UpdatedAtMs,
	}
}

func (h *Handler) loadAllPkmNotes(ctx context.Context) ([]pkm.Note, error) {
	if h.st == nil || h.st.PKM == nil {
		return nil, nil
	}
	hits, err := h.st.PKM.Search(ctx, pkm.SearchQuery{Limit: 1000})
	if err != nil {
		return nil, err
	}
	out := make([]pkm.Note, 0, len(hits))
	for _, hit := range hits {
		if n, ok, err := h.st.PKM.GetNote(ctx, hit.RelPath); err == nil && ok {
			out = append(out, n)
		}
	}
	return out, nil
}

func (h *Handler) handlePkmPageList(w http.ResponseWriter, r *http.Request) {
	root := ensureVaultDirIfConfigured(h.st)
	notes, err := h.loadAllPkmNotes(r.Context())
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	pages := make([]map[string]any, 0, len(notes))
	for _, n := range notes {
		pg := h.pkmNoteToPage(n)
		open := 0
		for _, b := range pg.Blocks {
			if b.Marker == "TODO" || b.Marker == "DOING" || b.Marker == "NOW" || b.Marker == "LATER" {
				open++
			}
		}
		summary := map[string]any{
			"slug":    pg.Slug,
			"title":   pg.Title,
			"tier":    pg.Tier,
			"file":    pg.File,
			"tldr":    pg.TLDR,
			"updated": pg.Updated,
			"open":    open,
		}
		if pg.Tier == "journal" && len(pg.Slug) == 10 {
			summary["day"] = pg.Slug
		}
		pages = append(pages, summary)
	}
	sort.SliceStable(pages, func(i, j int) bool {
		return pages[i]["updated"].(int64) > pages[j]["updated"].(int64)
	})
	writeSuccess(w, map[string]any{
		"root":  root,
		"pages": pages,
	})
}

func (h *Handler) handlePkmPageGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Page string `json:"page"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	n, ok, err := h.st.PKM.GetNote(r.Context(), req.Page)
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	if !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	pg := h.pkmNoteToPage(n)
	bls, _ := h.st.PKM.Backlinks(r.Context(), n.Title)
	projects := []map[string]any{}
	journals := []map[string]any{}
	areas := []map[string]any{}
	archives := []map[string]any{}
	for _, bl := range bls {
		tier := string(pkm.TierOfPath(bl.SourcePath))
		if !validPkmTiers[tier] {
			tier = "inbox"
		}
		item := map[string]any{
			"block":     bl.BlockID,
			"page":      pkm.SlugOf(pkm.TitleOfPath(bl.SourcePath)),
			"pageTitle": pkm.TitleOfPath(bl.SourcePath),
			"tier":      tier,
			"path":      bl.SourcePath,
			"body":      bl.TargetTitle,
		}
		switch tier {
		case "project":
			projects = append(projects, item)
		case "journal":
			journals = append(journals, item)
		case "area":
			areas = append(areas, item)
		case "archive":
			archives = append(archives, item)
		}
	}
	h.hub.mu.RLock()
	comments := []ProtoPkmComment{}
	for _, c := range h.hub.state.PKMComments {
		if c.Page == pg.Slug {
			comments = append(comments, c)
		}
	}
	h.hub.mu.RUnlock()

	writeSuccess(w, map[string]any{
		"page":          pg,
		"transclusions": []any{},
		"backlinks": map[string]any{
			"projects": projects,
			"journals": journals,
			"areas":    areas,
			"archives": archives,
		},
		"comments": comments,
	})
}

func (h *Handler) handlePkmPageSave(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title    string            `json:"title"`
		Tier     string            `json:"tier"`
		Props    map[string]string `json:"props"`
		Markdown string            `json:"markdown"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	tier := pkm.Tier(firstNonEmpty(req.Tier, "inbox"))
	folder := pkm.FolderForTier(tier)
	slug := pkm.SlugOf(req.Title)
	if slug == "" {
		writeError(w, newBizError(BizInvalidInput, "page title is required"), BizInvalidInput)
		return
	}
	relPath := fmt.Sprintf("%s/%s.md", folder, slug)
	content := req.Markdown
	if !strings.HasPrefix(strings.TrimSpace(content), "---") {
		content = fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n%s", req.Title, tier, content)
	}
	note, err := h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{
		RelPath:     relPath,
		Content:     []byte(content),
		UpdatedAtMs: h.hub.nowMs(),
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, h.pkmNoteToPage(note))
}

func (h *Handler) handlePkmPageMove(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Page string `json:"page"`
		Tier string `json:"tier"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	n, ok, err := h.st.PKM.GetNote(r.Context(), req.Page)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	newRel := fmt.Sprintf("%s/%s", pkm.FolderForTier(pkm.Tier(req.Tier)), filepath.Base(n.RelPath))
	raw := fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n%s", firstNonEmpty(n.Title, n.Slug), req.Tier, n.Body)
	if newRel != n.RelPath {
		_ = h.st.PKM.DeleteNote(r.Context(), n.RelPath)
	}
	updated, err := h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{
		RelPath:     newRel,
		Content:     []byte(raw),
		UpdatedAtMs: h.hub.nowMs(),
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, h.pkmNoteToPage(updated))
}

func (h *Handler) handlePkmPageRename(w http.ResponseWriter, r *http.Request) {
	var req struct {
		From string `json:"from"`
		To   string `json:"to"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	n, ok, err := h.st.PKM.GetNote(r.Context(), req.From)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	newSlug := pkm.SlugOf(req.To)
	newRel := fmt.Sprintf("%s/%s.md", pkm.FolderForTier(n.Tier), newSlug)
	raw := fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n%s", req.To, n.Tier, n.Body)
	_ = h.st.PKM.DeleteNote(r.Context(), n.RelPath)
	_, err = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{
		RelPath:     newRel,
		Content:     []byte(raw),
		UpdatedAtMs: h.hub.nowMs(),
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, map[string]any{
		"pages": []string{newSlug},
		"into":  newSlug,
	})
}

func (h *Handler) handlePkmPageExport(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Page string `json:"page"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	n, ok, err := h.st.PKM.GetNote(r.Context(), req.Page)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	writeSuccess(w, map[string]string{"markdown": n.Body})
}

func (h *Handler) handlePkmBlockApply(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Page string            `json:"page"`
		Ops  []json.RawMessage `json:"ops"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	n, ok, err := h.st.PKM.GetNote(r.Context(), req.Page)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	prevRaw := fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n%s", n.Title, n.Tier, n.Body)
	blocks := parsePkmOutline(n.Slug, n.Body)
	for _, rawOp := range req.Ops {
		var op struct {
			Op     string `json:"op"`
			Block  string `json:"block"`
			ID     string `json:"id"`
			Body   string `json:"body"`
			Marker string `json:"marker"`
			Depth  int    `json:"depth"`
		}
		if json.Unmarshal(rawOp, &op) != nil {
			continue
		}
		switch op.Op {
		case "append":
			blocks = append(blocks, protoPkmBlock{
				ID:     firstNonEmpty(op.ID, fmt.Sprintf("%s-b%d", n.Slug, len(blocks)+1)),
				Marker: op.Marker,
				Body:   op.Body,
				Props:  map[string]string{},
				Path:   op.Body,
			})
		case "update":
			for i := range blocks {
				if blocks[i].ID == op.Block {
					blocks[i].Body = op.Body
					blocks[i].Path = op.Body
				}
			}
		case "set_marker":
			for i := range blocks {
				if blocks[i].ID == op.Block {
					blocks[i].Marker = op.Marker
				}
			}
		case "toggle_marker":
			for i := range blocks {
				if blocks[i].ID == op.Block {
					switch blocks[i].Marker {
					case "":
						blocks[i].Marker = "TODO"
					case "TODO":
						blocks[i].Marker = "DOING"
					case "DOING":
						blocks[i].Marker = "DONE"
					case "DONE":
						blocks[i].Marker = "TODO"
					case "LATER":
						blocks[i].Marker = "NOW"
					case "NOW":
						blocks[i].Marker = "DONE"
					}
				}
			}
		case "delete":
			filtered := blocks[:0]
			for _, b := range blocks {
				if b.ID != op.Block {
					filtered = append(filtered, b)
				}
			}
			blocks = filtered
		case "indent":
			for i := range blocks {
				if blocks[i].ID == op.Block {
					blocks[i].Depth++
				}
			}
		case "outdent":
			for i := range blocks {
				if blocks[i].ID == op.Block && blocks[i].Depth > 0 {
					blocks[i].Depth--
				}
			}
		}
	}
	nextBody := renderPkmOutline(blocks)
	raw := fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n%s", firstNonEmpty(n.Title, n.Slug), n.Tier, nextBody)
	h.hub.mu.Lock()
	h.hub.state.PKMUndo = &pkmUndoRecord{Page: n.Slug, RelPath: n.RelPath, Markdown: prevRaw, What: "block.apply", Existed: true}
	h.hub.mu.Unlock()
	updated, err := h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{
		RelPath:     n.RelPath,
		Content:     []byte(raw),
		UpdatedAtMs: h.hub.nowMs(),
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	_ = h.hub.persist()
	writeSuccess(w, h.pkmNoteToPage(updated))
}

func (h *Handler) handlePkmSearch(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text     string `json:"text"`
		Tier     string `json:"tier"`
		Marker   string `json:"marker"`
		LinkedTo string `json:"linkedTo"`
		Limit    int    `json:"limit"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	hits, err := h.st.PKM.Search(r.Context(), pkm.SearchQuery{
		Text:     req.Text,
		Tier:     pkm.Tier(req.Tier),
		LinkedTo: req.LinkedTo,
		Limit:    req.Limit,
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	out := make([]map[string]any, 0, len(hits))
	for _, hit := range hits {
		tier := string(hit.Tier)
		if !validPkmTiers[tier] {
			tier = "inbox"
		}
		out = append(out, map[string]any{
			"block":     hit.Slug + "-b1",
			"page":      hit.Slug,
			"pageTitle": firstNonEmpty(hit.Title, hit.Slug),
			"tier":      tier,
			"path":      hit.RelPath,
			"body":      firstNonEmpty(hit.Snippet, hit.Title),
			"plain":     firstNonEmpty(hit.Snippet, hit.Title),
			"score":     hit.Score,
			"children":  []any{},
		})
	}
	writeSuccess(w, out)
}

func (h *Handler) handlePkmCapture(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Text string `json:"text"`
		Page string `json:"page"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	target := strings.TrimSpace(req.Page)
	var note pkm.Note
	var err error
	if target == "" {
		day := time.Now().Format("2006-01-02")
		relPath := fmt.Sprintf("journals/%s.md", day)
		prev := ""
		if cur, ok, _ := h.st.PKM.GetNote(r.Context(), relPath); ok {
			prev = cur.Body
		}
		if prev != "" && !strings.HasSuffix(prev, "\n") {
			prev += "\n"
		}
		raw := fmt.Sprintf("---\ntitle: %s\ntier: journal\n---\n%s- LATER #inbox %s\n", day, prev, req.Text)
		note, err = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: relPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
	} else {
		cur, ok, _ := h.st.PKM.GetNote(r.Context(), target)
		if !ok {
			slug := pkm.SlugOf(target)
			relPath := fmt.Sprintf("00_Inbox/%s.md", slug)
			raw := fmt.Sprintf("---\ntitle: %s\ntier: inbox\n---\n- %s\n", target, req.Text)
			note, err = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: relPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
		} else {
			prev := cur.Body
			if prev != "" && !strings.HasSuffix(prev, "\n") {
				prev += "\n"
			}
			raw := fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n%s- %s\n", firstNonEmpty(cur.Title, cur.Slug), cur.Tier, prev, req.Text)
			note, err = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: cur.RelPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
		}
	}
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, h.pkmNoteToPage(note))
}

func (h *Handler) handlePkmSourceGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Page string `json:"page"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	n, ok, err := h.st.PKM.GetNote(r.Context(), req.Page)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"page":     n.Slug,
		"title":    firstNonEmpty(n.Title, n.Slug),
		"markdown": n.Body,
		"updated":  n.UpdatedAtMs,
	})
}

func (h *Handler) handlePkmSourceUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Page     string `json:"page"`
		Markdown string `json:"markdown"`
		Updated  int64  `json:"updated"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	n, ok, err := h.st.PKM.GetNote(r.Context(), req.Page)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	if req.Updated > 0 && n.UpdatedAtMs > req.Updated {
		writeError(w, newBizError(BizPkmRefused, "page was modified externally"), BizPkmRefused)
		return
	}
	raw := req.Markdown
	if !strings.HasPrefix(strings.TrimSpace(raw), "---") {
		raw = fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n%s", firstNonEmpty(n.Title, n.Slug), n.Tier, req.Markdown)
	}
	updated, err := h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{
		RelPath:     n.RelPath,
		Content:     []byte(raw),
		UpdatedAtMs: h.hub.nowMs(),
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, h.pkmNoteToPage(updated))
}

func (h *Handler) handlePkmJournalOpen(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Day string `json:"day"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	relPath := fmt.Sprintf("journals/%s.md", req.Day)
	if n, ok, err := h.st.PKM.GetNote(r.Context(), relPath); err == nil && ok {
		writeSuccess(w, h.pkmNoteToPage(n))
		return
	}
	raw := fmt.Sprintf("---\ntitle: %s\ntier: journal\n---\n", req.Day)
	note, err := h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{
		RelPath:     relPath,
		Content:     []byte(raw),
		UpdatedAtMs: h.hub.nowMs(),
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, h.pkmNoteToPage(note))
}

func (h *Handler) handlePkmRadarGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		StaleDays *int `json:"staleDays"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	notes, _ := h.loadAllPkmNotes(r.Context())
	inboxCount := 0
	for _, n := range notes {
		if n.Tier == pkm.TierInbox {
			inboxCount++
		}
	}
	writeSuccess(w, map[string]any{
		"inbox":   inboxCount,
		"stale":   []any{},
		"overdue": []any{},
	})
}

func (h *Handler) handlePkmCommentList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Page string `json:"page"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.RLock()
	out := []ProtoPkmComment{}
	for _, c := range h.hub.state.PKMComments {
		if req.Page == "" || c.Page == req.Page {
			out = append(out, c)
		}
	}
	h.hub.mu.RUnlock()
	writeSuccess(w, out)
}

func (h *Handler) handlePkmCommentSuggest(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Block     string `json:"block"`
		Suggested string `json:"suggested"`
		Rationale string `json:"rationale"`
		Comment   string `json:"comment"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	pageSlug := strings.Split(req.Block, "-b")[0]
	c := ProtoPkmComment{
		ID:        randomID("pkmc"),
		Page:      firstNonEmpty(pageSlug, "inbox"),
		Block:     req.Block,
		By:        "user",
		Body:      firstNonEmpty(req.Comment, "Suggested rewrite"),
		Status:    "suggested",
		Suggested: req.Suggested,
		Rationale: req.Rationale,
		Created:   h.hub.nowMs(),
	}
	h.hub.mu.Lock()
	h.hub.state.PKMComments = append(h.hub.state.PKMComments, c)
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, map[string]any{
		"comment":  c,
		"kept":     []string{},
		"restored": []string{},
	})
}

func (h *Handler) handlePkmCommentResolve(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID     string `json:"id"`
		Accept bool   `json:"accept"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.Lock()
	var target *ProtoPkmComment
	for i := range h.hub.state.PKMComments {
		if h.hub.state.PKMComments[i].ID == req.ID {
			now := h.hub.nowMs()
			if req.Accept {
				h.hub.state.PKMComments[i].Status = "accepted"
			} else {
				h.hub.state.PKMComments[i].Status = "rejected"
			}
			h.hub.state.PKMComments[i].Resolved = &now
			cp := h.hub.state.PKMComments[i]
			target = &cp
			break
		}
	}
	h.hub.mu.Unlock()
	if target == nil {
		writeError(w, newBizError(BizPkmNotFound, "comment not found"), BizPkmNotFound)
		return
	}
	_ = h.hub.persist()
	if n, ok, _ := h.st.PKM.GetNote(r.Context(), target.Page); ok {
		writeSuccess(w, h.pkmNoteToPage(n))
		return
	}
	writeSuccess(w, protoPkmPage{
		Slug:   target.Page,
		Title:  target.Page,
		Tier:   "inbox",
		File:   target.Page + ".md",
		Props:  map[string]string{},
		Blocks: []protoPkmBlock{},
	})
}

func (h *Handler) handlePkmClipCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		URL     string `json:"url"`
		Title   string `json:"title"`
		Content string `json:"content"`
		Author  string `json:"author"`
		TLDR    string `json:"tldr"`
		Tier    string `json:"tier"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.RLock()
	existingPage, dup := h.hub.state.PKMClips[req.URL]
	h.hub.mu.RUnlock()
	if dup {
		writeSuccess(w, map[string]any{
			"duplicate": true,
			"page":      existingPage,
			"snapshot":  existingPage,
		})
		return
	}
	tier := pkm.Tier(firstNonEmpty(req.Tier, "resource"))
	slug := pkm.SlugOf(firstNonEmpty(req.Title, req.URL))
	relPath := fmt.Sprintf("%s/%s.md", pkm.FolderForTier(tier), slug)
	raw := fmt.Sprintf("---\ntitle: %s\ntier: %s\n---\n- %s\n", req.Title, tier, req.Content)
	_, err := h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: relPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	h.hub.mu.Lock()
	h.hub.state.PKMClips[req.URL] = slug
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, map[string]any{
		"duplicate": false,
		"page":      slug,
		"snapshot":  slug,
	})
}

func (h *Handler) handlePkmClusterCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Topic string `json:"topic"`
		Title string `json:"title"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	slug := pkm.SlugOf(req.Title)
	relPath := fmt.Sprintf("%s/%s.md", pkm.FolderForTier(pkm.TierResource), slug)
	raw := fmt.Sprintf("---\ntitle: %s\ntier: resource\n---\n- Cluster for [[%s]]\n", req.Title, req.Topic)
	_, err := h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: relPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, map[string]any{
		"page":   slug,
		"blocks": []string{},
	})
}

func (h *Handler) handlePkmUndo(w http.ResponseWriter, r *http.Request) {
	h.hub.mu.Lock()
	rec := h.hub.state.PKMUndo
	h.hub.state.PKMUndo = nil
	h.hub.mu.Unlock()
	if rec == nil {
		writeSuccess(w, map[string]any{"undone": false})
		return
	}
	if rec.Existed {
		_, _ = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: rec.RelPath, Content: []byte(rec.Markdown), UpdatedAtMs: h.hub.nowMs()})
	}
	_ = h.hub.persist()
	writeSuccess(w, map[string]any{
		"undone": true,
		"page":   rec.Page,
		"what":   rec.What,
	})
}

func (h *Handler) handlePkmScan(w http.ResponseWriter, r *http.Request) {
	dir := defaultPKMDir(h.st)
	if dir == "" {
		writeSuccess(w, map[string]int{"scanned": 0, "updated": 0, "removed": 0})
		return
	}
	if _, err := os.Stat(dir); err != nil {
		writeSuccess(w, map[string]int{"scanned": 0, "updated": 0, "removed": 0})
		return
	}
	stats, err := h.st.PKM.SyncDir(r.Context(), dir, nil)
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	writeSuccess(w, map[string]int{
		"scanned": stats.Indexed + stats.Unchanged,
		"updated": stats.Indexed,
		"removed": stats.Deleted,
	})
}
