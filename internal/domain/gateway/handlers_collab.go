package gateway

import (
	"context"
	"crypto/rand"
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
	"unicode"
	"unicode/utf8"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
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
		h.hub.mu.RLock()
		meta := h.hub.state.Channels[ch.ID]
		del := meta != nil && meta.Deleted
		metaName := ""
		if meta != nil {
			metaName = meta.Name
		}
		h.hub.mu.RUnlock()
		if del {
			return channel.Channel{}, channel.ErrNotFound
		}
		if ch.ID == target || strings.EqualFold(ch.Name, target) || (metaName != "" && strings.EqualFold(metaName, target)) {
			return ch, nil
		}
	}
	return channel.Channel{}, channel.ErrNotFound
}

func isValidChannelName(name string) bool {
	count := utf8.RuneCountInString(name)
	if count < 1 || count > 24 {
		return false
	}
	for _, r := range name {
		if !unicode.IsLetter(r) && !unicode.IsDigit(r) && r != '_' && r != '-' {
			return false
		}
	}
	return true
}

func newUUIDv4() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

func (h *Handler) channelNameTaken(ctx context.Context, name, excludeID string) bool {
	if h.st == nil || h.st.Channels == nil {
		return false
	}
	all, err := h.st.Channels.ListChannels(ctx)
	if err != nil {
		return false
	}
	for _, ch := range all {
		if ch.ID == excludeID || ch.Type != channel.TypePublic {
			continue
		}
		h.hub.mu.RLock()
		meta := h.hub.state.Channels[ch.ID]
		del := meta != nil && meta.Deleted
		metaName := ""
		if meta != nil {
			metaName = meta.Name
		}
		h.hub.mu.RUnlock()
		if del {
			continue
		}
		curName := firstNonEmpty(metaName, ch.Name)
		if curName == name {
			return true
		}
	}
	return false
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
	sortProtoChannels(out)
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
	name := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(req.Name), "#"))
	if !isValidChannelName(name) {
		writeError(w, newBizError(BizChannelRefused, "channel name must be 1-24 letters, numbers, _ or - without spaces"), BizChannelRefused)
		return
	}
	if h.channelNameTaken(r.Context(), name, "") {
		writeError(w, newBizError(BizChannelRefused, fmt.Sprintf("channel #%s already exists", name)), BizChannelRefused)
		return
	}
	id := newUUIDv4()
	ch, err := h.st.Channels.CreateChannel(r.Context(), channel.Channel{
		ID:             id,
		Type:           channel.TypePublic,
		Name:           name,
		Topic:          req.Description,
		RepoID:         req.Repo,
		DefaultAgentID: "orchestrator",
	})
	if err != nil {
		writeError(w, err, BizChannelRefused)
		return
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(ch.ID)
	meta.Name = name
	meta.Title = name
	meta.Description = req.Description
	meta.HasDesc = true
	meta.Repo = req.Repo
	meta.HasMembers = true
	meta.Members = []string{"orchestrator"}
	meta.Orchestrator = "orchestrator"
	meta.LastAt = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())
	h.hub.notifyAllState()

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
	if ch.Type == channel.TypeDirect {
		writeError(w, newBizError(BizChannelNotFound, "cannot update direct channel"), BizChannelNotFound)
		return
	}
	if ch.Type == channel.TypeThread {
		if req.Description != nil || req.Repo != nil || req.Category != nil || req.Before != nil || req.Members != nil {
			writeError(w, newBizError(BizChannelRefused, "threads can only be renamed"), BizChannelRefused)
			return
		}
		h.hub.mu.Lock()
		meta := h.hub.ensureChannelMetaLocked(ch.ID)
		if req.Name != nil {
			meta.Title = strings.TrimSpace(*req.Name)
		}
		meta.LastAt = h.hub.nowMs()
		h.hub.mu.Unlock()
		_ = h.hub.persist()
		h.hub.notifyAllState()
		dto := h.hub.buildChannelDTO(r.Context(), ch)
		h.hub.emitServerEvent(map[string]any{
			"type":    "channelChanged",
			"at":      h.hub.nowMs(),
			"channel": dto,
		})
		writeVoid(w)
		return
	}

	var cleanName *string
	if req.Name != nil {
		c := strings.TrimSpace(strings.TrimPrefix(strings.TrimSpace(*req.Name), "#"))
		if !isValidChannelName(c) {
			writeError(w, newBizError(BizChannelRefused, "channel name must be 1-24 letters, numbers, _ or - without spaces"), BizChannelRefused)
			return
		}
		if h.channelNameTaken(r.Context(), c, ch.ID) {
			writeError(w, newBizError(BizChannelRefused, fmt.Sprintf("channel #%s already exists", c)), BizChannelRefused)
			return
		}
		cleanName = &c
	}

	var wantedMembers []string
	if req.Members != nil {
		seenM := make(map[string]bool)
		wantedMembers = make([]string, 0, len(req.Members))
		for _, m := range req.Members {
			trimmed := strings.TrimSpace(m)
			if trimmed == "" || seenM[trimmed] {
				continue
			}
			if h.st != nil && h.st.Agents != nil {
				prof, pErr := h.st.Agents.GetProfile(r.Context(), trimmed)
				if pErr != nil || prof.Role != agent.RoleOrchestrator {
					writeError(w, newBizError(BizChannelRefused, fmt.Sprintf("%s is not an orchestrator", trimmed)), BizChannelRefused)
					return
				}
			}
			seenM[trimmed] = true
			wantedMembers = append(wantedMembers, trimmed)
		}
	}

	var reorderedIDs []string
	if req.Before != nil {
		allChs, _ := h.st.Channels.ListChannels(r.Context())
		dtos := make([]ProtoChannel, 0, len(allChs))
		for _, item := range allChs {
			dto := h.hub.buildChannelDTO(r.Context(), item)
			if dto.ID == "" || dto.Type != "channel" || dto.Default {
				continue
			}
			dtos = append(dtos, dto)
		}
		sortProtoChannels(dtos)
		rest := make([]string, 0, len(dtos))
		for _, d := range dtos {
			if d.ID != ch.ID {
				rest = append(rest, d.ID)
			}
		}
		target := strings.TrimSpace(*req.Before)
		insertAt := len(rest)
		if target != "" {
			if idx := slices.Index(rest, target); idx >= 0 {
				insertAt = idx
			}
		}
		reorderedIDs = make([]string, 0, len(rest)+1)
		reorderedIDs = append(reorderedIDs, rest[:insertAt]...)
		reorderedIDs = append(reorderedIDs, ch.ID)
		reorderedIDs = append(reorderedIDs, rest[insertAt:]...)
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
	if cleanName != nil {
		meta.Name = *cleanName
		meta.Title = *cleanName
	}
	if req.Category != nil {
		meta.Category = *req.Category
	}
	if req.Members != nil {
		meta.HasMembers = true
		meta.Members = wantedMembers
		if len(wantedMembers) > 0 {
			meta.Orchestrator = wantedMembers[0]
		} else {
			meta.Orchestrator = ""
		}
	}
	for idx, cid := range reorderedIDs {
		cm := h.hub.ensureChannelMetaLocked(cid)
		pos := idx
		cm.Position = &pos
	}
	meta.LastAt = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())
	h.hub.notifyAllState()

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
		ID          string             `json:"id"`
		Text        string             `json:"text"`
		ReplyTo     *int64             `json:"replyTo"`
		Attachments []string           `json:"attachments"`
		Blocks      []ProtoQuotedBlock `json:"blocks"`
		Station     *int               `json:"station"`
		Agent       string             `json:"agent"`
		Repo        string             `json:"repo"`
		SendKey     string             `json:"sendKey"`
		To          string             `json:"to"`
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
	if len(req.Blocks) > 0 {
		meta.QuotedBlocks[msgID] = append([]ProtoQuotedBlock{}, req.Blocks...)
	}
	if req.ReplyTo != nil && *req.ReplyTo > 0 {
		meta.ReplyTo[msgID] = *req.ReplyTo
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(r.Context())

	msg := h.hub.buildChatMessage(res.Event)
	h.hub.emitChannelMessage(ch.ID, msg.Revision, msg)
	if !res.Deduplicated {
		h.triggerChannelAutoReply(r.Context(), ch, res.Event, req.To, mentions)
	}
	writeVoid(w)
}

func (h *Handler) triggerChannelAutoReply(ctx context.Context, ch channel.Channel, ev channel.Event, explicitTo string, mentions []string) {
	if h.st == nil || h.st.Agents == nil {
		return
	}
	isOrch := func(id string) bool {
		if id == "" {
			return false
		}
		prof, err := h.st.Agents.GetProfile(ctx, id)
		return err == nil && prof.Role == agent.RoleOrchestrator
	}
	if ch.Type == channel.TypeDirect {
		peer := firstNonEmpty(ch.PeerID, ch.DefaultAgentID)
		prof, err := h.st.Agents.GetProfile(ctx, peer)
		if err != nil {
			return
		}
		if prof.Role == agent.RoleOrchestrator {
			h.handleOrchestratorTurnOrNoKey(ctx, ch, prof.ID, ev)
			return
		}
		if os.Getenv("VIBEVALLEY_TEST_RUNTIMES") == "1" && prof.Runtime == "pi" {
			sessID := "dm-" + ch.ID
			nowMs := h.hub.nowMs()
			h.hub.mu.Lock()
			sess, ok := h.hub.state.Sessions[sessID]
			if !ok || sess == nil {
				sess = &ProtoSession{
					ID:      sessID,
					Role:    "worker",
					Name:    firstNonEmpty(prof.Name, prof.ID),
					Agent:   prof.ID,
					Runtime: prof.Runtime,
					HiredAt: nowMs,
					Channel: ch.ID,
					Scope:   &ProtoSessionScope{Kind: "channel", ID: ch.ID},
					Phase:   ProtoPhase{Tag: "resting"},
				}
				h.hub.state.Sessions[sessID] = sess
			}
			sess.Brief = ev.Text
			sess.Runs++
			sess.LastRun = &ProtoLastRun{
				Outcome: "completed",
				Summary: "Answered in " + ch.ID,
				At:      nowMs,
			}
			h.hub.mu.Unlock()

			replyRes, _, aErr := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
				ChannelID: ch.ID,
				Kind:      contract.ChannelEventMessage,
				AuthorID:  prof.ID,
				ActorKind: channel.ActorAgent,
				ActorRole: channel.RoleWorker,
				SessionID: sessID,
				Text:      fmt.Sprintf("Checked %s: %s", ch.ID, ev.Text),
			})
			if aErr == nil {
				h.hub.mu.Lock()
				meta := h.hub.ensureChannelMetaLocked(ch.ID)
				meta.LastAt = replyRes.Event.CreatedAtMs
				h.hub.mu.Unlock()
				_ = h.hub.persist()
				msg := h.hub.buildChatMessage(replyRes.Event)
				h.hub.emitChannelMessage(ch.ID, msg.Revision, msg)
			} else {
				_ = h.hub.persist()
			}
			h.hub.notifyAllState()
		}
		return
	}

	var orchID string
	if isOrch(explicitTo) {
		orchID = explicitTo
	}
	if orchID == "" {
		dto := h.hub.buildChannelDTO(ctx, ch)
		hereOrch := firstNonEmpty(dto.Orchestrator, ch.DefaultAgentID, "orchestrator")
		for _, m := range mentions {
			switch m {
			case "助手", "manager", "orchestrator":
				if isOrch(hereOrch) {
					orchID = hereOrch
				} else if isOrch("orchestrator") {
					orchID = "orchestrator"
				}
			default:
				if isOrch(m) {
					orchID = m
				}
			}
			if orchID != "" {
				break
			}
		}
		if orchID == "" {
			for _, member := range dto.Members {
				if isOrch(member) {
					orchID = member
					break
				}
			}
		}
		if orchID == "" && strings.HasPrefix(strings.TrimSpace(ev.Text), "/imagegen ") && isOrch("orchestrator") {
			orchID = "orchestrator"
		}
	}
	if orchID == "" {
		return
	}
	h.handleOrchestratorTurnOrNoKey(ctx, ch, orchID, ev)
}

func (h *Handler) handleOrchestratorTurnOrNoKey(ctx context.Context, ch channel.Channel, orchID string, ev channel.Event) {
	if h.st == nil {
		return
	}
	hasKey := false
	if h.st.Setting != nil {
		if key, _, ok := h.st.Setting.ResolveAPIKey("deepseek"); ok && strings.TrimSpace(key) != "" {
			hasKey = true
		}
	}
	if !hasKey && strings.TrimSpace(os.Getenv("DEEPSEEK_API_KEY")) != "" {
		hasKey = true
	}
	if hasKey {
		return
	}

	noKeyText := "我还没有 DeepSeek 的钥匙，想不了事。到首页的「设置」里填上 DeepSeek 的 API Key（工作台左栏最下面的「设置」也能去），填好再跟我说一遍。"
	if h.currentLocale() == "en" {
		noKeyText = "I do not have a DeepSeek API key yet, so I cannot think right now. Add your DeepSeek API key in Settings and ask me again."
	}

	nowMs := h.hub.nowMs()
	runID := randomID("run")
	okFalse := false

	h.hub.mu.Lock()
	evs := h.hub.state.SessionEvents[orchID]
	nextSeq := int64(len(evs) + 1)
	if len(evs) > 0 && evs[len(evs)-1].Seq >= nextSeq {
		nextSeq = evs[len(evs)-1].Seq + 1
	}
	addedEvents := []ProtoSessionEvent{
		{Seq: nextSeq, Revision: 1, Time: nowMs, Type: "run/start", Run: runID, Text: ""},
		{Seq: nextSeq + 1, Revision: 1, Time: nowMs, Type: "user/message", Run: runID, Text: ev.Text},
		{Seq: nextSeq + 2, Revision: 1, Time: nowMs, Type: "run/error", Run: runID, Text: noKeyText, Ok: &okFalse},
		{Seq: nextSeq + 3, Revision: 1, Time: nowMs, Type: "run/end", Run: runID, Ok: &okFalse},
	}
	h.hub.state.SessionEvents[orchID] = append(evs, addedEvents...)
	h.hub.state.FailedRuns[runID] = true

	sentKey := orchID + "|" + ch.ID
	shouldPost := !h.hub.state.OrchNoKeySent[sentKey]
	if shouldPost {
		h.hub.state.OrchNoKeySent[sentKey] = true
	}
	h.hub.mu.Unlock()

	for _, se := range addedEvents {
		h.hub.emitLiveEvent(map[string]any{
			"type":     "event",
			"at":       se.Time,
			"id":       orchID,
			"activity": se,
		})
	}

	if shouldPost {
		replyRes, _, err := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
			ChannelID: ch.ID,
			Kind:      contract.ChannelEventMessage,
			AuthorID:  orchID,
			ActorKind: channel.ActorAgent,
			ActorRole: channel.RoleOrchestrator,
			SessionID: orchID,
			Text:      noKeyText,
		})
		if err == nil {
			h.hub.mu.Lock()
			meta := h.hub.ensureChannelMetaLocked(ch.ID)
			meta.LastAt = replyRes.Event.CreatedAtMs
			h.hub.mu.Unlock()
			msg := h.hub.buildChatMessage(replyRes.Event)
			h.hub.emitChannelMessage(ch.ID, msg.Revision, msg)
		}
	}
	_ = h.hub.persist()
	h.hub.notifyAllState()
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
	rev := h.hub.allocMsgRevLocked(ev.Seq)
	meta.Revisions[req.ID] = rev
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
	meta.Revisions[req.ID] = h.hub.allocMsgRevLocked(ev.Seq)
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

var searchFilterRe = regexp.MustCompile(`(?i)(?:^|\s)(from|in|has|before|after):(\S+)`)

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
	inFilter := strings.TrimSpace(req.Channel)
	fromFilter := ""
	hasFilter := ""
	raw := strings.TrimSpace(req.Text)
	cleaned := searchFilterRe.ReplaceAllStringFunc(raw, func(tok string) string {
		trimmed := strings.TrimSpace(tok)
		k, v, ok := strings.Cut(trimmed, ":")
		if !ok {
			return tok
		}
		switch strings.ToLower(k) {
		case "in":
			inFilter = strings.TrimPrefix(v, "#")
		case "from":
			fromFilter = strings.TrimPrefix(v, "@")
		case "has":
			hasFilter = strings.ToLower(v)
		default:
			return tok
		}
		return " "
	})
	q := strings.ToLower(strings.Join(strings.Fields(cleaned), " "))
	hits := []map[string]any{}
	for _, ch := range chs {
		dto := h.hub.buildChannelDTO(r.Context(), ch)
		if dto.ID == "" {
			continue
		}
		chName := firstNonEmpty(dto.Name, ch.Name, ch.ID)
		if inFilter != "" {
			inLow := strings.ToLower(inFilter)
			if strings.ToLower(ch.ID) != inLow && strings.ToLower(chName) != inLow && strings.ToLower(ch.ParentChannelID) != inLow {
				continue
			}
		}
		events, _ := h.st.Channels.ListEvents(r.Context(), ch.ID, 0, 500)
		for _, ev := range events {
			msg := h.hub.buildChatMessage(ev)
			if msg.Deleted != nil {
				continue
			}
			if fromFilter != "" && !strings.EqualFold(msg.From, fromFilter) {
				continue
			}
			if hasFilter != "" {
				switch hasFilter {
				case "pin":
					if msg.Pinned == nil {
						continue
					}
				case "attachment":
					if len(msg.Attachments) == 0 {
						continue
					}
				}
			}
			if q == "" || strings.Contains(strings.ToLower(msg.Text), q) {
				addr := "#" + chName
				if dto.Type == "direct" {
					addr = "@" + firstNonEmpty(dto.Peer, chName)
				}
				hits = append(hits, map[string]any{
					"message": msg,
					"channel": ch.ID,
					"address": addr,
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
	meta.Revisions[req.ID] = h.hub.allocMsgRevLocked(ev.Seq)
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
	meta.Revisions[req.ID] = h.hub.allocMsgRevLocked(ev.Seq)
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
	meta.HasReadNum = true
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
	meta.HasReadNum = true
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
	ID         string            `json:"id"`
	Parent     string            `json:"parent,omitempty"`
	Depth      int               `json:"depth"`
	Marker     string            `json:"marker,omitempty"`
	Priority   string            `json:"priority,omitempty"`
	Body       string            `json:"body"`
	Props      map[string]string `json:"props"`
	Path       string            `json:"path"`
	ExplicitID bool              `json:"-"`
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

func (h *Handler) pkmNoteToPage(n pkm.Note) protoPkmPage {
	pageProps, blocks := parsePkmOutlineAndProps(n.Slug, n.Body)
	props := extractNoteProps(n, pageProps)
	tier := string(n.Tier)
	if !validPkmTiers[tier] {
		tier = "inbox"
	}
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
		if day := journalDayFromPathOrSlug(pg.File, pg.Slug); day != "" {
			summary["day"] = day
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
	n, ok, err := h.resolvePkmNote(r.Context(), req.Page)
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	if !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	pg := h.pkmNoteToPage(n)
	allNotes, _ := h.loadAllPkmNotes(r.Context())

	projects := []map[string]any{}
	journals := []map[string]any{}
	areas := []map[string]any{}
	archives := []map[string]any{}

	type blockEntry struct {
		page  protoPkmPage
		block protoPkmBlock
	}
	blockIndex := map[string]blockEntry{}
	var backlinkBodies []string
	targets := map[string]bool{
		strings.ToLower(pg.Slug):  true,
		strings.ToLower(pg.Title): true,
	}
	for _, al := range n.Frontmatter.Aliases {
		if strings.TrimSpace(al) != "" {
			targets[strings.ToLower(strings.TrimSpace(al))] = true
		}
	}
	ownBlockIDs := map[string]bool{}
	for _, b := range pg.Blocks {
		ownBlockIDs[b.ID] = true
	}

	for _, other := range allNotes {
		otherPg := h.pkmNoteToPage(other)
		for _, b := range otherPg.Blocks {
			blockIndex[b.ID] = blockEntry{page: otherPg, block: b}
		}
		if other.RelPath == n.RelPath {
			continue
		}
		for _, b := range otherPg.Blocks {
			matched := false
			for _, m := range pkmWikiLinkRe.FindAllStringSubmatch(b.Body, -1) {
				if len(m) == 2 {
					rawTarget := strings.SplitN(m[1], "|", 2)[0]
					if targets[strings.ToLower(strings.TrimSpace(rawTarget))] || targets[strings.ToLower(pkm.SlugOf(rawTarget))] {
						matched = true
						break
					}
				}
			}
			if !matched {
				for _, m := range pkmBlockRefRe.FindAllStringSubmatch(b.Body, -1) {
					if len(m) == 2 && ownBlockIDs[m[1]] {
						matched = true
						break
					}
				}
			}
			if matched {
				backlinkBodies = append(backlinkBodies, b.Body)
				item := map[string]any{
					"block":     b.ID,
					"page":      otherPg.Slug,
					"pageTitle": otherPg.Title,
					"tier":      otherPg.Tier,
					"path":      otherPg.File,
					"body":      b.Body,
				}
				switch otherPg.Tier {
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
		}
	}

	transclusions := []map[string]any{}
	seenRef := map[string]bool{}
	scanRefs := func(text string, selfPageSlug string) {
		for _, m := range pkmBlockRefRe.FindAllStringSubmatch(text, -1) {
			if len(m) != 2 {
				continue
			}
			refID := m[1]
			if seenRef[refID] {
				continue
			}
			seenRef[refID] = true
			entry, found := blockIndex[refID]
			if !found {
				transclusions = append(transclusions, map[string]any{
					"block":    refID,
					"found":    false,
					"circular": false,
					"body":     "missing block " + refID,
				})
				continue
			}
			circular := entry.page.Slug == selfPageSlug && strings.Contains(entry.block.Body, "(("+refID+"))")
			transclusions = append(transclusions, map[string]any{
				"block":     refID,
				"found":     true,
				"circular":  circular,
				"page":      entry.page.Slug,
				"pageTitle": entry.page.Title,
				"body":      entry.block.Body,
			})
		}
	}
	for _, b := range pg.Blocks {
		scanRefs(b.Body, pg.Slug)
	}
	for _, body := range backlinkBodies {
		scanRefs(body, "")
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
		"transclusions": transclusions,
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
		content = formatPkmNoteContent(req.Title, string(tier), req.Props, content)
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
	n, ok, err := h.resolvePkmNote(r.Context(), req.Page)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	pageProps, _ := parsePkmOutlineAndProps(n.Slug, n.Body)
	props := extractNoteProps(n, pageProps)
	newRel := fmt.Sprintf("%s/%s", pkm.FolderForTier(pkm.Tier(req.Tier)), filepath.Base(n.RelPath))
	raw := formatPkmNoteContent(firstNonEmpty(n.Title, n.Slug), req.Tier, props, n.Body)
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
	n, ok, err := h.resolvePkmNote(r.Context(), req.From)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	pageProps, _ := parsePkmOutlineAndProps(n.Slug, n.Body)
	props := extractNoteProps(n, pageProps)
	newSlug := pkm.SlugOf(req.To)
	newRel := fmt.Sprintf("%s/%s.md", pkm.FolderForTier(n.Tier), newSlug)
	raw := formatPkmNoteContent(req.To, string(n.Tier), props, n.Body)
	if newRel != n.RelPath {
		_ = h.st.PKM.DeleteNote(r.Context(), n.RelPath)
	}
	_, err = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{
		RelPath:     newRel,
		Content:     []byte(raw),
		UpdatedAtMs: h.hub.nowMs(),
	})
	if err != nil {
		writeError(w, err, BizPkmRefused)
		return
	}
	oldTitle := firstNonEmpty(n.Title, n.Slug)
	touched := []string{newSlug}
	allNotes, _ := h.loadAllPkmNotes(r.Context())
	for _, other := range allNotes {
		if other.RelPath == n.RelPath || other.RelPath == newRel {
			continue
		}
		if strings.Contains(other.Body, "[["+oldTitle+"]]") || strings.Contains(other.Body, "[["+oldTitle+"|") {
			replaced := strings.ReplaceAll(other.Body, "[["+oldTitle+"]]", "[["+req.To+"]]")
			replaced = strings.ReplaceAll(replaced, "[["+oldTitle+"|", "[["+req.To+"|")
			oPageProps, _ := parsePkmOutlineAndProps(other.Slug, replaced)
			oProps := extractNoteProps(other, oPageProps)
			oRaw := formatPkmNoteContent(firstNonEmpty(other.Title, other.Slug), string(other.Tier), oProps, replaced)
			_, _ = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: other.RelPath, Content: []byte(oRaw), UpdatedAtMs: h.hub.nowMs()})
			touched = append(touched, other.Slug)
		}
	}
	writeSuccess(w, map[string]any{
		"pages": touched,
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
	n, ok, err := h.resolvePkmNote(r.Context(), req.Page)
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
	n, ok, err := h.resolvePkmNote(r.Context(), req.Page)
	if err != nil || !ok {
		writeError(w, newBizError(BizPkmNotFound, "pkm page not found"), BizPkmNotFound)
		return
	}
	pageProps, blocks := parsePkmOutlineAndProps(n.Slug, n.Body)
	props := extractNoteProps(n, pageProps)
	prevRaw := formatPkmNoteContent(firstNonEmpty(n.Title, n.Slug), string(n.Tier), props, n.Body)

	nextBlocks := applyPkmOutlineOps(n.Slug, blocks, req.Ops)
	allNotes, _ := h.loadAllPkmNotes(r.Context())
	refs := collectAllReferencedBlockIDs(allNotes)
	nextBody := renderPkmOutline(nextBlocks, refs)
	raw := formatPkmNoteContent(firstNonEmpty(n.Title, n.Slug), string(n.Tier), props, nextBody)

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
	limit := req.Limit
	if limit <= 0 {
		limit = 50
	}
	queryText := strings.ToLower(strings.TrimSpace(req.Text))
	linkedTo := strings.ToLower(strings.TrimSpace(req.LinkedTo))
	reqMarker := strings.TrimSpace(req.Marker)

	var notes []pkm.Note
	scoreByPath := map[string]float64{}
	if queryText == "" && linkedTo == "" && reqMarker != "" {
		loaded, err := h.loadAllPkmNotes(r.Context())
		if err != nil {
			writeError(w, err, BizPkmRefused)
			return
		}
		notes = loaded
	} else {
		hits, err := h.st.PKM.Search(r.Context(), pkm.SearchQuery{
			Text:     req.Text,
			Tier:     pkm.Tier(req.Tier),
			LinkedTo: req.LinkedTo,
			Limit:    limit,
		})
		if err != nil {
			writeError(w, err, BizPkmRefused)
			return
		}
		for _, hit := range hits {
			scoreByPath[hit.RelPath] = hit.Score
			if n, ok, gErr := h.st.PKM.GetNote(r.Context(), hit.RelPath); gErr == nil && ok {
				notes = append(notes, n)
			}
		}
	}

	out := make([]map[string]any, 0)
	for _, n := range notes {
		pg := h.pkmNoteToPage(n)
		if req.Tier != "" && pg.Tier != req.Tier {
			continue
		}
		score := scoreByPath[n.RelPath]
		if score == 0 {
			score = 1
		}
		matchedAny := false
		for _, b := range pg.Blocks {
			if reqMarker != "" && b.Marker != reqMarker {
				continue
			}
			if queryText != "" {
				tokens := strings.Fields(queryText)
				hay := strings.ToLower(b.Body + " " + pg.Title)
				allMatch := true
				for _, tok := range tokens {
					if !strings.Contains(hay, tok) {
						allMatch = false
						break
					}
				}
				if !allMatch {
					continue
				}
			}
			if linkedTo != "" && !strings.Contains(strings.ToLower(b.Body), linkedTo) {
				continue
			}
			matchedAny = true
			hitMap := map[string]any{
				"block":     b.ID,
				"page":      pg.Slug,
				"pageTitle": pg.Title,
				"tier":      pg.Tier,
				"path":      pg.File,
				"body":      b.Body,
				"plain":     b.Body,
				"score":     score,
				"children":  []any{},
			}
			if b.Marker != "" {
				hitMap["marker"] = b.Marker
			}
			out = append(out, hitMap)
			if len(out) >= limit {
				break
			}
		}
		if !matchedAny && reqMarker == "" && len(pg.Blocks) > 0 && queryText != "" && strings.Contains(strings.ToLower(pg.Title), queryText) {
			b := pg.Blocks[0]
			hitMap := map[string]any{
				"block":     b.ID,
				"page":      pg.Slug,
				"pageTitle": pg.Title,
				"tier":      pg.Tier,
				"path":      pg.File,
				"body":      b.Body,
				"plain":     b.Body,
				"score":     score,
				"children":  []any{},
			}
			if b.Marker != "" {
				hitMap["marker"] = b.Marker
			}
			out = append(out, hitMap)
		}
		if len(out) >= limit {
			break
		}
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
		slugDay := journalSlugFromDay(day)
		relPath := fmt.Sprintf("journals/%s.md", slugDay)
		prev := ""
		var props map[string]string
		if cur, ok, _ := h.st.PKM.GetNote(r.Context(), relPath); ok {
			prev = cur.Body
			pp, _ := parsePkmOutlineAndProps(cur.Slug, cur.Body)
			props = extractNoteProps(cur, pp)
		}
		if prev != "" && !strings.HasSuffix(prev, "\n") {
			prev += "\n"
		}
		raw := formatPkmNoteContent(slugDay, "journal", props, prev+"- LATER #inbox "+req.Text+"\n")
		note, err = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: relPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
	} else {
		cur, ok, _ := h.resolvePkmNote(r.Context(), target)
		if !ok {
			slug := pkm.SlugOf(target)
			relPath := fmt.Sprintf("00_Inbox/%s.md", slug)
			raw := formatPkmNoteContent(target, "inbox", nil, "- "+req.Text+"\n")
			note, err = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: relPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
		} else {
			prev := cur.Body
			if prev != "" && !strings.HasSuffix(prev, "\n") {
				prev += "\n"
			}
			pp, _ := parsePkmOutlineAndProps(cur.Slug, cur.Body)
			props := extractNoteProps(cur, pp)
			raw := formatPkmNoteContent(firstNonEmpty(cur.Title, cur.Slug), string(cur.Tier), props, prev+"- "+req.Text+"\n")
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
	n, ok, err := h.resolvePkmNote(r.Context(), req.Page)
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
	n, ok, err := h.resolvePkmNote(r.Context(), req.Page)
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
		pp, _ := parsePkmOutlineAndProps(n.Slug, n.Body)
		props := extractNoteProps(n, pp)
		raw = formatPkmNoteContent(firstNonEmpty(n.Title, n.Slug), string(n.Tier), props, req.Markdown)
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
	day := strings.TrimSpace(req.Day)
	slugDay := journalSlugFromDay(day)
	relPath := fmt.Sprintf("journals/%s.md", slugDay)
	if n, ok, err := h.resolvePkmNote(r.Context(), relPath); err == nil && ok {
		writeSuccess(w, h.pkmNoteToPage(n))
		return
	}
	raw := formatPkmNoteContent(slugDay, "journal", nil, "- \n")
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
	staleDays := 7
	if req.StaleDays != nil && *req.StaleDays > 0 {
		staleDays = *req.StaleDays
	}
	today := time.Now().Format("2006-01-02")
	nowMs := h.hub.nowMs()
	notes, _ := h.loadAllPkmNotes(r.Context())
	inboxCount := 0
	stale := []map[string]any{}
	overdue := []map[string]any{}
	for _, n := range notes {
		pg := h.pkmNoteToPage(n)
		if pg.Tier == "inbox" {
			inboxCount++
		}
		var todo, doing, done int
		for _, b := range pg.Blocks {
			switch b.Marker {
			case "TODO", "LATER":
				todo++
			case "DOING", "NOW", "WAITING":
				doing++
			case "DONE":
				done++
			}
			dl := b.Props["deadline"]
			if dl != "" && dl < today && b.Marker != "DONE" && b.Marker != "CANCELED" {
				overdue = append(overdue, map[string]any{
					"block":    b.ID,
					"page":     pg.Slug,
					"body":     b.Body,
					"plain":    b.Body,
					"deadline": dl,
				})
			}
		}
		if pg.Tier == "project" && (todo > 0 || doing > 0) && pg.Updated > 0 {
			ageDays := int((nowMs - pg.Updated) / 86_400_000)
			if ageDays >= staleDays {
				st := map[string]any{
					"slug":  pg.Slug,
					"title": pg.Title,
					"days":  ageDays,
					"todo":  todo,
					"doing": doing,
					"done":  done,
				}
				if dl := pg.Props["deadline"]; dl != "" {
					st["deadline"] = dl
				}
				stale = append(stale, st)
			}
		}
	}
	writeSuccess(w, map[string]any{
		"inbox":   inboxCount,
		"stale":   stale,
		"overdue": overdue,
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
	pageSlug := ""
	notes, _ := h.loadAllPkmNotes(r.Context())
	for _, n := range notes {
		pg := h.pkmNoteToPage(n)
		for _, b := range pg.Blocks {
			if b.ID == req.Block {
				pageSlug = pg.Slug
				break
			}
		}
		if pageSlug != "" {
			break
		}
	}
	if pageSlug == "" {
		pageSlug = firstNonEmpty(strings.Split(req.Block, "-b")[0], "inbox")
	}
	c := ProtoPkmComment{
		ID:        randomID("pkmc"),
		Page:      pageSlug,
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
	if req.Accept && target.Suggested != "" {
		if n, ok, _ := h.resolvePkmNote(r.Context(), target.Page); ok {
			pp, blocks := parsePkmOutlineAndProps(n.Slug, n.Body)
			props := extractNoteProps(n, pp)
			changed := false
			for i := range blocks {
				if blocks[i].ID == target.Block {
					blocks[i].Body = target.Suggested
					blocks[i].Path = target.Suggested
					changed = true
					break
				}
			}
			if changed {
				allNotes, _ := h.loadAllPkmNotes(r.Context())
				refs := collectAllReferencedBlockIDs(allNotes)
				raw := formatPkmNoteContent(firstNonEmpty(n.Title, n.Slug), string(n.Tier), props, renderPkmOutline(blocks, refs))
				_, _ = h.st.PKM.UpsertNote(r.Context(), pkm.NoteInput{RelPath: n.RelPath, Content: []byte(raw), UpdatedAtMs: h.hub.nowMs()})
			}
		}
	}
	_ = h.hub.persist()
	if n, ok, _ := h.resolvePkmNote(r.Context(), target.Page); ok {
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
	raw := formatPkmNoteContent(firstNonEmpty(req.Title, req.URL), string(tier), nil, "- "+req.Content+"\n")
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
	raw := formatPkmNoteContent(req.Title, "resource", nil, fmt.Sprintf("- Cluster for [[%s]]\n", req.Topic))
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
