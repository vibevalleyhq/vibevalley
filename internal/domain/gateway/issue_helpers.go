package gateway

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

func hasExecutions(dto ProtoIssue) bool {
	for _, a := range dto.Assignments {
		if len(a.Executions) > 0 {
			return true
		}
	}
	return false
}

func computeIssueMoves(dto ProtoIssue) []string {
	if dto.Delivered == "merged_into_parent" {
		return []string{}
	}
	sent := hasExecutions(dto) || dto.LastRun != nil
	switch dto.Status {
	case "backlog":
		if dto.Refining != nil {
			return []string{}
		}
		return []string{"todo", "canceled"}
	case "todo":
		return []string{"backlog", "canceled"}
	case "in_progress":
		out := []string{}
		if dto.Stage.State == "asking" || (dto.Stage.State == "stuck" && dto.Stage.Stuck != "quiet") {
			out = append(out, "todo")
		}
		if dto.Stage.Stuck == "interrupted" {
			out = append(out, "done")
		}
		out = append(out, "canceled")
		return out
	case "in_review":
		out := []string{"todo"}
		if dto.Stage.Stuck != "failed" {
			out = append(out, "done")
		}
		out = append(out, "canceled")
		return out
	case "done", "canceled":
		if sent {
			return []string{"todo"}
		}
		return []string{"backlog"}
	default:
		return []string{}
	}
}

func sortProtoIssuesOrder(items []ProtoIssue) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		sentA := hasExecutions(a)
		sentB := hasExecutions(b)
		if !sentA && !sentB {
			ra, rb := 0, 0
			if a.Rank != nil {
				ra = *a.Rank
			}
			if b.Rank != nil {
				rb = *b.Rank
			}
			if ra != rb {
				return ra < rb
			}
			if a.CreatedAt != b.CreatedAt {
				return a.CreatedAt < b.CreatedAt
			}
			return a.ID < b.ID
		}
		if !sentA {
			return true
		}
		if !sentB {
			return false
		}
		if a.CreatedAt != b.CreatedAt {
			return a.CreatedAt > b.CreatedAt
		}
		return a.ID < b.ID
	})
}

const (
	issueRankStep  = 1024
	issueRankBound = 2_000_000_000
)

func (h *Handler) placeIssueLocked(ctx context.Context, id, before string) {
	if h.st == nil || h.st.Issues == nil {
		return
	}
	all, err := h.st.Issues.ListIssues(ctx)
	if err != nil {
		return
	}
	var unsent []ProtoIssue
	for _, iss := range all {
		if m := h.hub.state.Issues[iss.ID]; m != nil && m.Deleted {
			continue
		}
		dto := h.hub.buildProtoIssueLocked(iss)
		if !hasExecutions(dto) {
			unsent = append(unsent, dto)
		}
	}
	sortProtoIssuesOrder(unsent)
	from := -1
	var moving ProtoIssue
	rest := make([]ProtoIssue, 0, len(unsent))
	for i, item := range unsent {
		if item.ID == id {
			from = i
			moving = item
			continue
		}
		rest = append(rest, item)
	}
	if from < 0 {
		return
	}
	at := len(rest)
	if before != "" {
		for i, item := range rest {
			if item.ID == before {
				at = i
				break
			}
		}
	}
	if at == from {
		return
	}
	rankOf := func(p ProtoIssue) int {
		if p.Rank != nil {
			return *p.Rank
		}
		return 0
	}
	var singleRank *int
	if at == 0 && len(rest) > 0 {
		r := rankOf(rest[0]) - issueRankStep
		if r >= -issueRankBound {
			singleRank = &r
		}
	} else if at >= len(rest) && len(rest) > 0 {
		r := rankOf(rest[len(rest)-1]) + issueRankStep
		if r <= issueRankBound {
			singleRank = &r
		}
	} else if at > 0 && at < len(rest) {
		prevRank := rankOf(rest[at-1])
		nextRank := rankOf(rest[at])
		if nextRank-prevRank >= 2 {
			r := (prevRank + nextRank) / 2
			singleRank = &r
		}
	}
	if singleRank != nil {
		meta := h.hub.ensureIssueMetaLocked(id)
		r := *singleRank
		meta.Rank = &r
		return
	}
	ordered := make([]ProtoIssue, 0, len(rest)+1)
	ordered = append(ordered, rest[:at]...)
	ordered = append(ordered, moving)
	ordered = append(ordered, rest[at:]...)
	for idx, item := range ordered {
		target := (idx + 1) * issueRankStep
		meta := h.hub.ensureIssueMetaLocked(item.ID)
		r := target
		meta.Rank = &r
	}
}

func runGatewayGit(ctx context.Context, dir string, args ...string) (string, string, int, error) {
	fullArgs := make([]string, 0, len(args)+2)
	if dir != "" {
		fullArgs = append(fullArgs, "-C", dir)
	}
	fullArgs = append(fullArgs, args...)
	cmd := exec.CommandContext(ctx, "git", fullArgs...)
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "LC_ALL=C")
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			code = exitErr.ExitCode()
		} else {
			code = -1
		}
	}
	return stdout.String(), stderr.String(), code, err
}

func gatewayBranchExists(ctx context.Context, repoDir, branch string) bool {
	if repoDir == "" || branch == "" {
		return false
	}
	_, _, code, err := runGatewayGit(ctx, repoDir, "show-ref", "--verify", "--quiet", "refs/heads/"+branch)
	return err == nil && code == 0
}

func (h *Handler) computeIssueDiff(ctx context.Context, iss issue.Issue) map[string]any {
	h.hub.mu.RLock()
	meta := h.hub.state.Issues[iss.ID]
	var branch, baseBranch, wtPath string
	if meta != nil {
		branch = meta.Branch
		baseBranch = meta.BaseBranch
		wtPath = meta.WorktreePath
	}
	h.hub.mu.RUnlock()

	out := map[string]any{
		"repo":        iss.RepoID,
		"base":        firstNonEmpty(baseBranch, "main"),
		"commits":     []map[string]any{},
		"files":       []map[string]any{},
		"uncommitted": []map[string]any{},
		"conflicts":   []string{},
		"behind":      0,
	}
	if iss.RepoID == "" {
		return out
	}
	rp, err := h.findRepoByIDOrName(ctx, iss.RepoID)
	if err != nil {
		return out
	}
	base := firstNonEmpty(baseBranch, rp.DefaultBranch, "main")
	out["base"] = base
	out["repo"] = firstNonEmpty(rp.Name, rp.ID)

	if wtPath == "" && h.st != nil && h.st.Repos != nil {
		if wt, wErr := h.st.Repos.GetWorktree(ctx, rp.ID, iss.ID); wErr == nil {
			wtPath = wt.Path
			if branch == "" {
				branch = wt.Branch
			}
		}
	}
	if branch == "" {
		cand := "vibevalley/issue-" + iss.ID
		if gatewayBranchExists(ctx, rp.RootPath, cand) {
			branch = cand
		}
	}
	uncommitted := []map[string]any{}
	if wtPath != "" {
		if _, stErr := os.Stat(wtPath); stErr == nil {
			stOut, _, _, gErr := runGatewayGit(ctx, wtPath, "status", "--porcelain=v1", "-uall")
			if gErr == nil {
				for _, line := range strings.Split(strings.TrimRight(stOut, "\n\r"), "\n") {
					if len(line) < 4 {
						continue
					}
					code := strings.TrimSpace(line[:2])
					st := code
					if code == "??" {
						st = "A"
					} else if len(code) > 1 {
						st = code[:1]
					}
					uncommitted = append(uncommitted, map[string]any{
						"path":   line[3:],
						"status": st,
					})
				}
			}
		}
	}
	out["uncommitted"] = uncommitted
	if branch == "" || !gatewayBranchExists(ctx, rp.RootPath, branch) {
		return out
	}
	out["branch"] = branch

	commits := []map[string]any{}
	logOut, _, _, logErr := runGatewayGit(ctx, rp.RootPath, "log", "--format=%h\t%ct\t%s", base+".."+branch)
	if logErr == nil {
		for _, line := range strings.Split(strings.TrimRight(logOut, "\n\r"), "\n") {
			if line == "" {
				continue
			}
			parts := strings.SplitN(line, "\t", 3)
			if len(parts) < 3 {
				continue
			}
			sec, _ := strconv.ParseInt(parts[1], 10, 64)
			commits = append(commits, map[string]any{
				"hash":    parts[0],
				"at":      sec * 1000,
				"subject": parts[2],
			})
		}
	}
	out["commits"] = commits

	files := []map[string]any{}
	diffOut, _, _, diffErr := runGatewayGit(ctx, rp.RootPath, "diff", "--no-renames", "--no-color", "--raw", "--numstat", "-p", base+"..."+branch)
	if diffErr == nil && diffOut != "" {
		patchIdx := strings.Index(diffOut, "diff --git ")
		if patchIdx < 0 {
			patchIdx = len(diffOut)
		}
		headLines := strings.Split(diffOut[:patchIdx], "\n")
		patchText := strings.TrimSpace(diffOut[patchIdx:])
		var chunks []string
		if patchText != "" {
			rawChunks := strings.Split(patchText, "\ndiff --git ")
			for i, c := range rawChunks {
				if i > 0 {
					c = "diff --git " + c
				}
				chunks = append(chunks, c)
			}
		}
		counts := make(map[string][2]int)
		var rawFiles []struct {
			path   string
			status string
		}
		for _, l := range headLines {
			if l == "" {
				continue
			}
			if strings.HasPrefix(l, ":") {
				tab := strings.Index(l, "\t")
				if tab < 0 {
					continue
				}
				metaPart := l[:tab]
				filePath := l[tab+1:]
				spaceIdx := strings.LastIndex(metaPart, " ")
				letter := ""
				if spaceIdx >= 0 {
					letter = metaPart[spaceIdx+1:]
				}
				if len(letter) > 1 {
					letter = letter[:1]
				}
				rawFiles = append(rawFiles, struct {
					path   string
					status string
				}{path: filePath, status: letter})
				continue
			}
			parts := strings.SplitN(l, "\t", 3)
			if len(parts) == 3 {
				addN, _ := strconv.Atoi(parts[0])
				remN, _ := strconv.Atoi(parts[1])
				if parts[0] == "-" {
					addN = -1
				}
				if parts[1] == "-" {
					remN = -1
				}
				counts[parts[2]] = [2]int{addN, remN}
			}
		}
		for _, rf := range rawFiles {
			cnt := counts[rf.path]
			entry := map[string]any{
				"path":    rf.path,
				"status":  firstNonEmpty(rf.status, "M"),
				"added":   cnt[0],
				"removed": cnt[1],
			}
			if cnt[0] >= 0 {
				hdr := "diff --git a/" + rf.path + " b/" + rf.path + "\n"
				for _, ch := range chunks {
					if strings.HasPrefix(ch, hdr) {
						entry["patch"] = ch
						break
					}
				}
			}
			files = append(files, entry)
		}
	}
	out["files"] = files

	if h.st != nil && h.st.Repos != nil {
		if chk, cErr := h.st.Repos.ConflictCheck(ctx, rp.ID, branch, base); cErr == nil && chk.HasConflict {
			out["conflicts"] = chk.ConflictFiles
		}
	}
	behindOut, _, _, bErr := runGatewayGit(ctx, rp.RootPath, "rev-list", "--count", branch+".."+base)
	if bErr == nil {
		if n, pErr := strconv.Atoi(strings.TrimSpace(behindOut)); pErr == nil {
			out["behind"] = n
		}
	}
	return out
}

func (h *Handler) resolveAgentByIDOrName(ctx context.Context, idOrName string) (agent.Profile, bool) {
	target := strings.TrimSpace(idOrName)
	if target == "" || h.st == nil || h.st.Agents == nil {
		return agent.Profile{}, false
	}
	if p, err := h.st.Agents.GetProfile(ctx, target); err == nil {
		h.hub.mu.RLock()
		ov := h.hub.state.Agents[p.ID]
		del := ov != nil && ov.Deleted
		h.hub.mu.RUnlock()
		if !del {
			return p, true
		}
	}
	profiles, err := h.st.Agents.ListProfiles(ctx)
	if err != nil {
		return agent.Profile{}, false
	}
	for _, p := range profiles {
		h.hub.mu.RLock()
		ov := h.hub.state.Agents[p.ID]
		del := ov != nil && ov.Deleted
		h.hub.mu.RUnlock()
		if del {
			continue
		}
		if p.ID == target || p.Name == target {
			return p, true
		}
	}
	return agent.Profile{}, false
}

func (h *Handler) findIssueThreadChannel(ctx context.Context, issueID string) (string, bool) {
	if h.st != nil && h.st.Issues != nil {
		if iss, err := h.st.Issues.GetIssue(ctx, issueID); err == nil && strings.TrimSpace(iss.ConversationID) != "" {
			return iss.ConversationID, true
		}
	}
	if h.st != nil && h.st.Channels != nil {
		if chs, err := h.st.Channels.ListChannels(ctx); err == nil {
			for _, ch := range chs {
				if ch.IssueID == issueID {
					return ch.ID, true
				}
			}
		}
	}
	h.hub.mu.RLock()
	defer h.hub.mu.RUnlock()
	for id, m := range h.hub.state.Channels {
		if m != nil && !m.Deleted && m.SubjectKind == "issue" && m.SubjectID == issueID {
			return id, true
		}
	}
	return "", false
}

func (h *gatewayHub) resolveDefaultChannelID() string {
	h.mu.RLock()
	def := h.state.DefaultChannel
	h.mu.RUnlock()
	if def != "" {
		return def
	}
	return defaultChannelID
}

func (h *Handler) ensureIssueThreadChannel(ctx context.Context, iss issue.Issue, parentID string) string {
	if existing, ok := h.findIssueThreadChannel(ctx, iss.ID); ok {
		return existing
	}
	if h.st == nil || h.st.Channels == nil {
		return ""
	}
	if parentID == "" {
		parentID = h.hub.resolveDefaultChannelID()
	}
	thID := "thread-issue-" + iss.ID
	if _, err := h.st.Channels.GetChannel(ctx, thID); err != nil {
		_, _ = h.st.Channels.CreateChannel(ctx, channel.Channel{
			ID:              thID,
			Name:            iss.Title,
			Type:            channel.TypeThread,
			ParentChannelID: parentID,
			IssueID:         iss.ID,
		})
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureChannelMetaLocked(thID)
	meta.Title = iss.Title
	meta.SubjectKind = "issue"
	meta.SubjectID = iss.ID
	h.hub.mu.Unlock()
	if h.st.Issues != nil {
		_, _ = h.st.Issues.UpdateIssue(ctx, iss.ID, func(cur *issue.Issue) error {
			cur.ConversationID = thID
			return nil
		})
	}
	return thID
}

func (h *Handler) runScriptedRefine(ctx context.Context, iss issue.Issue, text string) (issue.Issue, error) {
	threadID := h.ensureIssueThreadChannel(ctx, iss, "")
	said := strings.TrimSpace(text)
	if said != "" && h.st != nil && h.st.Channels != nil && threadID != "" {
		_, _, _ = h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
			ChannelID: threadID,
			Kind:      contract.ChannelEventMessage,
			AuthorID:  "user",
			ActorKind: channel.ActorUser,
			Text:      said,
		})
	}
	prof, ok := h.resolveAgentByIDOrName(ctx, firstNonEmpty(iss.AssigneeID, "docs"))
	if !ok {
		prof = agent.Profile{ID: firstNonEmpty(iss.AssigneeID, "docs"), Name: firstNonEmpty(iss.AssigneeID, "docs"), Runtime: "pi", Role: agent.RoleWorker}
	}
	title := iss.Title
	desc := iss.Description
	var criteria []string
	var questions []ProtoQuestion
	var replyMsg string

	if strings.Contains(said, "乱写") {
		replyMsg = "看了一圈，不知道写什么。\n\n结论：没写出来"
	} else {
		isKanban := strings.Contains(said, "看板") || strings.Contains(iss.Title, "看板") || strings.Contains(said, "8797")
		if strings.Contains(said, "用 8797") {
			title = "看板拖卡改用 8797 端口"
			criteria = []string{"拖到待办就开工", "端口是 8797"}
			questions = []ProtoQuestion{}
			desc = "## 为什么\n看板还在调旧接口\n\n## 做什么\n- 改 board.dart\n\n## 涉及文件\n- board.dart"
			replyMsg = title + "\n\n" + desc
		} else {
			if isKanban {
				title = "看板拖卡改用 issue.status"
			}
			criteria = []string{"拖到待办就开工"}
			questions = []ProtoQuestion{{Question: "用 8787 还是 8797？", Options: []string{}}}
			desc = "## 为什么\n看板还在调旧接口\n\n## 做什么\n- 改 board.dart\n\n## 涉及文件\n- board.dart"
			replyMsg = title + "\n\n" + desc + "\n\n要问用户：用 8787 还是 8797？"
		}
	}

	nowMs := h.hub.nowMs()
	var rubric *contract.RubricSpec
	if len(criteria) > 0 {
		lines := make([]string, len(criteria))
		for i, c := range criteria {
			lines[i] = "- " + c
		}
		rubric = &contract.RubricSpec{Markdown: strings.Join(lines, "\n")}
	}
	updated, err := h.st.Issues.UpdateIssue(ctx, iss.ID, func(cur *issue.Issue) error {
		cur.Title = title
		cur.Description = desc
		cur.Prompt = desc
		if rubric != nil {
			cur.Rubric = rubric
		}
		if cur.ConversationID == "" && threadID != "" {
			cur.ConversationID = threadID
		}
		return nil
	})
	if err != nil {
		return issue.Issue{}, err
	}
	h.hub.mu.Lock()
	meta := h.hub.ensureIssueMetaLocked(iss.ID)
	meta.Refining = nil
	if len(criteria) > 0 {
		meta.Criteria = copyStrings(criteria)
	}
	if questions != nil {
		meta.Questions = questions
	}
	meta.Milestones = append(meta.Milestones, ProtoMilestone{
		At:   nowMs,
		Kind: "refined",
		Who:  prof.Name,
		Text: title,
	})
	h.hub.mu.Unlock()

	if h.st != nil && h.st.Channels != nil && threadID != "" && replyMsg != "" {
		res, _, pErr := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
			ChannelID: threadID,
			Kind:      contract.ChannelEventMessage,
			AuthorID:  prof.ID,
			ActorKind: channel.ActorAgent,
			ActorRole: channel.RoleWorker,
			Text:      replyMsg,
		})
		if pErr == nil {
			h.hub.mu.Lock()
			cMeta := h.hub.ensureChannelMetaLocked(threadID)
			cMeta.LastAt = res.Event.CreatedAtMs
			h.hub.mu.Unlock()
			msg := h.hub.buildChatMessage(res.Event)
			h.hub.emitChannelMessage(threadID, msg.Revision, msg)
		}
	}
	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(ctx)
	return updated, nil
}

func (h *Handler) recordSessionEvent(sessID string, ev ProtoSessionEvent) {
	h.hub.mu.Lock()
	evs := h.hub.state.SessionEvents[sessID]
	var nextSeq int64 = 1
	if len(evs) > 0 {
		nextSeq = evs[len(evs)-1].Seq + 1
	}
	ev.Seq = nextSeq
	if ev.Revision == 0 {
		ev.Revision = 1
	}
	if ev.Time == 0 {
		ev.Time = h.hub.nowMs()
	}
	h.hub.state.SessionEvents[sessID] = append(evs, ev)
	h.hub.mu.Unlock()

	h.hub.emitLiveEvent(map[string]any{
		"type":     "event",
		"at":       ev.Time,
		"id":       sessID,
		"activity": ev,
	})
}

func (h *Handler) dispatchScriptedWorker(ctx context.Context, iss issue.Issue, triggerKind, userText string, postDispatch bool) issue.Issue {
	if os.Getenv("VIBEVALLEY_TEST_RUNTIMES") != "1" {
		return iss
	}
	prof, ok := h.resolveAgentByIDOrName(ctx, iss.AssigneeID)
	if !ok || prof.Runtime != "pi" {
		return iss
	}
	nowMs := h.hub.nowMs()
	threadID := h.ensureIssueThreadChannel(ctx, iss, "")
	postChID := h.hub.resolveDefaultChannelID()
	if postChID == "" {
		postChID = defaultChannelID
	}

	h.hub.mu.RLock()
	meta := h.hub.state.Issues[iss.ID]
	var sessID string
	var criteria []string
	if meta != nil {
		criteria = copyStrings(meta.Criteria)
		for _, a := range meta.AgentHistory {
			for _, ex := range a.Executions {
				if ex.Kind == "worker" && ex.Session != "" {
					sessID = ex.Session
				}
			}
		}
	}
	if sessID == "" {
		sessID = iss.SessionID
	}
	h.hub.mu.RUnlock()

	isNewSession := false
	if sessID == "" {
		sessID = randomID("sess")
		isNewSession = true
	}

	var cwd, branch, baseBranch string
	if iss.RepoID != "" && h.st != nil && h.st.Repos != nil {
		if rp, rErr := h.findRepoByIDOrName(ctx, iss.RepoID); rErr == nil {
			if wt, wErr := h.st.Repos.CreateOrReuseWorktree(ctx, rp.ID, iss.ID, rp.DefaultBranch); wErr == nil {
				cwd = wt.Path
				branch = wt.Branch
				baseBranch = wt.BaseBranch
			}
		}
	}

	var briefBuf strings.Builder
	briefBuf.WriteString(iss.Title)
	if iss.Description != "" {
		briefBuf.WriteString("\n\n" + iss.Description)
	}
	if len(criteria) > 0 {
		briefBuf.WriteString("\n\n验收标准：\n")
		for i, c := range criteria {
			briefBuf.WriteString(fmt.Sprintf("%d. %s\n", i+1, c))
		}
	}
	brief := briefBuf.String()
	inputText := brief
	if strings.TrimSpace(userText) != "" {
		inputText = strings.TrimSpace(userText)
	}

	h.hub.mu.Lock()
	sess, exists := h.hub.state.Sessions[sessID]
	if !exists || sess == nil {
		sess = &ProtoSession{
			ID:      sessID,
			Role:    "worker",
			Name:    firstNonEmpty(prof.Name, prof.ID),
			Agent:   prof.ID,
			Runtime: prof.Runtime,
			HiredAt: nowMs,
			Scope:   &ProtoSessionScope{Kind: "issue", ID: iss.ID},
			Channel: firstNonEmpty(threadID, postChID),
		}
		h.hub.state.Sessions[sessID] = sess
		isNewSession = true
	}
	sess.Brief = brief
	if iss.RepoID != "" {
		sess.Repo = iss.RepoID
	}
	if branch != "" {
		sess.Branch = branch
	}
	if cwd != "" {
		sess.Worktree = cwd
	}
	sess.Phase = ProtoPhase{
		Tag:   "working",
		Since: &nowMs,
		Doing: &ProtoDoing{Action: "run_command", Label: "bash"},
	}

	im := h.hub.ensureIssueMetaLocked(iss.ID)
	im.Branch = firstNonEmpty(branch, im.Branch)
	im.BaseBranch = firstNonEmpty(baseBranch, im.BaseBranch)
	im.WorktreePath = firstNonEmpty(cwd, im.WorktreePath)
	im.Questions = nil
	im.LastRunOutcome = ""
	if isNewSession {
		im.AgentHistory = append(im.AgentHistory, ProtoAssignmentRecord{
			ID:         "assign-" + iss.ID,
			Issue:      iss.ID,
			Agent:      prof.ID,
			AssignedAt: nowMs,
			Executions: []ProtoAssignmentExecution{{
				Kind:      "worker",
				Session:   sessID,
				StartedAt: nowMs,
			}},
		})
	}
	h.hub.mu.Unlock()

	updated, uErr := h.st.Issues.UpdateIssue(ctx, iss.ID, func(cur *issue.Issue) error {
		cur.Status = contract.IssueInProgress
		cur.SessionID = sessID
		cur.AssigneeID = prof.ID
		cur.FailureReason = ""
		if cur.ConversationID == "" && threadID != "" {
			cur.ConversationID = threadID
		}
		return nil
	})
	if uErr == nil {
		iss = updated
	}

	if postDispatch && h.st != nil && h.st.Channels != nil && postChID != "" {
		orchID := "orchestrator"
		if chObj, chErr := h.st.Channels.GetChannel(ctx, postChID); chErr == nil && chObj.DefaultAgentID != "" {
			orchID = chObj.DefaultAgentID
		}
		dRes, _, dErr := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
			ChannelID: postChID,
			Kind:      contract.ChannelEventMessage,
			AuthorID:  orchID,
			ActorKind: channel.ActorAgent,
			ActorRole: channel.RoleOrchestrator,
			SessionID: sessID,
			Text:      brief,
		})
		if dErr == nil {
			msgID := formatMessageID(postChID, dRes.Event.Seq)
			h.hub.mu.Lock()
			cm := h.hub.ensureChannelMetaLocked(postChID)
			cm.MsgKinds[msgID] = "dispatch"
			cm.LastAt = dRes.Event.CreatedAtMs
			h.hub.mu.Unlock()
			msg := h.hub.buildChatMessage(dRes.Event)
			h.hub.emitChannelMessage(postChID, msg.Revision, msg)
		}
	}

	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(ctx)

	go h.runScriptedWorkerTurn(iss.ID, sessID, prof, triggerKind, inputText, cwd, criteria)
	return iss
}

func (h *Handler) runScriptedWorkerTurn(issueID, sessID string, prof agent.Profile, triggerKind, inputText, cwd string, criteria []string) {
	ctx := context.Background()
	runID := randomID("run")
	startMs := h.hub.nowMs()

	h.recordSessionEvent(sessID, ProtoSessionEvent{Type: "run/start", Run: runID, Text: ""})
	h.recordSessionEvent(sessID, ProtoSessionEvent{Type: "user/message", Run: runID, Text: inputText})

	delay := 30 * time.Millisecond
	if strings.Contains(inputText, "发呆") {
		delay = 900 * time.Millisecond
	}
	time.Sleep(delay)

	okTrue := true
	okFalse := false

	if strings.Contains(inputText, "必败") {
		endMs := h.hub.nowMs()
		errText := "provider said no"
		h.recordSessionEvent(sessID, ProtoSessionEvent{Type: "run/error", Run: runID, Text: errText, Ok: &okFalse})
		h.recordSessionEvent(sessID, ProtoSessionEvent{Type: "run/end", Run: runID, Ok: &okFalse})
		h.hub.mu.Lock()
		if sess := h.hub.state.Sessions[sessID]; sess != nil {
			sess.Runs++
			sess.Phase = ProtoPhase{Tag: "failed"}
			sess.LastRun = &ProtoLastRun{Outcome: "failed", Summary: errText, At: endMs}
		}
		meta := h.hub.ensureIssueMetaLocked(issueID)
		meta.LastRunOutcome = "failed"
		meta.Runs = append(meta.Runs, ProtoRun{
			ID:          runID,
			Session:     sessID,
			TriggeredBy: ProtoRunTrigger{Kind: firstNonEmpty(triggerKind, "issue")},
			Heard:       []string{inputText},
			StartedAt:   startMs,
			EndedAt:     &endMs,
			Outcome:     "failed",
			Summary:     errText,
		})
		meta.Milestones = append(meta.Milestones, ProtoMilestone{At: endMs, Kind: "failed", Who: prof.Name, Text: errText})
		h.hub.mu.Unlock()
		_, _ = h.st.Issues.UpdateIssue(ctx, issueID, func(cur *issue.Issue) error {
			cur.Status = contract.IssueReview
			cur.FailureReason = errText
			return nil
		})
		_ = h.hub.persist()
		_ = h.st.SyncSpaceProjection(ctx)
		return
	}

	callNum := 1
	if cwd != "" && strings.Contains(inputText, "提交") {
		cmdStr := `{"command":"git commit"}`
		clockPath := filepath.Join(cwd, "clock.ts")
		_ = os.WriteFile(clockPath, []byte("export const clockIn = () => \"ok\"\n"), 0o644)
		_, _, _, _ = runGatewayGit(ctx, cwd, "add", "clock.ts")
		stOut, _, _, _ := runGatewayGit(ctx, cwd, "status", "--porcelain")
		if strings.TrimSpace(stOut) != "" {
			_, _, _, _ = runGatewayGit(ctx, cwd, "-c", "user.name=session", "-c", "user.email=session@vibevalley.test", "commit", "-q", "-m", "加上打卡")
		}
		h.recordSessionEvent(sessID, ProtoSessionEvent{
			Type: "tool/call", Run: runID, Call: &callNum, Tool: "bash", Action: "run_command", Input: cmdStr,
		})
		h.recordSessionEvent(sessID, ProtoSessionEvent{
			Type: "tool/result", Run: runID, Under: &callNum, Tool: "bash", Output: "", Ok: &okTrue,
		})
		callNum++
	} else {
		h.recordSessionEvent(sessID, ProtoSessionEvent{
			Type: "tool/call", Run: runID, Call: &callNum, Tool: "bash", Action: "run_command", Input: `{"command":"echo hi"}`,
		})
		h.recordSessionEvent(sessID, ProtoSessionEvent{
			Type: "tool/result", Run: runID, Under: &callNum, Tool: "bash", Output: "hi", Ok: &okTrue,
		})
	}

	var questions []ProtoQuestion
	var checks []ProtoCriterionCheck
	var notes string
	asking := strings.Contains(inputText, "先问清楚") && !strings.Contains(inputText, "用 8797")
	if asking {
		opts := []string{}
		if strings.Contains(inputText, "给选项") {
			opts = []string{"用 8787", "用 8797"}
		}
		questions = []ProtoQuestion{{Question: "用 8787 还是 8797？", Options: opts}}
		notes = "\n\n要问用户：用 8787 还是 8797？"
	} else {
		for i := range criteria {
			checks = append(checks, ProtoCriterionCheck{
				Criterion: i,
				Result:    "met",
				Proof:     fmt.Sprintf("标准 %d：做到了 —— 跑了 echo hi", i+1),
			})
		}
	}

	replyText := fmt.Sprintf("做完了：%s｜人设：%s%s", inputText, firstNonEmpty(prof.Persona, "无"), notes)
	h.recordSessionEvent(sessID, ProtoSessionEvent{Type: "assistant/message", Run: runID, Text: replyText})
	h.recordSessionEvent(sessID, ProtoSessionEvent{Type: "run/end", Run: runID, Ok: &okTrue})

	endMs := h.hub.nowMs()
	h.hub.mu.Lock()
	if sess := h.hub.state.Sessions[sessID]; sess != nil {
		sess.Runs++
		sess.Phase = ProtoPhase{Tag: "done"}
		sess.LastRun = &ProtoLastRun{Outcome: "completed", Summary: replyText, At: endMs}
	}
	meta := h.hub.ensureIssueMetaLocked(issueID)
	meta.LastRunOutcome = "completed"
	meta.Questions = questions
	if checks != nil {
		meta.Checks = checks
	}
	meta.Runs = append(meta.Runs, ProtoRun{
		ID:          runID,
		Session:     sessID,
		TriggeredBy: ProtoRunTrigger{Kind: firstNonEmpty(triggerKind, "issue")},
		Heard:       []string{inputText},
		StartedAt:   startMs,
		EndedAt:     &endMs,
		Outcome:     "completed",
		Summary:     replyText,
	})
	msKind := "reported"
	msText := replyText
	if asking {
		msKind = "asked"
		msText = "用 8787 还是 8797？"
	}
	meta.Milestones = append(meta.Milestones, ProtoMilestone{At: endMs, Kind: msKind, Who: prof.Name, Text: msText})
	parentID := meta.Parent
	constraints := meta.Constraints
	h.hub.mu.Unlock()

	if issUpdated, err := h.st.Issues.UpdateIssue(ctx, issueID, func(cur *issue.Issue) error {
		cur.Status = contract.IssueReview
		cur.FailureReason = ""
		return nil
	}); err == nil && issUpdated.ConversationID != "" && h.st.Channels != nil {
		res, _, pErr := h.st.PostAndPumpChannel(ctx, channel.AppendRequest{
			ChannelID: issUpdated.ConversationID,
			Kind:      contract.ChannelEventReport,
			AuthorID:  prof.ID,
			ActorKind: channel.ActorAgent,
			ActorRole: channel.RoleWorker,
			SessionID: sessID,
			IssueID:   issueID,
			Text:      replyText,
			Report:    &channel.ReportSummary{IssueID: issueID, Outcome: "completed", Summary: replyText},
		})
		if pErr == nil {
			h.hub.mu.Lock()
			cm := h.hub.ensureChannelMetaLocked(issUpdated.ConversationID)
			cm.LastAt = res.Event.CreatedAtMs
			h.hub.mu.Unlock()
			msg := h.hub.buildChatMessage(res.Event)
			h.hub.emitChannelMessage(issUpdated.ConversationID, msg.Revision, msg)
		}
	}

	// Join checked child into parent when child succeeded without pending questions.
	if parentID != "" && !asking {
		h.tryMergeChildIntoParent(ctx, issueID, parentID, sessID, cwd, constraints)
	}

	_ = h.hub.persist()
	_ = h.st.SyncSpaceProjection(ctx)
}

func (h *Handler) tryMergeChildIntoParent(ctx context.Context, childID, parentID, sessID, childCwd string, constraints *ProtoIssueConstraints) {
	child, err := h.st.Issues.GetIssue(ctx, childID)
	if err != nil || child.RepoID == "" {
		return
	}
	parent, err := h.st.Issues.GetIssue(ctx, parentID)
	if err != nil || parent.Status == contract.IssueDone || parent.Status == contract.IssueStatus("canceled") {
		return
	}
	if constraints != nil && strings.TrimSpace(constraints.Check) != "" && childCwd != "" {
		cmd := exec.CommandContext(ctx, "sh", "-c", constraints.Check)
		cmd.Dir = childCwd
		if err := cmd.Run(); err != nil {
			return
		}
	}
	rp, err := h.findRepoByIDOrName(ctx, child.RepoID)
	if err != nil {
		return
	}
	h.hub.mu.RLock()
	childBranch := ""
	if cm := h.hub.state.Issues[childID]; cm != nil {
		childBranch = cm.Branch
	}
	h.hub.mu.RUnlock()
	if childBranch == "" {
		childBranch = "vibevalley/issue-" + childID
	}

	pWt, err := h.st.Repos.CreateOrReuseWorktree(ctx, rp.ID, parentID, rp.DefaultBranch)
	if err != nil {
		return
	}
	if _, _, _, mErr := runGatewayGit(ctx, pWt.Path, "-c", "user.name=VibeValley", "-c", "user.email=vibevalley@local", "merge", "--no-edit", childBranch); mErr != nil {
		return
	}
	_, _ = h.st.Repos.ReleaseWorktree(ctx, rp.ID, childID, true)
	_, _, _, _ = runGatewayGit(ctx, rp.RootPath, "branch", "-D", childBranch)

	nowMs := h.hub.nowMs()
	_, _ = h.st.Issues.UpdateIssue(ctx, childID, func(cur *issue.Issue) error {
		cur.Status = contract.IssueDone
		return nil
	})
	h.hub.mu.Lock()
	cm := h.hub.ensureIssueMetaLocked(childID)
	cm.Delivered = "merged_into_parent"
	cm.ClosedAt = &nowMs
	cm.WorktreePath = ""
	if sess := h.hub.state.Sessions[sessID]; sess != nil {
		sess.Phase = ProtoPhase{Tag: "closed", At: &nowMs, Closed: "merged"}
	}
	pm := h.hub.ensureIssueMetaLocked(parentID)
	pm.Branch = pWt.Branch
	pm.BaseBranch = pWt.BaseBranch
	pm.WorktreePath = pWt.Path
	h.hub.mu.Unlock()

	allIssues, _ := h.st.Issues.ListIssues(ctx)
	allChildrenClosed := true
	for _, it := range allIssues {
		h.hub.mu.RLock()
		im := h.hub.state.Issues[it.ID]
		isDel := im != nil && im.Deleted
		isChild := im != nil && im.Parent == parentID
		h.hub.mu.RUnlock()
		if isDel || !isChild {
			continue
		}
		if it.ID != childID && it.Status != contract.IssueDone && it.Status != contract.IssueStatus("canceled") {
			allChildrenClosed = false
			break
		}
	}
	if allChildrenClosed {
		_, _ = h.st.Issues.UpdateIssue(ctx, parentID, func(cur *issue.Issue) error {
			cur.Status = contract.IssueReview
			return nil
		})
	}
}
