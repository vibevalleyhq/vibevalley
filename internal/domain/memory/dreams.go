package memory

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"sort"
	"strings"
	"unicode"

	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

// DreamInput passes an immutable copy of the active memory snapshot and recent completed
// session summaries to an isolated offline consolidation runner.
type DreamInput struct {
	ScopeID          string
	BaseSnapshot     Snapshot
	SessionSummaries []SessionSummary
}

// DreamOutput holds the candidate memory files and consolidation summary produced by a runner.
type DreamOutput struct {
	Files             []MemoryFileInput
	DeduplicatedCount int
	Summary           string
	RunnerSessionID   string
}

// DreamConsolidator executes offline memory consolidation in an isolated context without mutating active state.
type DreamConsolidator interface {
	Consolidate(ctx context.Context, input DreamInput) (DreamOutput, error)
}

// DreamConsolidatorFunc adapts a function to DreamConsolidator.
type DreamConsolidatorFunc func(ctx context.Context, input DreamInput) (DreamOutput, error)

// Consolidate delegates to f.
func (f DreamConsolidatorFunc) Consolidate(ctx context.Context, input DreamInput) (DreamOutput, error) {
	return f(ctx, input)
}

// DreamRequest configures a Phase 4 offline dreaming consolidation run.
type DreamRequest struct {
	ScopeID          string
	SessionSummaries []SessionSummary
	RunnerSessionID  string
	Consolidator     DreamConsolidator
}

// RunDream executes offline memory consolidation in an isolated runner and emits a candidate
// snapshot version + contract.DreamProposalView in a single atomic transaction while leaving
// the active memory snapshot untouched until ApproveDream.
func (s *Store) RunDream(ctx context.Context, req DreamRequest) (contract.DreamProposalView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return contract.DreamProposalView{}, err
	}
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}

	scope := normalizeScopeID(req.ScopeID)
	baseSnap, err := s.ActiveSnapshot(ctx, scope)
	if err != nil {
		return contract.DreamProposalView{}, err
	}

	runnerSessionID := strings.TrimSpace(req.RunnerSessionID)
	if runnerSessionID == "" {
		runnerSessionID = s.nextID("dream-sess")
	}

	consolidator := req.Consolidator
	if consolidator == nil {
		consolidator = DeterministicConsolidator{}
	}

	summariesCopy := make([]SessionSummary, len(req.SessionSummaries))
	for i, ss := range req.SessionSummaries {
		ss.Facts = append([]string(nil), ss.Facts...)
		summariesCopy[i] = ss
	}

	// Execute consolidation outside the database write lock using a cloned snapshot.
	isolatedInput := DreamInput{
		ScopeID:          scope,
		BaseSnapshot:     cloneSnapshot(baseSnap),
		SessionSummaries: summariesCopy,
	}
	out, err := consolidator.Consolidate(ctx, isolatedInput)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if out.RunnerSessionID != "" {
		runnerSessionID = out.RunnerSessionID
	}

	cleanFiles := make(map[string]MemoryFileInput, len(out.Files))
	for _, f := range out.Files {
		rel, err := normalizeMemoryRelPath(f.RelPath)
		if err != nil {
			return contract.DreamProposalView{}, fmt.Errorf("%w: invalid dream output path %q", ErrInvalidArgument, f.RelPath)
		}
		if _, dup := cleanFiles[rel]; dup {
			return contract.DreamProposalView{}, fmt.Errorf("%w: duplicate dream output path %q", ErrInvalidArgument, rel)
		}
		cleanFiles[rel] = MemoryFileInput{
			RelPath: rel,
			Content: cloneBytes(f.Content),
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	defer func() { _ = tx.Rollback() }()

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, tx, scope, nowMs)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if head.activeVersion != baseSnap.Version {
		return contract.DreamProposalView{}, fmt.Errorf("%w: active version advanced from %d to %d during dream run", ErrConflict, baseSnap.Version, head.activeVersion)
	}

	baseFileMap, err := loadActiveFileMapTx(ctx, tx, scope, baseSnap.Version)
	if err != nil {
		return contract.DreamProposalView{}, err
	}

	candVer := head.nextVersion
	summary := strings.TrimSpace(out.Summary)
	if summary == "" {
		summary = fmt.Sprintf("Consolidated %d files (%d duplicates merged)", len(cleanFiles), out.DeduplicatedCount)
	}

	if _, err := tx.ExecContext(ctx, `
		INSERT INTO memory_versions (
			scope_id, version, parent_version, kind, status, summary, session_id, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		scope, candVer, baseSnap.Version, string(VersionDreamCandidate), string(VersionStatusCandidate),
		summary, runnerSessionID, nowMs,
	); err != nil {
		return contract.DreamProposalView{}, err
	}

	orderedPaths := make([]string, 0, len(cleanFiles))
	for p := range cleanFiles {
		orderedPaths = append(orderedPaths, p)
	}
	sort.Strings(orderedPaths)

	for _, p := range orderedPaths {
		f := cleanFiles[p]
		sumHex := sha256Hex(f.Content)
		fileVer := int64(1)
		updatedMs := nowMs
		if prev, ok := baseFileMap[p]; ok {
			if prev.SHA256 == sumHex {
				fileVer = prev.Version
				updatedMs = prev.UpdatedAtMs
			} else {
				fileVer = prev.Version + 1
			}
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO memory_version_files (
				scope_id, version, rel_path, file_version, sha256, content, updated_at_ms
			) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			scope, candVer, p, fileVer, sumHex, f.Content, updatedMs,
		); err != nil {
			return contract.DreamProposalView{}, err
		}
	}

	// Reserve candidateVersion while keeping active_version untouched.
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_heads
		SET next_version = ?, updated_at_ms = ?
		WHERE scope_id = ?`,
		candVer+1, nowMs, scope,
	); err != nil {
		return contract.DreamProposalView{}, err
	}

	proposalID := s.nextID("dream")
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO memory_dreams (
			proposal_id, scope_id, base_version, candidate_version, deduplicated_count,
			summary, status, runner_session_id, previous_active_version, created_at_ms, resolved_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 0)`,
		proposalID, scope, baseSnap.Version, candVer, out.DeduplicatedCount,
		summary, string(DreamPending), runnerSessionID, nowMs,
	); err != nil {
		return contract.DreamProposalView{}, err
	}

	inboxID := s.nextID("inbox")
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO memory_inbox (
			id, scope_id, kind, title, summary, session_id, issue_id,
			proposal_id, conflict_id, resolved, created_at_ms
		) VALUES (?, ?, ?, ?, ?, ?, '', ?, '', 0, ?)`,
		inboxID, scope, string(contract.InboxDreamProposal),
		fmt.Sprintf("Dream proposal v%d -> v%d", baseSnap.Version, candVer),
		summary, runnerSessionID, proposalID, nowMs,
	); err != nil {
		return contract.DreamProposalView{}, err
	}

	if s.beforeCommit != nil {
		if err := s.beforeCommit(); err != nil {
			return contract.DreamProposalView{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return contract.DreamProposalView{}, err
	}

	return contract.DreamProposalView{
		ProposalID:        proposalID,
		BaseVersion:       baseSnap.Version,
		CandidateVersion:  candVer,
		DeduplicatedCount: out.DeduplicatedCount,
		Summary:           summary,
		Status:            string(DreamPending),
		CreatedAtMs:       nowMs,
	}, nil
}

// ApproveDream atomically switches active memory to the candidate snapshot version in a single transaction.
func (s *Store) ApproveDream(ctx context.Context, proposalID string) (contract.DreamProposalView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return contract.DreamProposalView{}, err
	}
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}
	if strings.TrimSpace(proposalID) == "" {
		return contract.DreamProposalView{}, ErrInvalidArgument
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	defer func() { _ = tx.Rollback() }()

	rec, err := loadDreamRecordTx(ctx, tx, proposalID)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if rec.view.Status != string(DreamPending) {
		return contract.DreamProposalView{}, fmt.Errorf("%w: cannot approve proposal in status %q", ErrInvalidTransition, rec.view.Status)
	}

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, tx, rec.scopeID, nowMs)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if head.activeVersion != rec.view.BaseVersion {
		return contract.DreamProposalView{}, fmt.Errorf("%w: active version is %d, proposal based on %d", ErrConflict, head.activeVersion, rec.view.BaseVersion)
	}

	if rec.view.BaseVersion > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE memory_versions SET status = ? WHERE scope_id = ? AND version = ?`,
			string(VersionStatusSuperseded), rec.scopeID, rec.view.BaseVersion,
		); err != nil {
			return contract.DreamProposalView{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_versions SET status = ? WHERE scope_id = ? AND version = ?`,
		string(VersionStatusActive), rec.scopeID, rec.view.CandidateVersion,
	); err != nil {
		return contract.DreamProposalView{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_heads SET active_version = ?, updated_at_ms = ? WHERE scope_id = ?`,
		rec.view.CandidateVersion, nowMs, rec.scopeID,
	); err != nil {
		return contract.DreamProposalView{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_dreams
		SET status = ?, previous_active_version = ?, resolved_at_ms = ?
		WHERE proposal_id = ?`,
		string(DreamApproved), rec.view.BaseVersion, nowMs, proposalID,
	); err != nil {
		return contract.DreamProposalView{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_inbox SET resolved = 1 WHERE proposal_id = ?`, proposalID,
	); err != nil {
		return contract.DreamProposalView{}, err
	}

	if s.beforeCommit != nil {
		if err := s.beforeCommit(); err != nil {
			return contract.DreamProposalView{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return contract.DreamProposalView{}, err
	}

	rec.view.Status = string(DreamApproved)
	return rec.view, nil
}

// RejectDream marks a pending dream proposal rejected without modifying the active snapshot version.
func (s *Store) RejectDream(ctx context.Context, proposalID string) (contract.DreamProposalView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return contract.DreamProposalView{}, err
	}
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}
	if strings.TrimSpace(proposalID) == "" {
		return contract.DreamProposalView{}, ErrInvalidArgument
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	defer func() { _ = tx.Rollback() }()

	rec, err := loadDreamRecordTx(ctx, tx, proposalID)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if rec.view.Status != string(DreamPending) {
		return contract.DreamProposalView{}, fmt.Errorf("%w: cannot reject proposal in status %q", ErrInvalidTransition, rec.view.Status)
	}

	nowMs := s.now()
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_versions SET status = ? WHERE scope_id = ? AND version = ?`,
		string(VersionStatusRejected), rec.scopeID, rec.view.CandidateVersion,
	); err != nil {
		return contract.DreamProposalView{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_dreams SET status = ?, resolved_at_ms = ? WHERE proposal_id = ?`,
		string(DreamRejected), nowMs, proposalID,
	); err != nil {
		return contract.DreamProposalView{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_inbox SET resolved = 1 WHERE proposal_id = ?`, proposalID,
	); err != nil {
		return contract.DreamProposalView{}, err
	}

	if s.beforeCommit != nil {
		if err := s.beforeCommit(); err != nil {
			return contract.DreamProposalView{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return contract.DreamProposalView{}, err
	}

	rec.view.Status = string(DreamRejected)
	return rec.view, nil
}

// RollbackDream atomically switches active memory back from an approved dream candidate to its base version.
func (s *Store) RollbackDream(ctx context.Context, proposalID string) (contract.DreamProposalView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return contract.DreamProposalView{}, err
	}
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}
	if strings.TrimSpace(proposalID) == "" {
		return contract.DreamProposalView{}, ErrInvalidArgument
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}

	tx, err := s.writeDB.BeginTx(ctx, nil)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	defer func() { _ = tx.Rollback() }()

	rec, err := loadDreamRecordTx(ctx, tx, proposalID)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if rec.view.Status != string(DreamApproved) {
		return contract.DreamProposalView{}, fmt.Errorf("%w: cannot rollback proposal in status %q", ErrInvalidTransition, rec.view.Status)
	}

	nowMs := s.now()
	head, err := ensureHeadTx(ctx, tx, rec.scopeID, nowMs)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	if head.activeVersion != rec.view.CandidateVersion {
		return contract.DreamProposalView{}, fmt.Errorf("%w: cannot rollback dream v%d because active version moved to v%d", ErrConflict, rec.view.CandidateVersion, head.activeVersion)
	}

	targetVer := rec.previousActiveVersion
	if targetVer == 0 && rec.view.BaseVersion > 0 {
		targetVer = rec.view.BaseVersion
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_versions SET status = ? WHERE scope_id = ? AND version = ?`,
		string(VersionStatusRolledBack), rec.scopeID, rec.view.CandidateVersion,
	); err != nil {
		return contract.DreamProposalView{}, err
	}
	if targetVer > 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE memory_versions SET status = ? WHERE scope_id = ? AND version = ?`,
			string(VersionStatusActive), rec.scopeID, targetVer,
		); err != nil {
			return contract.DreamProposalView{}, err
		}
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_heads SET active_version = ?, updated_at_ms = ? WHERE scope_id = ?`,
		targetVer, nowMs, rec.scopeID,
	); err != nil {
		return contract.DreamProposalView{}, err
	}
	if _, err := tx.ExecContext(ctx, `
		UPDATE memory_dreams SET status = ?, resolved_at_ms = ? WHERE proposal_id = ?`,
		string(DreamRolledBack), nowMs, proposalID,
	); err != nil {
		return contract.DreamProposalView{}, err
	}

	if s.beforeCommit != nil {
		if err := s.beforeCommit(); err != nil {
			return contract.DreamProposalView{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return contract.DreamProposalView{}, err
	}

	rec.view.Status = string(DreamRolledBack)
	return rec.view, nil
}

// GetDreamProposal retrieves a dream proposal by ID.
func (s *Store) GetDreamProposal(ctx context.Context, proposalID string) (contract.DreamProposalView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return contract.DreamProposalView{}, ErrClosed
	}
	rec, err := loadDreamRecordTx(ctx, s.readDB, proposalID)
	if err != nil {
		return contract.DreamProposalView{}, err
	}
	return rec.view, nil
}

// ListDreamProposals lists all dream proposals for scopeID ordered newest-first.
func (s *Store) ListDreamProposals(ctx context.Context, scopeID string) ([]contract.DreamProposalView, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}
	scope := normalizeScopeID(scopeID)

	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed.Load() {
		return nil, ErrClosed
	}

	rows, err := s.readDB.QueryContext(ctx, `
		SELECT proposal_id, base_version, candidate_version, deduplicated_count, summary, status, created_at_ms
		FROM memory_dreams
		WHERE scope_id = ?
		ORDER BY created_at_ms DESC, candidate_version DESC`, scope,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []contract.DreamProposalView
	for rows.Next() {
		var v contract.DreamProposalView
		if err := rows.Scan(
			&v.ProposalID, &v.BaseVersion, &v.CandidateVersion,
			&v.DeduplicatedCount, &v.Summary, &v.Status, &v.CreatedAtMs,
		); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

type dreamRecord struct {
	scopeID               string
	previousActiveVersion int64
	view                  contract.DreamProposalView
}

func loadDreamRecordTx(ctx context.Context, q queryable, proposalID string) (dreamRecord, error) {
	var rec dreamRecord
	err := q.QueryRowContext(ctx, `
		SELECT scope_id, previous_active_version,
		       proposal_id, base_version, candidate_version, deduplicated_count, summary, status, created_at_ms
		FROM memory_dreams
		WHERE proposal_id = ?`, proposalID,
	).Scan(
		&rec.scopeID, &rec.previousActiveVersion,
		&rec.view.ProposalID, &rec.view.BaseVersion, &rec.view.CandidateVersion,
		&rec.view.DeduplicatedCount, &rec.view.Summary, &rec.view.Status, &rec.view.CreatedAtMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return dreamRecord{}, ErrNotFound
	}
	if err != nil {
		return dreamRecord{}, err
	}
	return rec, nil
}

// DeterministicConsolidator performs offline cross-session fact deduplication,
// stale keyed-fact replacement, and Markdown memory compaction without external LLM calls.
type DeterministicConsolidator struct {
	SimilarityThreshold float64
}

type consolidatedEntry struct {
	text       string
	norm       string
	key        string
	pinnedUser bool
	tokens     map[string]struct{}
}

// Consolidate produces a deduplicated candidate memory file set from input.BaseSnapshot and input.SessionSummaries.
func (c DeterministicConsolidator) Consolidate(ctx context.Context, input DreamInput) (DreamOutput, error) {
	if err := ctx.Err(); err != nil {
		return DreamOutput{}, err
	}
	threshold := c.SimilarityThreshold
	if threshold <= 0 || threshold > 1 {
		threshold = 0.80
	}

	var kept []consolidatedEntry
	dedupCount := 0
	primaryPath := "facts.md"
	otherFiles := make([]MemoryFileInput, 0)

	orderedFiles := append([]MemoryFile(nil), input.BaseSnapshot.Files...)
	sort.Slice(orderedFiles, func(i, j int) bool {
		return orderedFiles[i].RelPath < orderedFiles[j].RelPath
	})
	if len(orderedFiles) > 0 {
		hasFacts := false
		for _, f := range orderedFiles {
			if f.RelPath == "facts.md" {
				hasFacts = true
				break
			}
		}
		if !hasFacts {
			primaryPath = orderedFiles[0].RelPath
		}
	}

	ingestLine := func(rawLine string, fromSession bool) {
		cleaned := strings.TrimSpace(rawLine)
		if cleaned == "" || strings.HasPrefix(cleaned, "#") {
			return
		}
		cleaned = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(cleaned, "- "), "* "))
		if cleaned == "" {
			return
		}
		pinnedUser := strings.HasPrefix(strings.ToLower(cleaned), "user:") || strings.HasPrefix(cleaned, "[user]")
		norm := normalizeFactText(cleaned)
		key := extractFactKey(cleaned)
		toks := factTokens(norm)

		for idx, existing := range kept {
			if existing.norm == norm || jaccardSimilarity(existing.tokens, toks) >= threshold {
				dedupCount++
				if !existing.pinnedUser && key != "" && existing.key == key && fromSession {
					kept[idx] = consolidatedEntry{
						text:       cleaned,
						norm:       norm,
						key:        key,
						pinnedUser: false,
						tokens:     toks,
					}
				}
				return
			}
			if !existing.pinnedUser && key != "" && existing.key == key {
				// Newer fact for the same key supersedes the older stale entry.
				dedupCount++
				kept[idx] = consolidatedEntry{
					text:       cleaned,
					norm:       norm,
					key:        key,
					pinnedUser: pinnedUser,
					tokens:     toks,
				}
				return
			}
		}

		kept = append(kept, consolidatedEntry{
			text:       cleaned,
			norm:       norm,
			key:        key,
			pinnedUser: pinnedUser,
			tokens:     toks,
		})
	}

	var primaryHeader string
	for _, f := range orderedFiles {
		if f.RelPath != primaryPath {
			dedupedContent, fileDups := dedupeSecondaryFile(f.Content, threshold)
			dedupCount += fileDups
			otherFiles = append(otherFiles, MemoryFileInput{
				RelPath: f.RelPath,
				Content: dedupedContent,
			})
			continue
		}
		for line := range strings.SplitSeq(string(f.Content), "\n") {
			trimmed := strings.TrimSpace(line)
			if primaryHeader == "" && strings.HasPrefix(trimmed, "#") {
				primaryHeader = trimmed
				continue
			}
			ingestLine(trimmed, false)
		}
	}

	summaries := append([]SessionSummary(nil), input.SessionSummaries...)
	sort.Slice(summaries, func(i, j int) bool {
		if summaries[i].CompletedAtMs != summaries[j].CompletedAtMs {
			return summaries[i].CompletedAtMs < summaries[j].CompletedAtMs
		}
		return summaries[i].SessionID < summaries[j].SessionID
	})

	sessionIDs := make([]string, 0, len(summaries))
	for _, ss := range summaries {
		if err := ctx.Err(); err != nil {
			return DreamOutput{}, err
		}
		if ss.SessionID != "" {
			sessionIDs = append(sessionIDs, ss.SessionID)
		}
		for _, fact := range ss.Facts {
			ingestLine(fact, true)
		}
		if strings.TrimSpace(ss.Summary) != "" {
			for line := range strings.SplitSeq(ss.Summary, "\n") {
				ingestLine(line, true)
			}
		}
	}

	if primaryHeader == "" {
		primaryHeader = "# Consolidated Memory"
	}
	var b strings.Builder
	b.WriteString(primaryHeader)
	b.WriteByte('\n')
	for _, entry := range kept {
		b.WriteString("- ")
		b.WriteString(entry.text)
		b.WriteByte('\n')
	}

	outFiles := make([]MemoryFileInput, 0, 1+len(otherFiles))
	outFiles = append(outFiles, MemoryFileInput{
		RelPath: primaryPath,
		Content: []byte(b.String()),
	})
	outFiles = append(outFiles, otherFiles...)

	summaryMsg := fmt.Sprintf(
		"Consolidated %d session summaries into %d memory entries (%d deduplicated)",
		len(summaries), len(kept), dedupCount,
	)
	if len(sessionIDs) > 0 {
		summaryMsg = fmt.Sprintf("%s [sessions: %s]", summaryMsg, strings.Join(sessionIDs, ", "))
	}

	return DreamOutput{
		Files:             outFiles,
		DeduplicatedCount: dedupCount,
		Summary:           summaryMsg,
	}, nil
}

func dedupeSecondaryFile(content []byte, threshold float64) ([]byte, int) {
	var outLines []string
	var entries []consolidatedEntry
	dups := 0

	for line := range strings.SplitSeq(strings.ReplaceAll(string(content), "\r\n", "\n"), "\n") {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "#") {
			outLines = append(outLines, line)
			continue
		}
		fact := strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(trimmed, "- "), "* "))
		norm := normalizeFactText(fact)
		toks := factTokens(norm)
		dup := false
		for _, e := range entries {
			if e.norm == norm || jaccardSimilarity(e.tokens, toks) >= threshold {
				dup = true
				break
			}
		}
		if dup {
			dups++
			continue
		}
		entries = append(entries, consolidatedEntry{norm: norm, tokens: toks})
		outLines = append(outLines, line)
	}
	joined := strings.TrimRight(strings.Join(outLines, "\n"), "\n")
	if joined != "" {
		joined += "\n"
	}
	return []byte(joined), dups
}

func normalizeFactText(s string) string {
	fields := strings.Fields(strings.ToLower(strings.TrimSpace(s)))
	return strings.Join(fields, " ")
}

func extractFactKey(s string) string {
	for _, sep := range []string{"::", ":", "="} {
		idx := strings.Index(s, sep)
		if idx <= 0 || idx > 48 {
			continue
		}
		key := strings.TrimSpace(s[:idx])
		if key == "" || strings.ContainsAny(key, "[](){}") {
			continue
		}
		if strings.EqualFold(key, "user") || strings.HasPrefix(strings.ToLower(key), "http") {
			continue
		}
		return strings.ToLower(key)
	}
	return ""
}

func factTokens(norm string) map[string]struct{} {
	toks := make(map[string]struct{})
	var wordBuf strings.Builder
	var cjkRunes []rune

	flushWord := func() {
		if wordBuf.Len() > 0 {
			toks[wordBuf.String()] = struct{}{}
			wordBuf.Reset()
		}
	}
	flushCJK := func() {
		if len(cjkRunes) == 1 {
			toks[string(cjkRunes[0])] = struct{}{}
		} else if len(cjkRunes) > 1 {
			for i := 0; i+1 < len(cjkRunes); i++ {
				toks[string(cjkRunes[i:i+2])] = struct{}{}
			}
		}
		cjkRunes = cjkRunes[:0]
	}

	for _, r := range norm {
		switch {
		case unicode.Is(unicode.Han, r):
			flushWord()
			cjkRunes = append(cjkRunes, r)
		case unicode.IsLetter(r) || unicode.IsNumber(r) || r == '_' || r == '-' || r == '.' || r == '/':
			flushCJK()
			wordBuf.WriteRune(r)
		default:
			flushWord()
			flushCJK()
		}
	}
	flushWord()
	flushCJK()
	return toks
}

func jaccardSimilarity(a, b map[string]struct{}) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	shared := 0
	for k := range a {
		if _, ok := b[k]; ok {
			shared++
		}
	}
	union := len(a) + len(b) - shared
	if union == 0 {
		return 0
	}
	return float64(shared) / float64(union)
}
