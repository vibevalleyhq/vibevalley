package gateway

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/artifact"
	"github.com/vibevalleyhq/vibevalley/internal/domain/attachment"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/user"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func protoDisplayOf(d contract.ArtifactDisplayMode) string {
	switch d {
	case contract.ArtifactDisplaySlides:
		return "slides"
	case contract.ArtifactDisplayMotion:
		return "motion"
	default:
		return "page"
	}
}

func contractDisplayOf(d string) contract.ArtifactDisplayMode {
	switch d {
	case "slides":
		return contract.ArtifactDisplaySlides
	case "motion":
		return contract.ArtifactDisplayMotion
	default:
		return contract.ArtifactDisplayPage
	}
}

type protoArtifactVersion struct {
	Version int    `json:"version"`
	Size    int64  `json:"size"`
	Note    string `json:"note"`
	By      string `json:"by"`
	ByName  string `json:"byName"`
	At      int64  `json:"at"`
	Channel string `json:"channel"`
	Number  *int64 `json:"number,omitempty"`
}

type protoArtifact struct {
	ID       string                 `json:"id"`
	Title    string                 `json:"title"`
	Body     string                 `json:"body"`
	Display  string                 `json:"display,omitempty"`
	Channel  string                 `json:"channel,omitempty"`
	Said     *protoArtifactSaid     `json:"said,omitempty"`
	Issue    string                 `json:"issue,omitempty"`
	By       string                 `json:"by"`
	ByName   string                 `json:"byName"`
	Version  int                    `json:"version"`
	Seq      int64                  `json:"seq"`
	Versions []protoArtifactVersion `json:"versions"`
	At       int64                  `json:"at"`
	Updated  int64                  `json:"updated"`
}

type protoArtifactSaid struct {
	Channel string `json:"channel"`
	Number  int64  `json:"number"`
}

type protoBlock struct {
	ID        string              `json:"id"`
	ParentID  string              `json:"parentId,omitempty"`
	OrderKey  string              `json:"orderKey"`
	Type      string              `json:"type"`
	Attrs     artifact.BlockAttrs `json:"attrs"`
	Text      []artifact.TextSpan `json:"text"`
	Artifact  string              `json:"artifactId"`
	Rev       int64               `json:"rev"`
	Deleted   *bool               `json:"deleted,omitempty"`
	UpdatedBy string              `json:"updatedBy"`
	Updated   int64               `json:"updated"`
}

type protoSuggestion struct {
	ID         string                    `json:"id"`
	ArtifactID string                    `json:"artifactId"`
	BlockID    string                    `json:"blockId"`
	Author     string                    `json:"author"`
	BaseRev    int64                     `json:"baseRev"`
	Change     artifact.SuggestionChange `json:"change"`
	Status     string                    `json:"status"`
	CreatedAt  int64                     `json:"createdAt"`
	ResolvedAt *int64                    `json:"resolvedAt,omitempty"`
	ResolvedBy string                    `json:"resolvedBy,omitempty"`
}

func toProtoBlock(b artifact.Block) protoBlock {
	txt := b.Text
	if txt == nil {
		txt = []artifact.TextSpan{}
	}
	var del *bool
	if b.Deleted {
		t := true
		del = &t
	}
	return protoBlock{
		ID:        b.ID,
		ParentID:  b.ParentID,
		OrderKey:  b.OrderKey,
		Type:      string(b.Type),
		Attrs:     b.Attrs,
		Text:      txt,
		Artifact:  b.ArtifactID,
		Rev:       b.Rev,
		Deleted:   del,
		UpdatedBy: firstNonEmpty(b.UpdatedBy, artifact.UserActor),
		Updated:   b.UpdatedAtMs,
	}
}

func toProtoSuggestion(sg artifact.Suggestion) protoSuggestion {
	var resolvedAt *int64
	if sg.ResolvedAtMs > 0 {
		v := sg.ResolvedAtMs
		resolvedAt = &v
	}
	return protoSuggestion{
		ID:         sg.ID,
		ArtifactID: sg.ArtifactID,
		BlockID:    sg.BlockID,
		Author:     sg.Author,
		BaseRev:    sg.BaseRev,
		Change:     sg.Change,
		Status:     string(sg.Status),
		CreatedAt:  sg.CreatedAtMs,
		ResolvedAt: resolvedAt,
		ResolvedBy: sg.ResolvedBy,
	}
}

func (h *Handler) buildProtoArtifact(id string) (protoArtifact, bool) {
	h.hub.mu.RLock()
	ov := h.hub.state.Artifacts[id]
	var ovCp artifactOverlay
	if ov != nil {
		ovCp = *ov
	}
	h.hub.mu.RUnlock()

	if ov != nil && ov.Deleted {
		return protoArtifact{}, false
	}

	if d, err := h.st.Artifacts.Deliverables.Get(context.Background(), id); err == nil {
		title := d.Title
		display := protoDisplayOf(d.Display)
		chID := d.ChannelID
		issID := d.IssueID
		by := "user"
		byName := "owner"
		var said *protoArtifactSaid
		if ov != nil {
			if ovCp.Title != "" {
				title = ovCp.Title
			}
			if ovCp.Display != "" {
				display = ovCp.Display
			}
			chID = firstNonEmpty(ovCp.Channel, chID)
			issID = firstNonEmpty(ovCp.Issue, issID)
			by = firstNonEmpty(ovCp.By, by)
			byName = firstNonEmpty(ovCp.ByName, byName)
			if ovCp.SaidCh != "" && ovCp.SaidNum > 0 {
				said = &protoArtifactSaid{Channel: ovCp.SaidCh, Number: ovCp.SaidNum}
			}
		}
		versions := make([]protoArtifactVersion, 0, len(d.Versions))
		for _, v := range d.Versions {
			note := v.Note
			if ov != nil && ovCp.RawNotes[v.Version] != "" {
				note = ovCp.RawNotes[v.Version]
			}
			var msgNum *int64
			if ov != nil && ovCp.VersionMsgs[v.Version] > 0 {
				n := ovCp.VersionMsgs[v.Version]
				msgNum = &n
			}
			versions = append(versions, protoArtifactVersion{
				Version: v.Version,
				Size:    v.Size,
				Note:    note,
				By:      firstNonEmpty(v.Author, by),
				ByName:  firstNonEmpty(v.Author, byName),
				At:      v.CreatedAtMs,
				Channel: chID,
				Number:  msgNum,
			})
		}
		return protoArtifact{
			ID:       d.ID,
			Title:    title,
			Body:     "html",
			Display:  display,
			Channel:  chID,
			Said:     said,
			Issue:    issID,
			By:       by,
			ByName:   byName,
			Version:  d.LatestVersion,
			Seq:      0,
			Versions: versions,
			At:       d.CreatedAtMs,
			Updated:  maxInt64(d.UpdatedAtMs, ovCp.Updated),
		}, true
	}

	if snap, err := h.st.Artifacts.Pages.Snapshot(context.Background(), id); err == nil {
		title := snap.Title
		chID := ""
		issID := ""
		by := "user"
		byName := "owner"
		at := snap.UpdatedAtMs
		var said *protoArtifactSaid
		if ov != nil {
			title = firstNonEmpty(ovCp.Title, title)
			chID = ovCp.Channel
			issID = ovCp.Issue
			by = firstNonEmpty(ovCp.By, by)
			byName = firstNonEmpty(ovCp.ByName, byName)
			if ovCp.At > 0 {
				at = ovCp.At
			}
			if ovCp.SaidCh != "" && ovCp.SaidNum > 0 {
				said = &protoArtifactSaid{Channel: ovCp.SaidCh, Number: ovCp.SaidNum}
			}
		}
		return protoArtifact{
			ID:       snap.ArtifactID,
			Title:    title,
			Body:     "blocks",
			Channel:  chID,
			Said:     said,
			Issue:    issID,
			By:       by,
			ByName:   byName,
			Version:  0,
			Seq:      snap.Seq,
			Versions: []protoArtifactVersion{},
			At:       at,
			Updated:  snap.UpdatedAtMs,
		}, true
	}

	return protoArtifact{}, false
}

func (h *Handler) handleArtifactList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Channel string `json:"channel"`
		Issue   string `json:"issue"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	seen := map[string]bool{}
	out := []protoArtifact{}
	h.hub.mu.RLock()
	ids := make([]string, 0, len(h.hub.state.Artifacts))
	for id := range h.hub.state.Artifacts {
		ids = append(ids, id)
	}
	h.hub.mu.RUnlock()

	for _, c := range h.st.Artifacts.Deliverables.ListCards(r.Context(), artifact.DeliverableFilter{}) {
		ids = append(ids, c.ID)
	}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		art, ok := h.buildProtoArtifact(id)
		if !ok {
			continue
		}
		if req.Channel != "" && art.Channel != req.Channel {
			continue
		}
		if req.Issue != "" && art.Issue != req.Issue {
			continue
		}
		out = append(out, art)
	}
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].Updated > out[j].Updated
	})
	writeSuccess(w, out)
}

func (h *Handler) handleArtifactGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	art, ok := h.buildProtoArtifact(req.ID)
	if !ok {
		writeError(w, newBizError(BizArtifactNotFound, "artifact not found"), BizArtifactNotFound)
		return
	}
	writeSuccess(w, art)
}

func renderInlineMarkdown(spans []artifact.TextSpan) string {
	var sb strings.Builder
	for _, s := range spans {
		t := s.Text
		if s.Marks.Code {
			t = "`" + t + "`"
		} else {
			if s.Marks.Italic {
				t = "*" + t + "*"
			}
			if s.Marks.Bold {
				t = "**" + t + "**"
			}
			if s.Marks.Strike {
				t = "~~" + t + "~~"
			}
		}
		if s.Marks.Link != "" {
			t = "[" + t + "](" + s.Marks.Link + ")"
		}
		sb.WriteString(t)
	}
	return sb.String()
}

func renderBlocksMarkdown(blocks []artifact.Block) string {
	var lines []string
	for _, b := range blocks {
		if b.Deleted {
			continue
		}
		txt := renderInlineMarkdown(b.Text)
		switch b.Type {
		case artifact.BlockHeading:
			lvl := 2
			if b.Attrs.Level != nil {
				lvl = max(1, min(6, *b.Attrs.Level))
			}
			lines = append(lines, strings.Repeat("#", lvl)+" "+txt)
		case artifact.BlockBulleted:
			lines = append(lines, "- "+txt)
		case artifact.BlockNumbered:
			lines = append(lines, "1. "+txt)
		case artifact.BlockTodo:
			mark := " "
			if b.Attrs.Checked != nil && *b.Attrs.Checked {
				mark = "x"
			}
			lines = append(lines, fmt.Sprintf("- [%s] %s", mark, txt))
		case artifact.BlockQuote:
			lines = append(lines, "> "+txt)
		case artifact.BlockCode:
			lines = append(lines, "```"+b.Attrs.Language+"\n"+artifact.PlainText(b.Text)+"\n```")
		case artifact.BlockDivider:
			lines = append(lines, "---")
		case artifact.BlockImage:
			title := ""
			if b.Attrs.Width != nil && b.Attrs.Height != nil {
				title = fmt.Sprintf(` "%dx%d"`, *b.Attrs.Width, *b.Attrs.Height)
			}
			lines = append(lines, fmt.Sprintf("![%s](%s%s)", b.Attrs.Alt, b.Attrs.Src, title))
		default:
			lines = append(lines, txt)
		}
	}
	return strings.Join(lines, "\n\n")
}

func (h *Handler) handleArtifactContentGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	art, ok := h.buildProtoArtifact(req.ID)
	if !ok {
		writeError(w, newBizError(BizArtifactNotFound, "artifact not found"), BizArtifactNotFound)
		return
	}
	if art.Body == "html" {
		v, data, err := h.st.Artifacts.Deliverables.GetVersion(r.Context(), req.ID, req.Version)
		if err != nil {
			writeError(w, err, BizArtifactNotFound)
			return
		}
		writeSuccess(w, map[string]any{
			"version": v.Version,
			"content": string(data),
		})
		return
	}
	snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"version": snap.Seq,
		"content": renderBlocksMarkdown(snap.Ordered),
	})
}

func (h *Handler) resolveArtifactIssueID(ctx context.Context, raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" || h.st == nil || h.st.Issues == nil {
		return ""
	}
	if iss, err := h.st.Issues.GetIssue(ctx, trimmed); err == nil {
		return iss.ID
	}
	numStr := strings.TrimPrefix(trimmed, "#")
	if num, err := strconv.Atoi(numStr); err == nil && num > 0 {
		issues, _ := h.st.Issues.ListIssues(ctx)
		h.hub.mu.RLock()
		for _, iss := range issues {
			if im := h.hub.state.Issues[iss.ID]; im != nil && im.Number == num {
				h.hub.mu.RUnlock()
				return iss.ID
			}
		}
		h.hub.mu.RUnlock()
	}
	return trimmed
}

func (h *Handler) defaultArtifactChannelID() string {
	h.hub.mu.RLock()
	def := h.hub.state.DefaultChannel
	h.hub.mu.RUnlock()
	return firstNonEmpty(def, defaultChannelID)
}

func (h *Handler) resolveArtifactChannelID(ctx context.Context, raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return h.defaultArtifactChannelID(), nil
	}
	ch, err := h.resolveChannel(ctx, trimmed)
	if err != nil {
		return "", err
	}
	return ch.ID, nil
}

func (h *Handler) announceArtifactCard(ctx context.Context, chID string, card ProtoArtifactCard) (string, int64) {
	if h.st == nil || h.st.Channels == nil {
		return "", 0
	}
	if strings.TrimSpace(chID) == "" {
		chID = h.defaultArtifactChannelID()
	}
	txt := card.Title
	if strings.TrimSpace(card.Note) != "" {
		txt = card.Title + "\n" + card.Note
	}
	res, _, err := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
		ChannelID: chID,
		Kind:      contract.ChannelEventMessage,
		AuthorID:  "user",
		ActorKind: channel.ActorUser,
		Text:      txt,
	})
	if err != nil {
		return "", 0
	}
	msgID := formatMessageID(chID, res.Event.Seq)
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(chID)
	meta.LastAt = res.Event.CreatedAtMs
	meta.ArtifactCards[msgID] = card
	h.hub.mu.Unlock()
	msg := h.hub.buildChatMessage(res.Event)
	h.hub.emitChannelMessage(chID, msg.Revision, msg)
	return chID, res.Event.Seq
}

func (h *Handler) handleArtifactCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Title   string  `json:"title"`
		Kind    string  `json:"kind"`
		Display string  `json:"display"`
		Content *string `json:"content"`
		Note    string  `json:"note"`
		Channel string  `json:"channel"`
		Issue   string  `json:"issue"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	kind := firstNonEmpty(strings.TrimSpace(req.Kind), "markdown")
	if kind != "html" && kind != "markdown" {
		writeError(w, newBizError(BizArtifactRefused, "unsupported artifact kind"), BizArtifactRefused)
		return
	}
	if kind != "html" && strings.TrimSpace(req.Display) != "" {
		writeError(w, newBizError(BizArtifactRefused, "display mode is only valid for html artifacts"), BizArtifactRefused)
		return
	}
	id := randomID("art")
	nowMs := h.hub.nowMs()
	issueID := h.resolveArtifactIssueID(r.Context(), req.Issue)

	if kind == "html" {
		if strings.TrimSpace(req.Title) == "" {
			writeError(w, newBizError(BizArtifactRefused, "title is required"), BizArtifactRefused)
			return
		}
		rawHTML := ""
		if req.Content != nil {
			rawHTML = *req.Content
		}
		if strings.TrimSpace(rawHTML) == "" {
			writeError(w, newBizError(BizArtifactRefused, "html content is required"), BizArtifactRefused)
			return
		}
		chID, chErr := h.resolveArtifactChannelID(r.Context(), req.Channel)
		if chErr != nil {
			writeError(w, chErr, BizChannelNotFound)
			return
		}
		disp := contractDisplayOf(req.Display)
		res, err := h.st.Artifacts.Deliverables.Publish(r.Context(), artifact.PublishRequest{
			ID:        id,
			Title:     strings.TrimSpace(req.Title),
			Display:   disp,
			ChannelID: chID,
			IssueID:   issueID,
			Note:      req.Note,
			Author:    "user",
			RawHTML:   rawHTML,
		})
		if err != nil {
			writeError(w, err, BizArtifactRefused)
			return
		}
		display := firstNonEmpty(req.Display, "page")
		saidCh, saidNum := h.announceArtifactCard(r.Context(), chID, ProtoArtifactCard{
			ID:      res.Deliverable.ID,
			Title:   strings.TrimSpace(req.Title),
			Body:    "html",
			Version: res.Version.Version,
			Note:    strings.TrimSpace(req.Note),
			Display: display,
		})
		h.hub.mu.Lock()
		ov := &artifactOverlay{
			ID:          res.Deliverable.ID,
			Title:       strings.TrimSpace(req.Title),
			Body:        "html",
			Display:     display,
			Channel:     chID,
			SaidCh:      saidCh,
			SaidNum:     saidNum,
			Issue:       issueID,
			By:          "user",
			ByName:      "owner",
			At:          nowMs,
			Updated:     nowMs,
			RawNotes:    map[int]string{},
			VersionMsgs: map[int]int64{},
		}
		if strings.TrimSpace(req.Note) != "" {
			ov.RawNotes[res.Version.Version] = req.Note
		}
		if saidNum > 0 {
			ov.VersionMsgs[res.Version.Version] = saidNum
		}
		h.hub.state.Artifacts[res.Deliverable.ID] = ov
		h.hub.mu.Unlock()
		_ = h.hub.persist()
		h.hub.emitServerEvent(map[string]any{"type": "artifactChanged", "at": h.hub.nowMs(), "id": res.Deliverable.ID})
		h.hub.notifyAllState()
		out, _ := h.buildProtoArtifact(res.Deliverable.ID)
		writeSuccess(w, out)
		return
	}

	title := strings.TrimSpace(req.Title)
	if title == "" {
		if req.Content != nil {
			writeError(w, newBizError(BizArtifactRefused, "title is required"), BizArtifactRefused)
			return
		}
		title = "Untitled"
	}
	chID := ""
	if req.Content != nil {
		var chErr error
		chID, chErr = h.resolveArtifactChannelID(r.Context(), req.Channel)
		if chErr != nil {
			writeError(w, chErr, BizChannelNotFound)
			return
		}
	}
	snap, err := h.st.Artifacts.Pages.CreateDocument(r.Context(), id, title)
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	if req.Content != nil && strings.TrimSpace(*req.Content) != "" {
		ops := markdownToBlockOps(id, *req.Content)
		if len(ops) > 0 {
			_, _ = h.st.Artifacts.Pages.SubmitBatch(r.Context(), id, artifact.UserActor, randomID("batch"), ops)
		}
	}
	var saidCh string
	var saidNum int64
	if req.Content != nil {
		saidCh, saidNum = h.announceArtifactCard(r.Context(), chID, ProtoArtifactCard{
			ID:      snap.ArtifactID,
			Title:   title,
			Body:    "blocks",
			Version: 0,
			Note:    strings.TrimSpace(req.Note),
		})
	}
	h.hub.mu.Lock()
	h.hub.state.Artifacts[snap.ArtifactID] = &artifactOverlay{
		ID:      snap.ArtifactID,
		Title:   title,
		Body:    "blocks",
		Channel: chID,
		SaidCh:  saidCh,
		SaidNum: saidNum,
		Issue:   issueID,
		By:      "user",
		ByName:  "owner",
		At:      nowMs,
		Updated: nowMs,
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.emitServerEvent(map[string]any{"type": "artifactChanged", "at": h.hub.nowMs(), "id": snap.ArtifactID})
	h.hub.notifyAllState()
	out, _ := h.buildProtoArtifact(snap.ArtifactID)
	writeSuccess(w, out)
}

func (h *Handler) handleArtifactVersionCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		Content string `json:"content"`
		Note    string `json:"note"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	cur, err := h.st.Artifacts.Deliverables.Get(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	res, err := h.st.Artifacts.Deliverables.Publish(r.Context(), artifact.PublishRequest{
		ID:        cur.ID,
		Title:     cur.Title,
		Display:   cur.Display,
		ChannelID: cur.ChannelID,
		IssueID:   cur.IssueID,
		Note:      req.Note,
		Author:    "user",
		RawHTML:   req.Content,
	})
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.mu.RLock()
	ov := h.hub.state.Artifacts[cur.ID]
	chID := cur.ChannelID
	title := cur.Title
	display := protoDisplayOf(cur.Display)
	if ov != nil {
		chID = firstNonEmpty(ov.Channel, chID)
		title = firstNonEmpty(ov.Title, title)
		display = firstNonEmpty(ov.Display, display)
	}
	h.hub.mu.RUnlock()
	_, msgNum := h.announceArtifactCard(r.Context(), chID, ProtoArtifactCard{
		ID:      cur.ID,
		Title:   title,
		Body:    "html",
		Version: res.Version.Version,
		Note:    strings.TrimSpace(req.Note),
		Display: display,
	})
	h.hub.mu.Lock()
	ov = h.hub.state.Artifacts[cur.ID]
	if ov == nil {
		ov = &artifactOverlay{ID: cur.ID, Title: title, Body: "html", Display: display, Channel: chID, By: "user", ByName: "owner", At: cur.CreatedAtMs}
		h.hub.state.Artifacts[cur.ID] = ov
	}
	if ov.RawNotes == nil {
		ov.RawNotes = map[int]string{}
	}
	if ov.VersionMsgs == nil {
		ov.VersionMsgs = map[int]int64{}
	}
	if strings.TrimSpace(req.Note) != "" {
		ov.RawNotes[res.Version.Version] = req.Note
	}
	if msgNum > 0 {
		ov.VersionMsgs[res.Version.Version] = msgNum
	}
	ov.Updated = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.emitServerEvent(map[string]any{"type": "artifactChanged", "at": h.hub.nowMs(), "id": cur.ID})
	h.hub.notifyAllState()
	out, _ := h.buildProtoArtifact(cur.ID)
	writeSuccess(w, out)
}

func (h *Handler) handleArtifactHTMLEdit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string `json:"id"`
		Version int    `json:"version"`
		Anchor  struct {
			Kind   string `json:"kind"`
			Exact  string `json:"exact"`
			Prefix string `json:"prefix"`
			Suffix string `json:"suffix"`
		} `json:"anchor"`
		Text string `json:"text"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	cur, err := h.st.Artifacts.Deliverables.Get(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	if req.Version != cur.LatestVersion {
		writeError(w, newBizError(BizArtifactRefused, "can only edit the latest version"), BizArtifactRefused)
		return
	}
	_, htmlBytes, err := h.st.Artifacts.Deliverables.GetVersion(r.Context(), req.ID, req.Version)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	updated, reason, ok := applyHTMLAnchorEdit(string(htmlBytes), req.Anchor.Prefix, req.Anchor.Exact, req.Anchor.Suffix, req.Text)
	if !ok {
		writeError(w, newBizError(BizArtifactRefused, reason), BizArtifactRefused)
		return
	}
	note := strings.TrimSpace(req.Anchor.Exact) + " -> " + strings.TrimSpace(req.Text)
	res, err := h.st.Artifacts.Deliverables.Publish(r.Context(), artifact.PublishRequest{
		ID:        cur.ID,
		Title:     cur.Title,
		Display:   cur.Display,
		ChannelID: cur.ChannelID,
		IssueID:   cur.IssueID,
		Note:      note,
		Author:    "user",
		RawHTML:   updated,
	})
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.mu.RLock()
	ov := h.hub.state.Artifacts[cur.ID]
	chID := cur.ChannelID
	title := cur.Title
	display := protoDisplayOf(cur.Display)
	if ov != nil {
		chID = firstNonEmpty(ov.Channel, chID)
		title = firstNonEmpty(ov.Title, title)
		display = firstNonEmpty(ov.Display, display)
	}
	h.hub.mu.RUnlock()
	_, msgNum := h.announceArtifactCard(r.Context(), chID, ProtoArtifactCard{
		ID:      cur.ID,
		Title:   title,
		Body:    "html",
		Version: res.Version.Version,
		Note:    note,
		Display: display,
	})
	h.hub.mu.Lock()
	ov = h.hub.state.Artifacts[cur.ID]
	if ov == nil {
		ov = &artifactOverlay{ID: cur.ID, Title: title, Body: "html", Display: display, Channel: chID, By: "user", ByName: "owner", At: cur.CreatedAtMs}
		h.hub.state.Artifacts[cur.ID] = ov
	}
	if ov.RawNotes == nil {
		ov.RawNotes = map[int]string{}
	}
	if ov.VersionMsgs == nil {
		ov.VersionMsgs = map[int]int64{}
	}
	ov.RawNotes[res.Version.Version] = note
	if msgNum > 0 {
		ov.VersionMsgs[res.Version.Version] = msgNum
	}
	ov.Updated = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.emitServerEvent(map[string]any{"type": "artifactChanged", "at": h.hub.nowMs(), "id": cur.ID})
	h.hub.notifyAllState()
	out, _ := h.buildProtoArtifact(cur.ID)
	writeSuccess(w, out)
}

func (h *Handler) handleArtifactUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string  `json:"id"`
		Title   *string `json:"title"`
		Display *string `json:"display"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	art, ok := h.buildProtoArtifact(req.ID)
	if !ok {
		writeError(w, newBizError(BizArtifactNotFound, "artifact not found"), BizArtifactNotFound)
		return
	}
	if req.Display != nil && art.Body != "html" {
		writeError(w, newBizError(BizArtifactRefused, "display mode is only valid for html artifacts"), BizArtifactRefused)
		return
	}
	h.hub.mu.Lock()
	ov := h.hub.state.Artifacts[req.ID]
	if ov == nil {
		ov = &artifactOverlay{ID: req.ID, Title: art.Title, Body: art.Body, By: art.By, ByName: art.ByName, At: art.At}
		h.hub.state.Artifacts[req.ID] = ov
	}
	if req.Title != nil {
		ov.Title = *req.Title
	}
	if req.Display != nil {
		ov.Display = *req.Display
	}
	ov.Updated = h.hub.nowMs()
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.emitServerEvent(map[string]any{"type": "artifactChanged", "at": h.hub.nowMs(), "id": req.ID})
	h.hub.notifyAllState()
	out, _ := h.buildProtoArtifact(req.ID)
	writeSuccess(w, out)
}

func (h *Handler) handleArtifactDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, ok := h.buildProtoArtifact(req.ID); !ok {
		writeError(w, newBizError(BizArtifactNotFound, "artifact not found"), BizArtifactNotFound)
		return
	}
	h.hub.mu.Lock()
	ov := h.hub.state.Artifacts[req.ID]
	if ov == nil {
		ov = &artifactOverlay{ID: req.ID}
		h.hub.state.Artifacts[req.ID] = ov
	}
	ov.Deleted = true
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.emitServerEvent(map[string]any{"type": "artifactRemoved", "at": h.hub.nowMs(), "id": req.ID})
	h.hub.notifyAllState()
	writeVoid(w)
}

func (h *Handler) handleArtifactPreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if _, ok := h.buildProtoArtifact(req.ID); !ok {
		writeError(w, newBizError(BizArtifactNotFound, "artifact not found"), BizArtifactNotFound)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Delete artifact %s", req.ID)},
	})
}

func (h *Handler) handleArtifactBlockList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	art, ok := h.buildProtoArtifact(req.ID)
	if !ok {
		writeError(w, newBizError(BizArtifactNotFound, "artifact not found"), BizArtifactNotFound)
		return
	}
	snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	blocks := make([]protoBlock, 0, len(snap.Ordered))
	for _, b := range snap.Ordered {
		if !b.Deleted {
			blocks = append(blocks, toProtoBlock(b))
		}
	}
	writeSuccess(w, map[string]any{
		"artifact": art,
		"blocks":   blocks,
	})
}

func (h *Handler) handleArtifactSubmit(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string             `json:"id"`
		BatchID string             `json:"batchId"`
		LastSeq int64              `json:"lastSeq"`
		Ops     []artifact.BlockOp `json:"ops"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ack, err := h.st.Artifacts.Pages.SubmitBatch(r.Context(), req.ID, artifact.UserActor, firstNonEmpty(req.BatchID, randomID("batch")), req.Ops)
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	blocks := make([]protoBlock, 0, len(ack.Blocks))
	for _, b := range ack.Blocks {
		blocks = append(blocks, toProtoBlock(b))
	}
	results := ack.Results
	if results == nil {
		results = []artifact.BlockOpResult{}
	}
	h.hub.emitArtifactChange(req.ID, false, ack.Seq)
	writeSuccess(w, map[string]any{
		"batchId": ack.BatchID,
		"seq":     ack.Seq,
		"results": results,
		"blocks":  blocks,
	})
}

func (h *Handler) handleArtifactBlockCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string  `json:"id"`
		Type       string  `json:"type"`
		Level      *int    `json:"level"`
		Checked    *bool   `json:"checked"`
		Language   string  `json:"language"`
		Text       string  `json:"text"`
		AfterBlock *string `json:"afterBlock"`
		ParentID   string  `json:"parentId"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	var siblings []artifact.Block
	for _, b := range snap.Ordered {
		if !b.Deleted && b.ParentID == req.ParentID {
			siblings = append(siblings, b)
		}
	}
	afterKey := ""
	beforeKey := ""
	if req.AfterBlock == nil {
		if len(siblings) > 0 {
			afterKey = siblings[len(siblings)-1].OrderKey
		}
	} else if *req.AfterBlock == "" {
		if len(siblings) > 0 {
			beforeKey = siblings[0].OrderKey
		}
	} else {
		idx := -1
		for i, b := range siblings {
			if b.ID == *req.AfterBlock {
				idx = i
				break
			}
		}
		if idx < 0 {
			writeError(w, newBizError(BizArtifactRefused, "afterBlock not found among siblings"), BizArtifactRefused)
			return
		}
		afterKey = siblings[idx].OrderKey
		if idx+1 < len(siblings) {
			beforeKey = siblings[idx+1].OrderKey
		}
	}
	newKey, err := artifact.KeyBetween(afterKey, beforeKey)
	if err != nil {
		newKey = "z"
	}
	bt := artifact.BlockType(firstNonEmpty(req.Type, string(artifact.BlockParagraph)))
	attrs := artifact.BlockAttrs{Language: req.Language, Level: req.Level, Checked: req.Checked}
	blkID := randomID("blk")
	ack, err := h.st.Artifacts.Pages.SubmitBatch(r.Context(), req.ID, artifact.UserActor, randomID("batch"), []artifact.BlockOp{
		{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       blkID,
				ParentID: req.ParentID,
				OrderKey: newKey,
				Type:     bt,
				Attrs:    attrs,
				Text:     []artifact.TextSpan{{Text: req.Text}},
			},
		},
	})
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.emitArtifactChange(req.ID, false, ack.Seq)
	if len(ack.Results) > 0 {
		writeSuccess(w, ack.Results[0])
		return
	}
	writeSuccess(w, artifact.BlockOpResult{Status: artifact.OpApplied, BlockID: blkID, Rev: 1})
}

func (h *Handler) handleArtifactBlockUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID       string  `json:"id"`
		Block    string  `json:"block"`
		BaseRev  int64   `json:"baseRev"`
		Text     *string `json:"text"`
		Type     *string `json:"type"`
		Level    *int    `json:"level"`
		Checked  *bool   `json:"checked"`
		Language *string `json:"language"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	var ops []artifact.BlockOp
	if req.Text != nil {
		ops = append(ops, artifact.BlockOp{
			Op:      artifact.OpUpdateText,
			BlockID: req.Block,
			BaseRev: req.BaseRev,
			Text:    []artifact.TextSpan{{Text: *req.Text}},
		})
	}
	if req.Type != nil {
		ops = append(ops, artifact.BlockOp{
			Op:      artifact.OpSetType,
			BlockID: req.Block,
			Type:    artifact.BlockType(*req.Type),
		})
	}
	if req.Level != nil || req.Checked != nil || req.Language != nil {
		attrs := artifact.BlockAttrs{Level: req.Level, Checked: req.Checked}
		if req.Language != nil {
			attrs.Language = *req.Language
		}
		ops = append(ops, artifact.BlockOp{Op: artifact.OpSetAttrs, BlockID: req.Block, Attrs: attrs})
	}
	ack, err := h.st.Artifacts.Pages.SubmitBatch(r.Context(), req.ID, artifact.UserActor, randomID("batch"), ops)
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.emitArtifactChange(req.ID, false, ack.Seq)
	if len(ack.Results) > 0 {
		writeSuccess(w, ack.Results[0])
		return
	}
	writeSuccess(w, artifact.BlockOpResult{Status: artifact.OpNoop, BlockID: req.Block})
}

func (h *Handler) handleArtifactBlockDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID    string `json:"id"`
		Block string `json:"block"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	ack, err := h.st.Artifacts.Pages.SubmitBatch(r.Context(), req.ID, artifact.UserActor, randomID("batch"), []artifact.BlockOp{
		{Op: artifact.OpDeleteBlock, BlockID: req.Block},
	})
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.emitArtifactChange(req.ID, false, ack.Seq)
	if len(ack.Results) > 0 {
		writeSuccess(w, ack.Results[0])
		return
	}
	writeSuccess(w, artifact.BlockOpResult{Status: artifact.OpApplied, BlockID: req.Block})
}

func (h *Handler) handleArtifactBlockPreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID    string `json:"id"`
		Block string `json:"block"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, map[string]any{
		"does": []string{fmt.Sprintf("Delete block %s from %s", req.Block, req.ID)},
	})
}

func (h *Handler) handleArtifactSuggestionList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	out := make([]protoSuggestion, 0, len(snap.Suggestions))
	for _, sg := range snap.Suggestions {
		out = append(out, toProtoSuggestion(sg))
	}
	writeSuccess(w, out)
}

func (h *Handler) handleArtifactSuggestionCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID      string                    `json:"id"`
		Block   string                    `json:"block"`
		BaseRev int64                     `json:"baseRev"`
		Change  artifact.SuggestionChange `json:"change"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	sg, err := h.st.Artifacts.Pages.Suggest(r.Context(), req.ID, "user", artifact.SuggestionCreate{
		BlockID: req.Block,
		BaseRev: req.BaseRev,
		Change:  req.Change,
	})
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.emitArtifactChange(req.ID, true, 0)
	writeSuccess(w, toProtoSuggestion(sg))
}

func (h *Handler) handleArtifactSuggestionAccept(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string `json:"id"`
		Suggestion string `json:"suggestion"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	sg, ack, err := h.st.Artifacts.Pages.AcceptSuggestion(r.Context(), req.ID, req.Suggestion, artifact.UserActor)
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.emitArtifactChange(req.ID, false, ack.Seq)
	h.hub.emitArtifactChange(req.ID, true, 0)
	writeSuccess(w, toProtoSuggestion(sg))
}

func (h *Handler) handleArtifactSuggestionReject(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID         string `json:"id"`
		Suggestion string `json:"suggestion"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	sg, err := h.st.Artifacts.Pages.RejectSuggestion(r.Context(), req.ID, req.Suggestion, artifact.UserActor)
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.emitArtifactChange(req.ID, true, 0)
	writeSuccess(w, toProtoSuggestion(sg))
}

func (h *Handler) handleArtifactMarkdownGet(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	writeSuccess(w, map[string]string{
		"markdown": renderBlocksMarkdown(snap.Ordered),
	})
}

func (h *Handler) handleArtifactDemo(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	snap, err := h.st.Artifacts.Pages.Snapshot(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	var writers []string
	if h.st != nil && h.st.Agents != nil {
		profiles, _ := h.st.Agents.ListProfiles(r.Context())
		for _, p := range profiles {
			pa := h.hub.buildProtoAgent(p)
			if pa.ID != "" && pa.Enabled && pa.Role != "orchestrator" {
				writers = append(writers, pa.ID)
			}
		}
		if len(writers) == 0 {
			for _, p := range profiles {
				pa := h.hub.buildProtoAgent(p)
				if pa.ID != "" && pa.Enabled {
					writers = append(writers, pa.ID)
				}
			}
		}
	}
	if len(writers) == 0 {
		writeError(w, newBizError(BizArtifactRefused, "no enabled agent writer available"), BizArtifactRefused)
		return
	}
	writer := writers[0]
	lastKey := ""
	for _, b := range snap.Ordered {
		lastKey = b.OrderKey
	}
	k1, err := artifact.KeyBetween(lastKey, "")
	if err != nil {
		k1 = "z1"
	}
	k2, err := artifact.KeyBetween(k1, "")
	if err != nil {
		k2 = "z2"
	}
	hBlk := randomID("blk")
	pBlk := randomID("blk")
	lvl := 2
	ack, err := h.st.Artifacts.Pages.SubmitBatch(r.Context(), req.ID, writer, randomID("demo"), []artifact.BlockOp{
		{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       hBlk,
				OrderKey: k1,
				Type:     artifact.BlockHeading,
				Attrs:    artifact.BlockAttrs{Level: &lvl},
				Text:     []artifact.TextSpan{{Text: "Draft outline"}},
			},
		},
		{
			Op: artifact.OpInsertBlock,
			Block: &artifact.BlockInput{
				ID:       pBlk,
				OrderKey: k2,
				Type:     artifact.BlockParagraph,
				Text:     []artifact.TextSpan{{Text: "Drafting section..."}},
			},
		},
	})
	if err != nil {
		writeError(w, err, BizArtifactRefused)
		return
	}
	h.hub.emitArtifactChange(req.ID, false, ack.Seq)
	baseRev := int64(1)
	for _, res := range ack.Results {
		if res.BlockID == pBlk && res.Rev > 0 {
			baseRev = res.Rev
		}
	}
	go func(artID, actor, blkID string, rev int64) {
		steps := []string{
			"Drafting section with collaborator notes...",
			"Drafting section with collaborator notes and verified points.",
		}
		for _, txt := range steps {
			time.Sleep(150 * time.Millisecond)
			stepAck, stepErr := h.st.Artifacts.Pages.SubmitBatch(context.Background(), artID, actor, randomID("demo"), []artifact.BlockOp{
				{
					Op:      artifact.OpUpdateText,
					BlockID: blkID,
					BaseRev: rev,
					Text:    []artifact.TextSpan{{Text: txt}},
				},
			})
			if stepErr != nil {
				return
			}
			for _, r := range stepAck.Results {
				if r.BlockID == blkID && r.Rev > 0 {
					rev = r.Rev
				}
			}
			h.hub.emitArtifactChange(artID, false, stepAck.Seq)
		}
	}(req.ID, writer, pBlk, baseRev)
	writeVoid(w)
}

func (h *Handler) handleArtifactPreviewHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
		return
	}
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/artifact/")
	parts := strings.Split(strings.Trim(rest, "/"), "/")
	if len(parts) != 2 {
		writeError(w, newBizError(BizArtifactNotFound, "artifact not found"), BizArtifactNotFound)
		return
	}
	ver, err := strconv.Atoi(parts[1])
	if err != nil || ver <= 0 {
		writeError(w, newBizError(BizInvalidInput, "invalid version"), BizInvalidInput)
		return
	}
	cur, err := h.st.Artifacts.Deliverables.Get(r.Context(), parts[0])
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	_, payload, err := h.st.Artifacts.Deliverables.GetVersion(r.Context(), parts[0], ver)
	if err != nil {
		writeError(w, err, BizArtifactNotFound)
		return
	}
	csp := artifact.StrictPreviewCSP
	if r.URL.Query().Get("print") == "1" {
		csp = artifact.StrictPrintPreviewCSP
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	if r.URL.Query().Get("shell") == "1" {
		theme := r.URL.Query().Get("theme")
		if theme != "dark" {
			theme = "light"
		}
		display := r.URL.Query().Get("display")
		if display == "" {
			display = protoDisplayOf(cur.Display)
			h.hub.mu.RLock()
			if ov := h.hub.state.Artifacts[parts[0]]; ov != nil && ov.Display != "" {
				display = ov.Display
			}
			h.hub.mu.RUnlock()
		}
		payload = []byte(withHTMLShell(string(payload), display, theme))
	}
	w.WriteHeader(http.StatusOK)
	if r.Method == http.MethodHead {
		return
	}
	_, _ = w.Write(payload)
}

// --- Media & Library handlers ---

func (h *Handler) handleMediaInputCreate(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireLocalUser(caller); err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	var req struct {
		Kind string `json:"kind"`
		Name string `json:"name"`
		Mime string `json:"mime"`
		Size int64  `json:"size"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	now := h.hub.nowMs()
	in := ProtoMediaInput{
		ID:        randomID("in"),
		Kind:      req.Kind,
		Name:      req.Name,
		Mime:      req.Mime,
		Size:      req.Size,
		Phase:     "reserved",
		Hash:      nil,
		CreatedAt: now,
		ExpiresAt: now + 3600_000,
		CanDelete: true,
	}
	h.hub.mu.Lock()
	h.hub.state.MediaInputs[in.ID] = &mediaInputRecord{ProtoMediaInput: in}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, in)
}

func (h *Handler) handleMediaInputAdopt(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireLocalUser(caller); err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	var req struct {
		Attachment string `json:"attachment"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	att, err := h.st.Attachments.Get(r.Context(), req.Attachment)
	if err != nil {
		writeError(w, err, BizMediaNotFound)
		return
	}
	data, _ := h.st.Attachments.Bytes(r.Context(), req.Attachment)
	kind := "image"
	if strings.HasPrefix(att.Type, "audio/") {
		kind = "audio"
	} else if strings.HasPrefix(att.Type, "video/") {
		kind = "video"
	}
	now := h.hub.nowMs()
	hash := att.ID
	in := ProtoMediaInput{
		ID:        randomID("in"),
		Kind:      kind,
		Name:      att.Name,
		Mime:      att.Type,
		Size:      att.Size,
		Phase:     "ready",
		Hash:      &hash,
		CreatedAt: now,
		ExpiresAt: now + 3600_000,
		CanDelete: true,
	}
	h.hub.mu.Lock()
	h.hub.state.MediaInputs[in.ID] = &mediaInputRecord{ProtoMediaInput: in, Bytes: data}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, in)
}

func (h *Handler) handleMediaInputGet(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireLocalUser(caller); err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.RLock()
	rec := h.hub.state.MediaInputs[req.ID]
	h.hub.mu.RUnlock()
	if rec == nil {
		writeError(w, newBizError(BizMediaNotFound, "media input not found"), BizMediaNotFound)
		return
	}
	writeSuccess(w, rec.ProtoMediaInput)
}

func (h *Handler) handleMediaInputList(w http.ResponseWriter, _ *http.Request, caller user.Caller) {
	if err := requireLocalUser(caller); err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	h.hub.mu.RLock()
	out := make([]ProtoMediaInput, 0, len(h.hub.state.MediaInputs))
	for _, rec := range h.hub.state.MediaInputs {
		if rec != nil {
			out = append(out, rec.ProtoMediaInput)
		}
	}
	h.hub.mu.RUnlock()
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt > out[j].CreatedAt })
	writeSuccess(w, out)
}

func (h *Handler) handleMediaInputDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireLocalUser(caller); err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.Lock()
	_, ok := h.hub.state.MediaInputs[req.ID]
	delete(h.hub.state.MediaInputs, req.ID)
	h.hub.mu.Unlock()
	if !ok {
		writeError(w, newBizError(BizMediaNotFound, "media input not found"), BizMediaNotFound)
		return
	}
	_ = h.hub.persist()
	writeVoid(w)
}

func (h *Handler) handleMediaInputPreviewDelete(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	if err := requireLocalUser(caller); err != nil {
		writeError(w, err, BizLanForbidden)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, map[string]any{"does": []string{fmt.Sprintf("Delete media input %s", req.ID)}})
}

func (h *Handler) handleMediaInputContent(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/media/input/")
	id := strings.TrimSuffix(rest, "/content")
	id = strings.Trim(id, "/")
	if id == "" || strings.Contains(id, "/") {
		writeError(w, newBizError(BizMediaNotFound, "media input not found"), BizMediaNotFound)
		return
	}
	switch r.Method {
	case http.MethodPut:
		h.hub.mu.RLock()
		rec := h.hub.state.MediaInputs[id]
		h.hub.mu.RUnlock()
		if rec == nil {
			writeError(w, newBizError(BizMediaNotFound, "media input not found"), BizMediaNotFound)
			return
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, 32*1024*1024))
		if err != nil {
			writeError(w, newBizError(BizInvalidInput, "read upload failed"), BizInvalidInput)
			return
		}
		sum := sha256.Sum256(data)
		hashHex := hex.EncodeToString(sum[:])
		h.hub.mu.Lock()
		var updated ProtoMediaInput
		if cur := h.hub.state.MediaInputs[id]; cur != nil {
			cur.Bytes = data
			cur.Size = int64(len(data))
			cur.Phase = "ready"
			cur.Hash = &hashHex
			updated = cur.ProtoMediaInput
		}
		h.hub.mu.Unlock()
		_ = h.hub.persist()
		writeSuccess(w, updated)
	case http.MethodGet, http.MethodHead:
		h.hub.mu.RLock()
		rec := h.hub.state.MediaInputs[id]
		var data []byte
		var mimeType string
		if rec != nil {
			data = rec.Bytes
			mimeType = rec.Mime
		}
		h.hub.mu.RUnlock()
		if rec == nil {
			writeError(w, newBizError(BizMediaNotFound, "media input not found"), BizMediaNotFound)
			return
		}
		total := int64(len(data))
		w.Header().Set("Content-Type", firstNonEmpty(mimeType, "application/octet-stream"))
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Security-Policy", "sandbox")
		rangeHdr := strings.TrimSpace(r.Header.Get("Range"))
		if rangeHdr == "" {
			w.Header().Set("Content-Length", strconv.FormatInt(total, 10))
			w.WriteHeader(http.StatusOK)
			if r.Method == http.MethodGet {
				_, _ = w.Write(data)
			}
			return
		}
		start, end, ok := parseSingleByteRange(rangeHdr, total)
		if !ok {
			w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", total))
			w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
			return
		}
		slice := data[start : end+1]
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, total))
		w.Header().Set("Content-Length", strconv.Itoa(len(slice)))
		w.WriteHeader(http.StatusPartialContent)
		if r.Method == http.MethodGet {
			_, _ = w.Write(slice)
		}
	default:
		writeError(w, newBizError(BizMethodNotAllowed, "method not allowed"), BizMethodNotAllowed)
	}
}

func parseSingleByteRange(hdr string, total int64) (int64, int64, bool) {
	if total <= 0 || !strings.HasPrefix(hdr, "bytes=") {
		return 0, 0, false
	}
	spec := strings.TrimPrefix(hdr, "bytes=")
	if strings.Contains(spec, ",") {
		return 0, 0, false
	}
	left, right, ok := strings.Cut(spec, "-")
	if !ok {
		return 0, 0, false
	}
	if left == "" {
		suffix, err := strconv.ParseInt(right, 10, 64)
		if err != nil || suffix <= 0 {
			return 0, 0, false
		}
		if suffix > total {
			suffix = total
		}
		return total - suffix, total - 1, true
	}
	start, err := strconv.ParseInt(left, 10, 64)
	if err != nil || start < 0 || start >= total {
		return 0, 0, false
	}
	end := total - 1
	if right != "" {
		parsedEnd, err := strconv.ParseInt(right, 10, 64)
		if err != nil || parsedEnd < start {
			return 0, 0, false
		}
		if parsedEnd < end {
			end = parsedEnd
		}
	}
	return start, end, true
}

func (h *Handler) handleMediaSpeechStream(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/v1/media/speech/")
	id := strings.TrimSuffix(rest, "/stream")
	id = strings.Trim(id, "/")
	h.hub.mu.RLock()
	job := h.hub.state.MediaJobs[id]
	h.hub.mu.RUnlock()
	if job == nil || job.Kind != "speech" {
		writeError(w, newBizError(BizMediaNotFound, "speech job not found"), BizMediaNotFound)
		return
	}
	if h.handleOfflineSpeechStream(w, r, id) {
		return
	}
	w.Header().Set("Content-Type", "application/x-ndjson; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"type":"done"}` + "\n"))
}

func (h *Handler) saveMediaJob(kind string, jobMap map[string]any) (json.RawMessage, error) {
	raw, err := json.Marshal(jobMap)
	if err != nil {
		return nil, err
	}
	id, _ := jobMap["id"].(string)
	h.hub.mu.Lock()
	h.hub.state.MediaJobs[id] = &mediaJobRecord{Kind: kind, Raw: raw}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	h.hub.notifyAllState()
	return raw, nil
}

func (h *Handler) handleMediaImageCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID             string   `json:"id"`
		Prompt         string   `json:"prompt"`
		Format         string   `json:"format"`
		Width          int      `json:"width"`
		Height         int      `json:"height"`
		Seed           *int     `json:"seed"`
		Steps          *int     `json:"steps"`
		Guidance       *float64 `json:"guidance"`
		NegativePrompt string   `json:"negativePrompt"`
		Enhance        bool     `json:"enhance"`
		Watermark      bool     `json:"watermark"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if offlineMediaEnabled() {
		raw, oErr := h.handleOfflineImageCreate(r.Context(), req)
		if oErr != nil {
			writeError(w, oErr, BizMediaRefused)
			return
		}
		writeSuccess(w, raw)
		return
	}
	now := h.hub.nowMs()
	raw, err := h.saveMediaJob("image", map[string]any{
		"kind":             "image",
		"id":               req.ID,
		"prompt":           req.Prompt,
		"model":            "default",
		"connection":       "default",
		"revision":         1,
		"source":           map[string]any{"kind": "user"},
		"phase":            "queued",
		"phaseText":        "queued",
		"problem":          "",
		"canCancel":        true,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
	})
	if err != nil {
		writeError(w, err, BizMediaRefused)
		return
	}
	writeSuccess(w, raw)
}

func (h *Handler) handleMediaUnderstandingCreate(w http.ResponseWriter, r *http.Request) {
	h.handleMediaUnderstandingSubmit(w, r, false)
}

func (h *Handler) handleMediaUnderstandingAuthorize(w http.ResponseWriter, r *http.Request) {
	h.handleMediaUnderstandingSubmit(w, r, true)
}

func (h *Handler) handleMediaUnderstandingSubmit(w http.ResponseWriter, r *http.Request, authorize bool) {
	var req struct {
		ID              string   `json:"id"`
		Prompt          string   `json:"prompt"`
		Inputs          []string `json:"inputs"`
		Connection      string   `json:"connection"`
		Revision        int      `json:"revision"`
		AllowUpload     bool     `json:"allowUpload"`
		MaxOutputTokens int      `json:"maxOutputTokens"`
		Channel         string   `json:"channel"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if offlineMediaEnabled() {
		raw, oErr := h.handleOfflineUnderstandingCreate(r.Context(), req, authorize)
		if oErr != nil {
			writeError(w, oErr, BizMediaRefused)
			return
		}
		writeSuccess(w, raw)
		return
	}
	now := h.hub.nowMs()
	raw, err := h.saveMediaJob("understanding", map[string]any{
		"kind":             "understanding",
		"id":               req.ID,
		"prompt":           req.Prompt,
		"inputs":           []any{},
		"model":            "default",
		"connection":       firstNonEmpty(req.Connection, "default"),
		"revision":         req.Revision,
		"source":           map[string]any{"kind": "user"},
		"authorization":    nil,
		"phase":            "queued",
		"phaseText":        "queued",
		"problem":          "",
		"result":           nil,
		"cleanup":          "pending",
		"cleanupText":      "pending",
		"canCancel":        true,
		"canCleanup":       false,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
	})
	if err != nil {
		writeError(w, err, BizMediaRefused)
		return
	}
	writeSuccess(w, raw)
}

func (h *Handler) handleMediaSpeechCreate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID           string `json:"id"`
		Text         string `json:"text"`
		Voice        string `json:"voice"`
		Format       string `json:"format"`
		Asynchronous bool   `json:"asynchronous"`
		Streaming    bool   `json:"streaming"`
		Connection   string `json:"connection"`
		Revision     int    `json:"revision"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if offlineMediaEnabled() {
		raw, oErr := h.handleOfflineSpeechCreate(r.Context(), req)
		if oErr != nil {
			writeError(w, oErr, BizMediaRefused)
			return
		}
		writeSuccess(w, raw)
		return
	}
	now := h.hub.nowMs()
	raw, err := h.saveMediaJob("speech", map[string]any{
		"kind":             "speech",
		"id":               req.ID,
		"prompt":           req.Text,
		"model":            "default",
		"connection":       firstNonEmpty(req.Connection, "default"),
		"revision":         req.Revision,
		"source":           map[string]any{"kind": "user"},
		"voice":            firstNonEmpty(req.Voice, "default"),
		"format":           firstNonEmpty(req.Format, "wav"),
		"canRelease":       false,
		"phase":            "queued",
		"phaseText":        "queued",
		"problem":          "",
		"resultInput":      nil,
		"canCancel":        true,
		"canRetryDownload": false,
		"createdAt":        now,
		"updatedAt":        now,
	})
	if err != nil {
		writeError(w, err, BizMediaRefused)
		return
	}
	writeSuccess(w, raw)
}

func (h *Handler) handleMediaAudioCreate(kind string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var bodyMap map[string]any
		if err := decodeJSONBody(w, r, &bodyMap, true); err != nil {
			writeError(w, err, BizInvalidInput)
			return
		}
		if offlineMediaEnabled() {
			raw, oErr := h.handleOfflineAudioCreate(r.Context(), kind, bodyMap)
			if oErr != nil {
				writeError(w, oErr, BizMediaRefused)
				return
			}
			writeSuccess(w, raw)
			return
		}
		now := h.hub.nowMs()
		id, _ := bodyMap["id"].(string)
		conn, _ := bodyMap["connection"].(string)
		rev := 0
		if v, ok := bodyMap["revision"].(float64); ok {
			rev = int(v)
		}
		prompt := ""
		if t, ok := bodyMap["text"].(string); ok {
			prompt = t
		}
		raw, err := h.saveMediaJob(kind, map[string]any{
			"kind":             kind,
			"id":               id,
			"prompt":           prompt,
			"model":            "default",
			"connection":       firstNonEmpty(conn, "default"),
			"revision":         rev,
			"source":           map[string]any{"kind": "user"},
			"phase":            "queued",
			"phaseText":        "queued",
			"problem":          "",
			"format":           nil,
			"contentType":      nil,
			"input":            nil,
			"resultInput":      nil,
			"previewInput":     nil,
			"result":           nil,
			"canCancel":        true,
			"canResume":        false,
			"canCleanup":       false,
			"canRelease":       false,
			"canRetryDownload": false,
			"createdAt":        now,
			"updatedAt":        now,
			"request":          bodyMap,
		})
		if err != nil {
			writeError(w, err, BizMediaRefused)
			return
		}
		writeSuccess(w, raw)
	}
}

func (h *Handler) handleMediaJobAction(action string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID string `json:"id"`
		}
		if err := decodeJSONBody(w, r, &req, true); err != nil {
			writeError(w, err, BizInvalidInput)
			return
		}
		if raw, handled, oErr := h.handleOfflineMediaJobAction(r.Context(), action, req.ID); handled {
			if oErr != nil {
				writeError(w, oErr, BizMediaNotFound)
				return
			}
			writeSuccess(w, json.RawMessage(raw))
			return
		}
		h.hub.mu.Lock()
		rec := h.hub.state.MediaJobs[req.ID]
		if rec == nil {
			h.hub.mu.Unlock()
			writeError(w, newBizError(BizMediaNotFound, "media job not found"), BizMediaNotFound)
			return
		}
		var m map[string]any
		_ = json.Unmarshal(rec.Raw, &m)
		if action == "cancel" {
			m["phase"] = "canceled"
			m["phaseText"] = "canceled"
			m["canCancel"] = false
			m["updatedAt"] = h.hub.nowMs()
		}
		raw, _ := json.Marshal(m)
		rec.Raw = raw
		h.hub.mu.Unlock()
		_ = h.hub.persist()
		writeSuccess(w, json.RawMessage(raw))
	}
}

func (h *Handler) handleMediaJobList(w http.ResponseWriter, _ *http.Request) {
	type jobSortEntry struct {
		raw       json.RawMessage
		createdAt int64
		id        string
	}
	h.hub.mu.RLock()
	entries := make([]jobSortEntry, 0, len(h.hub.state.MediaJobs))
	for id, rec := range h.hub.state.MediaJobs {
		if rec == nil || len(rec.Raw) == 0 {
			continue
		}
		var meta struct {
			CreatedAt int64 `json:"createdAt"`
		}
		_ = json.Unmarshal(rec.Raw, &meta)
		entries = append(entries, jobSortEntry{raw: rec.Raw, createdAt: meta.CreatedAt, id: id})
	}
	h.hub.mu.RUnlock()
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].createdAt != entries[j].createdAt {
			return entries[i].createdAt < entries[j].createdAt
		}
		return entries[i].id < entries[j].id
	})
	out := make([]json.RawMessage, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.raw)
	}
	writeSuccess(w, out)
}

func (h *Handler) handleMediaPreviewAction(label string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID string `json:"id"`
		}
		if err := decodeJSONBody(w, r, &req, true); err != nil {
			writeError(w, err, BizInvalidInput)
			return
		}
		writeSuccess(w, map[string]any{"does": []string{fmt.Sprintf("%s %s", label, req.ID)}})
	}
}

func (h *Handler) handleLibraryItemList(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Origin string `json:"origin"`
		Type   string `json:"type"`
		Text   string `json:"text"`
		Sort   string `json:"sort"`
	}
	if err := decodeJSONBody(w, r, &req, false); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.RLock()
	out := []ProtoLibraryItem{}
	q := strings.ToLower(strings.TrimSpace(req.Text))
	for _, item := range h.hub.state.Library {
		if req.Origin != "" && item.Origin["kind"] != req.Origin {
			continue
		}
		if req.Type != "" && !strings.HasPrefix(item.Attachment.Type, req.Type+"/") {
			continue
		}
		if q != "" && !strings.Contains(strings.ToLower(item.Attachment.Name), q) {
			continue
		}
		out = append(out, item)
	}
	h.hub.mu.RUnlock()
	sort.SliceStable(out, func(i, j int) bool {
		return out[i].LastAt > out[j].LastAt
	})
	writeSuccess(w, out)
}

func (h *Handler) handleLibraryItemAdd(w http.ResponseWriter, r *http.Request, caller user.Caller) {
	var req struct {
		Attachment string `json:"attachment"`
		URL        string `json:"url"`
		Path       string `json:"path"`
		Name       string `json:"name"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if !caller.Here && strings.TrimSpace(req.Path) != "" {
		writeError(w, newBizError(BizLanForbidden, "local path media import forbidden over LAN"), BizLanForbidden)
		return
	}
	now := h.hub.nowMs()
	var att attachment.Attachment
	var origin map[string]any
	switch {
	case strings.TrimSpace(req.Attachment) != "":
		got, err := h.st.Attachments.Get(r.Context(), req.Attachment)
		if err != nil {
			writeError(w, err, BizLibraryNotFound)
			return
		}
		att = got
		origin = map[string]any{"kind": "uploaded"}
	case strings.TrimSpace(req.Path) != "":
		data, err := os.ReadFile(req.Path)
		if err != nil {
			writeError(w, newBizError(BizLibraryRefused, err.Error()), BizLibraryRefused)
			return
		}
		name := firstNonEmpty(req.Name, req.Path)
		got, err := h.st.Attachments.PutBytes(r.Context(), name, "", data)
		if err != nil {
			writeError(w, err, BizLibraryRefused)
			return
		}
		att = got
		origin = map[string]any{"kind": "fetched", "agent": "user", "from": map[string]string{"path": req.Path}}
	case strings.TrimSpace(req.URL) != "":
		got, err := h.st.Attachments.PutBytes(r.Context(), firstNonEmpty(req.Name, "download"), "application/octet-stream", []byte(req.URL))
		if err != nil && !errors.Is(err, attachment.ErrEmpty) {
			writeError(w, err, BizLibraryRefused)
			return
		}
		att = got
		origin = map[string]any{"kind": "fetched", "agent": "user", "from": map[string]string{"url": req.URL}}
	default:
		writeError(w, newBizError(BizInvalidInput, "attachment, url, or path is required"), BizInvalidInput)
		return
	}

	item := ProtoLibraryItem{
		Attachment: att,
		Origin:     origin,
		AddedAt:    now,
		LastAt:     now,
	}
	h.hub.mu.Lock()
	replaced := false
	for i := range h.hub.state.Library {
		if h.hub.state.Library[i].Attachment.ID == att.ID {
			h.hub.state.Library[i].LastAt = now
			item = h.hub.state.Library[i]
			replaced = true
			break
		}
	}
	if !replaced {
		h.hub.state.Library = append(h.hub.state.Library, item)
	}
	h.hub.mu.Unlock()
	_ = h.hub.persist()
	writeSuccess(w, item)
}

func (h *Handler) handleLibraryItemDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	h.hub.mu.Lock()
	idx := -1
	for i := range h.hub.state.Library {
		if h.hub.state.Library[i].Attachment.ID == req.ID {
			idx = i
			break
		}
	}
	if idx >= 0 {
		h.hub.state.Library = append(h.hub.state.Library[:idx], h.hub.state.Library[idx+1:]...)
	}
	h.hub.mu.Unlock()
	if idx < 0 {
		writeError(w, newBizError(BizLibraryNotFound, "library item not found"), BizLibraryNotFound)
		return
	}
	_ = h.hub.persist()
	writeVoid(w)
}

func (h *Handler) handleLibraryItemPreviewDelete(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	writeSuccess(w, map[string]any{"does": []string{fmt.Sprintf("Remove library item %s", req.ID)}})
}
