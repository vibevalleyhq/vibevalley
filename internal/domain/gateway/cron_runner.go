package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	defaultCronTickInterval = time.Second
	maxCronSearchDays       = 366 * 4
)

var cronOffsetRe = regexp.MustCompile(`^(?:GMT)?([+-])([01]\d|2[0-3])(?::?([0-5]\d))?$`)

type parsedCron5 struct {
	minutes [60]bool
	hours   [24]bool
	dom     [32]bool
	months  [13]bool
	dow     [7]bool
	domWild bool
	dowWild bool
}

func resolveCronLocation(tz string) (*time.Location, error) {
	trimmed := strings.TrimSpace(tz)
	if trimmed == "" || trimmed == "UTC" {
		return time.UTC, nil
	}
	if trimmed == "Local" {
		return time.Local, nil
	}
	if m := cronOffsetRe.FindStringSubmatch(trimmed); m != nil {
		sign := 1
		if m[1] == "-" {
			sign = -1
		}
		hours, _ := strconv.Atoi(m[2])
		mins := 0
		if m[3] != "" {
			mins, _ = strconv.Atoi(m[3])
		}
		return time.FixedZone(trimmed, sign*(hours*3600+mins*60)), nil
	}
	loc, err := time.LoadLocation(trimmed)
	if err != nil {
		return nil, fmt.Errorf("invalid timezone %q: %w", tz, err)
	}
	return loc, nil
}

func parseCronField(field string, minVal, maxVal int, wrapSeven bool) ([]bool, bool, error) {
	trimmed := strings.TrimSpace(field)
	if trimmed == "" {
		return nil, false, fmt.Errorf("empty cron field")
	}
	bits := make([]bool, maxVal+1)
	if trimmed == "*" {
		for i := minVal; i <= maxVal; i++ {
			bits[i] = true
		}
		return bits, true, nil
	}

	parts := strings.Split(trimmed, ",")
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part == "" {
			return nil, false, fmt.Errorf("empty list entry in cron field %q", field)
		}
		rangePart, stepPart, hasStep := strings.Cut(part, "/")
		step := 1
		if hasStep {
			n, err := strconv.Atoi(strings.TrimSpace(stepPart))
			if err != nil || n <= 0 {
				return nil, false, fmt.Errorf("invalid step %q in cron field %q", stepPart, field)
			}
			step = n
		}

		var start, end int
		switch {
		case rangePart == "*":
			start, end = minVal, maxVal
		case strings.Contains(rangePart, "-"):
			aStr, bStr, _ := strings.Cut(rangePart, "-")
			a, errA := strconv.Atoi(strings.TrimSpace(aStr))
			b, errB := strconv.Atoi(strings.TrimSpace(bStr))
			if errA != nil || errB != nil || a < minVal || b > maxVal || a > b {
				return nil, false, fmt.Errorf("invalid range %q in cron field %q", rangePart, field)
			}
			start, end = a, b
		default:
			v, err := strconv.Atoi(strings.TrimSpace(rangePart))
			if err != nil || v < minVal || v > maxVal {
				return nil, false, fmt.Errorf("invalid value %q in cron field %q", rangePart, field)
			}
			start = v
			if hasStep {
				end = maxVal
			} else {
				end = v
			}
		}

		for v := start; v <= end; v += step {
			idx := v
			if wrapSeven && idx == 7 {
				idx = 0
			}
			bits[idx] = true
		}
	}
	return bits, false, nil
}

func parseCronExpr5(expr string) (parsedCron5, error) {
	fields := strings.Fields(strings.TrimSpace(expr))
	if len(fields) != 5 {
		return parsedCron5{}, fmt.Errorf("cron expression must have 5 fields, got %d (%q)", len(fields), expr)
	}
	minBits, _, err := parseCronField(fields[0], 0, 59, false)
	if err != nil {
		return parsedCron5{}, err
	}
	hourBits, _, err := parseCronField(fields[1], 0, 23, false)
	if err != nil {
		return parsedCron5{}, err
	}
	domBits, domWild, err := parseCronField(fields[2], 1, 31, false)
	if err != nil {
		return parsedCron5{}, err
	}
	monBits, _, err := parseCronField(fields[3], 1, 12, false)
	if err != nil {
		return parsedCron5{}, err
	}
	dowBits, dowWild, err := parseCronField(fields[4], 0, 7, true)
	if err != nil {
		return parsedCron5{}, err
	}

	var spec parsedCron5
	copy(spec.minutes[:], minBits)
	copy(spec.hours[:], hourBits)
	copy(spec.dom[:], domBits)
	copy(spec.months[:], monBits)
	copy(spec.dow[:], dowBits[:7])
	spec.domWild = domWild
	spec.dowWild = dowWild
	return spec, nil
}

func (s parsedCron5) matchDay(month, dom, dow int) bool {
	if !s.months[month] {
		return false
	}
	if s.domWild && s.dowWild {
		return true
	}
	if s.domWild {
		return s.dow[dow]
	}
	if s.dowWild {
		return s.dom[dom]
	}
	return s.dom[dom] || s.dow[dow]
}

// ComputeNextRun calculates the first timestamp strictly after now matching a 5-field cron expression in tz.
func ComputeNextRun(expr string, tz string, now time.Time) (time.Time, error) {
	spec, err := parseCronExpr5(expr)
	if err != nil {
		return time.Time{}, err
	}
	loc, err := resolveCronLocation(tz)
	if err != nil {
		return time.Time{}, err
	}

	cur := now.In(loc).Truncate(time.Minute).Add(time.Minute)
	startDay := time.Date(cur.Year(), cur.Month(), cur.Day(), 0, 0, 0, 0, loc)

	for dayOffset := 0; dayOffset <= maxCronSearchDays; dayOffset++ {
		day := time.Date(startDay.Year(), startDay.Month(), startDay.Day()+dayOffset, 0, 0, 0, 0, loc)
		if !spec.matchDay(int(day.Month()), day.Day(), int(day.Weekday())) {
			continue
		}
		hStart := 0
		if dayOffset == 0 {
			hStart = cur.Hour()
		}
		for hr := hStart; hr < 24; hr++ {
			if !spec.hours[hr] {
				continue
			}
			mStart := 0
			if dayOffset == 0 && hr == cur.Hour() {
				mStart = cur.Minute()
			}
			for min := mStart; min < 60; min++ {
				if !spec.minutes[min] {
					continue
				}
				cand := time.Date(day.Year(), day.Month(), day.Day(), hr, min, 0, 0, loc)
				// Skip nonexistent wall-clock times skipped by a spring-forward DST transition.
				if cand.Hour() != hr || cand.Minute() != min || cand.Day() != day.Day() {
					continue
				}
				if cand.After(now) {
					return cand, nil
				}
			}
		}
	}
	return time.Time{}, fmt.Errorf("cron expression %q has no occurrence within %d days", expr, maxCronSearchDays)
}

func computeCronScheduleNextRunMs(sched issue.CronSchedule, tzOverride string, after time.Time) (int64, error) {
	if !sched.Enabled || sched.PendingApproval {
		return 0, nil
	}
	if sched.Kind == issue.CronExpr {
		tz := firstNonEmpty(tzOverride, sched.Timezone, "UTC")
		nextT, err := ComputeNextRun(sched.Expr, tz, after)
		if err != nil {
			return 0, err
		}
		return nextT.UnixMilli(), nil
	}
	return issue.ComputeNextRun(sched, after.UnixMilli())
}

// CronRunResult describes the outcome of triggering a scheduled cron job.
type CronRunResult struct {
	Ran       bool   `json:"ran"`
	ID        string `json:"id"`
	IssueID   string `json:"issueId"`
	ChannelID string `json:"channelId,omitempty"`
	LastRunAt int64  `json:"lastRunAt"`
	NextRunAt int64  `json:"nextRunAt"`
}

// Start begins the background timezone-aware cron scheduler loop tied to ctx and Handler.Close.
func (h *Handler) Start(ctx context.Context) {
	if h == nil {
		return
	}
	h.cronStartOnce.Do(func() {
		if ctx == nil {
			ctx = context.Background()
		}
		runCtx, cancel := context.WithCancel(ctx)
		h.cronCancelMu.Lock()
		h.cronCancel = cancel
		h.cronCancelMu.Unlock()

		interval := h.cronInterval
		if interval <= 0 {
			interval = defaultCronTickInterval
		}

		h.reconcileCronNextRuns(runCtx, time.Now())

		h.cronWG.Add(1)
		go func() {
			defer h.cronWG.Done()
			ticker := time.NewTicker(interval)
			defer ticker.Stop()
			for {
				select {
				case <-runCtx.Done():
					return
				case now := <-ticker.C:
					_, _ = h.RunDueCrons(runCtx, now)
				}
			}
		}()
	})
}

// Close stops background gateway loops (cron scheduler, channel subscriptions) and closes owned storage.
func (h *Handler) Close() error {
	if h == nil {
		return nil
	}
	h.cronCancelMu.Lock()
	cancel := h.cronCancel
	h.cronCancel = nil
	h.cronCancelMu.Unlock()
	if cancel != nil {
		cancel()
	}
	h.cronWG.Wait()

	h.unsubMu.Lock()
	if h.unsubChannel != nil {
		h.unsubChannel()
		h.unsubChannel = nil
	}
	h.unsubMu.Unlock()

	if h.hub != nil && h.hub.sqlStore != nil {
		return h.hub.sqlStore.close()
	}
	return nil
}

func (h *Handler) reconcileCronNextRuns(ctx context.Context, now time.Time) {
	if h == nil || h.st == nil || h.st.Issues == nil {
		return
	}
	crons, err := h.st.Issues.ListCrons(ctx)
	if err != nil {
		return
	}
	changed := false
	for _, c := range crons {
		h.hub.mu.Lock()
		cm := h.hub.state.Crons[c.ID]
		if cm != nil && cm.Deleted {
			h.hub.mu.Unlock()
			continue
		}
		tz := c.Timezone
		if cm != nil && cm.TZ != "" {
			tz = cm.TZ
		}
		en := c.Enabled
		if cm != nil && cm.Enabled != nil {
			en = *cm.Enabled
		}
		if cm != nil && !en && cm.NextRunAtMs != 0 {
			cm.NextRunAtMs = 0
			changed = true
		} else if en && (cm == nil || cm.NextRunAtMs == 0) {
			nextMs, nErr := computeCronScheduleNextRunMs(c, tz, now)
			if nErr == nil && nextMs > 0 {
				if cm == nil {
					enCopy := en
					cm = &cronOverlay{
						Channel: firstNonEmpty(c.ChannelID, defaultChannelID),
						Agent:   c.AssigneeID,
						Repo:    c.RepoID,
						TZ:      firstNonEmpty(tz, "UTC"),
						By:      "user",
						Enabled: &enCopy,
					}
					h.hub.state.Crons[c.ID] = cm
				}
				cm.NextRunAtMs = nextMs
				changed = true
			}
		}
		h.hub.mu.Unlock()
	}
	if changed {
		_ = h.hub.persist()
	}
}

// RunDueCrons inspects all enabled, non-deleted crons whose nextRunAt <= now and executes each via RunCronNow.
func (h *Handler) RunDueCrons(ctx context.Context, now time.Time) ([]CronRunResult, error) {
	if h == nil || h.st == nil || h.st.Issues == nil {
		return nil, nil
	}
	if ctx.Err() != nil {
		return nil, ctx.Err()
	}
	crons, err := h.st.Issues.ListCrons(ctx)
	if err != nil {
		return nil, err
	}
	nowMs := now.UnixMilli()
	var dueIDs []string
	for _, c := range crons {
		h.hub.mu.RLock()
		cm := h.hub.state.Crons[c.ID]
		deleted := cm != nil && cm.Deleted
		enabled := c.Enabled
		if cm != nil && cm.Enabled != nil {
			enabled = *cm.Enabled
		}
		nextMs := c.NextRunAtMs
		if cm != nil && cm.NextRunAtMs > 0 {
			nextMs = cm.NextRunAtMs
		}
		h.hub.mu.RUnlock()
		if deleted || !enabled || nextMs <= 0 || nextMs > nowMs {
			continue
		}
		dueIDs = append(dueIDs, c.ID)
	}

	var results []CronRunResult
	for _, id := range dueIDs {
		res, rErr := h.runCronAt(ctx, id, now, false)
		if rErr != nil {
			continue
		}
		results = append(results, res)
	}
	return results, nil
}

// RunCronNow immediately executes a cron job by ID, creating/dispatching its issue and channel notification,
// updating lastRunAt and nextRunAt, and persisting updated cron metadata.
func (h *Handler) RunCronNow(ctx context.Context, id string) (CronRunResult, error) {
	return h.runCronAt(ctx, id, time.Now(), true)
}

func (h *Handler) runCronAt(ctx context.Context, id string, now time.Time, manual bool) (CronRunResult, error) {
	if h == nil || h.st == nil || h.st.Issues == nil {
		return CronRunResult{}, newBizError(BizServiceUnavailable, "issue service unavailable")
	}
	c, err := h.st.Issues.GetCron(ctx, id)
	if err != nil {
		return CronRunResult{}, newBizError(BizCronNotFound, "cron not found")
	}

	h.hub.mu.RLock()
	cm := h.hub.state.Crons[id]
	deleted := cm != nil && cm.Deleted
	var chName, agentID, repoID, tz string
	var whenRaw json.RawMessage
	if cm != nil {
		chName = cm.Channel
		agentID = cm.Agent
		repoID = cm.Repo
		tz = cm.TZ
		whenRaw = cm.When
	}
	h.hub.mu.RUnlock()
	if deleted {
		return CronRunResult{}, newBizError(BizCronNotFound, "cron not found")
	}

	chName = firstNonEmpty(chName, c.ChannelID, defaultChannelID)
	agentID = firstNonEmpty(agentID, c.AssigneeID)
	repoID = firstNonEmpty(repoID, c.RepoID)
	tz = firstNonEmpty(tz, c.Timezone, "UTC")

	nowMs := now.UnixMilli()
	var issueID string
	var createdIss issue.Issue

	// Use issue.Service.TickDue when naturally due so due-firing and manual execution stay unified.
	if !manual && c.Enabled && c.NextRunAtMs > 0 && c.NextRunAtMs <= nowMs {
		fires, tErr := h.st.Issues.TickDue(ctx, nowMs)
		if tErr == nil {
			for _, f := range fires {
				if f.ScheduleID == c.ID {
					issueID = f.IssueID
					break
				}
			}
		}
	}

	if issueID == "" {
		iss, iErr := h.st.Issues.CreateIssue(ctx, issue.Issue{
			Title:       firstNonEmpty(c.Title, c.Name, c.ID),
			Prompt:      c.Prompt,
			Status:      contract.IssueDraft,
			RepoID:      repoID,
			AssigneeID:  agentID,
			ChannelID:   chName,
			Rubric:      c.Rubric,
			CreatedAtMs: nowMs,
			UpdatedAtMs: nowMs,
		})
		if iErr != nil {
			return CronRunResult{}, iErr
		}
		issueID = iss.ID
		createdIss = iss
	} else if got, gErr := h.st.Issues.GetIssue(ctx, issueID); gErr == nil {
		createdIss = got
	}

	// Ensure overlay metadata links the spawned issue back to the cron schedule.
	h.hub.mu.Lock()
	io := h.hub.ensureIssueMetaLocked(issueID)
	io.Cron = c.ID
	if io.Number <= 0 {
		io.Number = h.hub.state.NextIssueNumber
		h.hub.state.NextIssueNumber++
	}
	h.hub.mu.Unlock()

	if createdIss.Status == contract.IssueDraft && agentID != "" {
		_, _, _ = h.st.Issues.QueueAndDispatch(ctx, issueID)
	}

	// Compute updated nextRunAt across timezones (disabling completed one-shots when fired due).
	nextEnabled := c.Enabled
	if c.Kind == issue.CronOnce && !manual {
		nextEnabled = false
		_, _ = h.st.Issues.SetCronEnabled(ctx, c.ID, false)
	}
	c.Enabled = nextEnabled
	c.LastRunAtMs = nowMs
	nextMs := int64(0)
	if nextEnabled {
		if n, nErr := computeCronScheduleNextRunMs(c, tz, now); nErr == nil {
			nextMs = n
		}
	}

	// Post cron execution notice to the bound VibeValley channel and wake responders if applicable.
	if ch, chErr := h.resolveChannel(ctx, chName); chErr == nil && h.st.Channels != nil {
		promptText := firstNonEmpty(c.Prompt, fmt.Sprintf("Scheduled run: %s", firstNonEmpty(c.Name, c.ID)))
		res, _, pErr := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
			ChannelID: ch.ID,
			Kind:      contract.ChannelEventMessage,
			AuthorID:  "cron:" + c.ID,
			ActorKind: channel.ActorSystem,
			Text:      promptText,
		})
		if pErr == nil {
			h.hub.mu.Lock()
			cMeta := h.hub.ensureChannelMetaLocked(ch.ID)
			cMeta.LastAt = res.Event.CreatedAtMs
			h.hub.mu.Unlock()
			msg := h.hub.buildChatMessage(res.Event)
			h.hub.emitChannelMessage(ch.ID, msg.Revision, msg)
			h.triggerChannelAutoReply(ctx, ch, res.Event, agentID, extractMentions(promptText))
		}
	}

	h.hub.mu.Lock()
	cm = h.hub.state.Crons[c.ID]
	if cm == nil {
		cm = &cronOverlay{
			Channel: chName,
			Agent:   agentID,
			Repo:    repoID,
			TZ:      tz,
			By:      "user",
			When:    whenRaw,
		}
		h.hub.state.Crons[c.ID] = cm
	}
	cm.Name = firstNonEmpty(c.Name, cm.Name, c.ID)
	cm.Text = firstNonEmpty(c.Prompt, cm.Text)
	cm.Enabled = &nextEnabled
	cm.LastRunAtMs = nowMs
	cm.NextRunAtMs = nextMs
	h.hub.mu.Unlock()

	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(ctx)
	h.hub.notifyAllState()

	var whenOut json.RawMessage
	if len(whenRaw) > 0 {
		whenOut = whenRaw
	} else {
		whenOut = json.RawMessage(fmt.Sprintf(`{"kind":"cron","expr":%q}`, c.Expr))
	}
	lr := nowMs
	h.hub.emitServerEvent(map[string]any{
		"type": "cronChanged",
		"at":   nowMs,
		"cron": ProtoCron{
			ID:      c.ID,
			Name:    firstNonEmpty(c.Name, c.ID),
			Text:    c.Prompt,
			Channel: chName,
			Agent:   agentID,
			Repo:    repoID,
			When:    whenOut,
			TZ:      tz,
			Enabled: nextEnabled,
			Created: c.CreatedAtMs,
			LastRun: &lr,
			By:      "user",
			Pending: false,
		},
	})

	return CronRunResult{
		Ran:       true,
		ID:        c.ID,
		IssueID:   issueID,
		ChannelID: chName,
		LastRunAt: nowMs,
		NextRunAt: nextMs,
	}, nil
}

func (h *Handler) handleCronRun(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decodeJSONBody(w, r, &req, true); err != nil {
		writeError(w, err, BizInvalidInput)
		return
	}
	if strings.TrimSpace(req.ID) == "" {
		writeError(w, newBizError(BizInvalidInput, "cron id is required"), BizInvalidInput)
		return
	}
	res, err := h.RunCronNow(r.Context(), req.ID)
	if err != nil {
		writeError(w, err, BizCronRefused)
		return
	}
	writeSuccess(w, res)
}
