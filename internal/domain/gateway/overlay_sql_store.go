package gateway

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	pkgdb "github.com/vibevalleyhq/vibevalley/pkg/db"
	dbgen "github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

type overlaySQLStore struct {
	pool         *pkgdb.Pool
	db           *sql.DB
	q            *dbgen.Queries
	ownsDB       bool
	mediaBlobDir string
	ownsBlobDir  bool
	closed       atomic.Bool

	writeMu      sync.Mutex
	lastSavedGen uint64

	prevKV          map[string]struct{}
	prevIssues      map[string]struct{}
	prevChannels    map[string]struct{}
	prevAgents      map[string]struct{}
	prevTemplates   map[string]struct{}
	prevRuntimes    map[string]struct{}
	prevCrons       map[string]struct{}
	prevArtifacts   map[string]struct{}
	prevLibrary     map[string]struct{}
	prevMediaInputs map[string]string
	prevMediaJobs   map[string]struct{}
	prevPKMPages    map[string]struct{}
	prevPKMComments map[string]struct{}
	prevPKMClips    map[string]struct{}
	prevSessions    map[string]struct{}
	prevSessionEvs  map[string][]int64
	prevRequestKeys map[string]struct{}
}

type preparedMediaInput struct {
	row      dbgen.UpsertGatewayMediaInputParams
	rawBytes []byte
}

type preparedSessionEvent struct {
	seq int64
	row dbgen.UpsertGatewaySessionEventParams
}

type preparedOverlaySnapshot struct {
	gen           uint64
	kv            []dbgen.UpsertGatewayKVParams
	issues        map[string]dbgen.UpsertGatewayIssueParams
	channels      map[string]dbgen.UpsertGatewayChannelParams
	agents        map[string]dbgen.UpsertGatewayAgentParams
	templates     map[string]dbgen.UpsertGatewayTemplateParams
	runtimes      map[string]dbgen.UpsertGatewayRuntimeParams
	crons         map[string]dbgen.UpsertGatewayCronParams
	artifacts     map[string]dbgen.UpsertGatewayArtifactParams
	library       map[string]dbgen.UpsertGatewayLibraryItemParams
	mediaInputs   map[string]preparedMediaInput
	mediaJobs     map[string]dbgen.UpsertGatewayMediaJobParams
	pkmPages      map[string]dbgen.UpsertGatewayPKMPageParams
	pkmComments   map[string]dbgen.UpsertGatewayPKMCommentParams
	pkmClips      map[string]dbgen.UpsertGatewayPKMClipParams
	sessions      map[string]dbgen.UpsertGatewaySessionParams
	sessionEvents map[string][]preparedSessionEvent
	requestKeys   map[string]dbgen.UpsertGatewayRequestKeyParams
}

func ensureGatewayOverlayTables(ctx context.Context, sqlDB *sql.DB) error {
	var existing string
	err := sqlDB.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'gateway_kv'`).Scan(&existing)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("gateway: inspect overlay schema: %w", err)
	}
	fsys, err := pkgdb.ScopeFS("gateway")
	if err != nil {
		return fmt.Errorf("gateway: load overlay migrations: %w", err)
	}
	runner, err := migrate.New(sqlDB, "gateway", fsys)
	if err != nil {
		return fmt.Errorf("gateway: init overlay migrator: %w", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		return fmt.Errorf("gateway: migrate overlay db: %w", err)
	}
	return nil
}

func newOverlaySQLStore(sqlDB *sql.DB, shared bool, mediaBlobDir string) (*overlaySQLStore, error) {
	ctx := context.Background()
	var (
		pool   *pkgdb.Pool
		ownsDB bool
	)
	if sqlDB == nil {
		openedPool, err := pkgdb.OpenPool(ctx, ":memory:")
		if err != nil {
			return nil, fmt.Errorf("gateway: open memory overlay db: %w", err)
		}
		runner, err := migrate.New(openedPool.WriteDB, pkgdb.PlatformScope, pkgdb.MigrationsFS)
		if err != nil {
			_ = openedPool.Close()
			return nil, fmt.Errorf("gateway: init overlay migrator: %w", err)
		}
		if _, err := runner.Up(ctx); err != nil {
			_ = openedPool.Close()
			return nil, fmt.Errorf("gateway: migrate overlay db: %w", err)
		}
		pool = openedPool
		sqlDB = openedPool.WriteDB
		ownsDB = true
	} else if !shared {
		if err := ensureGatewayOverlayTables(ctx, sqlDB); err != nil {
			return nil, err
		}
	}

	blobDir := strings.TrimSpace(mediaBlobDir)
	ownsBlobDir := false
	if blobDir == "" {
		dir, err := os.MkdirTemp("", "vv-gateway-media-*")
		if err != nil {
			if ownsDB && pool != nil {
				_ = pool.Close()
			}
			return nil, fmt.Errorf("gateway: create temp media blob dir: %w", err)
		}
		blobDir = dir
		ownsBlobDir = true
	} else if err := os.MkdirAll(blobDir, 0o755); err != nil {
		if ownsDB && pool != nil {
			_ = pool.Close()
		}
		return nil, fmt.Errorf("gateway: mkdir media blob dir: %w", err)
	}

	return &overlaySQLStore{
		pool:            pool,
		db:              sqlDB,
		q:               dbgen.New(sqlDB),
		ownsDB:          ownsDB,
		mediaBlobDir:    blobDir,
		ownsBlobDir:     ownsBlobDir,
		prevKV:          make(map[string]struct{}),
		prevIssues:      make(map[string]struct{}),
		prevChannels:    make(map[string]struct{}),
		prevAgents:      make(map[string]struct{}),
		prevTemplates:   make(map[string]struct{}),
		prevRuntimes:    make(map[string]struct{}),
		prevCrons:       make(map[string]struct{}),
		prevArtifacts:   make(map[string]struct{}),
		prevLibrary:     make(map[string]struct{}),
		prevMediaInputs: make(map[string]string),
		prevMediaJobs:   make(map[string]struct{}),
		prevPKMPages:    make(map[string]struct{}),
		prevPKMComments: make(map[string]struct{}),
		prevPKMClips:    make(map[string]struct{}),
		prevSessions:    make(map[string]struct{}),
		prevSessionEvs:  make(map[string][]int64),
		prevRequestKeys: make(map[string]struct{}),
	}, nil
}

func (s *overlaySQLStore) close() error {
	if s == nil || s.closed.Swap(true) {
		return nil
	}
	var firstErr error
	if s.ownsDB {
		if s.pool != nil {
			firstErr = s.pool.Close()
		} else if s.db != nil {
			firstErr = s.db.Close()
		}
	}
	if s.ownsBlobDir && s.mediaBlobDir != "" {
		_ = os.RemoveAll(s.mediaBlobDir)
	}
	return firstErr
}

func (s *overlaySQLStore) blobPathForID(id string) string {
	clean := strings.Map(func(r rune) rune {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '-' || r == '_' || r == '.' {
			return r
		}
		return '_'
	}, strings.TrimSpace(id))
	if clean == "" || clean == "." || clean == ".." {
		clean = "blob"
	}
	return filepath.Join(s.mediaBlobDir, clean)
}

func (s *overlaySQLStore) writeMediaBlob(id string, data []byte) (string, error) {
	if s == nil {
		return "", nil
	}
	if err := os.MkdirAll(s.mediaBlobDir, 0o755); err != nil {
		return "", err
	}
	target := s.blobPathForID(id)
	tmp := target + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, target); err != nil {
		_ = os.Remove(tmp)
		return "", err
	}
	return target, nil
}

func (s *overlaySQLStore) readMediaBlob(blobPath string) ([]byte, error) {
	if strings.TrimSpace(blobPath) == "" {
		return nil, nil
	}
	return os.ReadFile(blobPath)
}

func (s *overlaySQLStore) deleteMediaBlob(blobPath string) {
	if strings.TrimSpace(blobPath) != "" {
		_ = os.Remove(blobPath)
	}
}

func formatTS(ms int64) string {
	if ms <= 0 {
		return time.Now().UTC().Format(time.RFC3339Nano)
	}
	return time.UnixMilli(ms).UTC().Format(time.RFC3339Nano)
}

func mustMarshalJSON(v any) (string, error) {
	raw, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(raw), nil
}

func (s *overlaySQLStore) load(ctx context.Context) (overlayState, error) {
	out := emptyOverlayState()

	kvRows, err := s.q.ListGatewayKV(ctx)
	if err != nil {
		return out, err
	}
	for _, r := range kvRows {
		s.prevKV[r.Key] = struct{}{}
		raw := []byte(r.ValueJson)
		switch r.Key {
		case "seq_counters_json":
			var sc struct {
				NextIssueNumber int   `json:"nextIssueNumber"`
				NextMsgSeq      int64 `json:"nextMsgSeq"`
			}
			if json.Unmarshal(raw, &sc) == nil {
				out.NextIssueNumber = sc.NextIssueNumber
				out.NextMsgSeq = sc.NextMsgSeq
			}
		case "default_channel":
			var ch string
			if json.Unmarshal(raw, &ch) == nil {
				out.DefaultChannel = ch
			}
		case "bootstrapped_seed", "starters_seeded":
			var seeded bool
			if json.Unmarshal(raw, &seeded) == nil {
				out.StartersSeeded = seeded
			}
		case "deleted_skills_json":
			var m map[string]bool
			if json.Unmarshal(raw, &m) == nil {
				out.DeletedSkills = m
			}
		case "runtime_checked_at", "runtime_checked_at_json":
			var m map[string]int64
			if json.Unmarshal(raw, &m) == nil {
				out.RuntimeCheckedAt = m
			}
		case "orch_no_key_sent_json":
			var m map[string]bool
			if json.Unmarshal(raw, &m) == nil {
				out.OrchNoKeySent = m
			}
		case "failed_runs_json":
			var m map[string]bool
			if json.Unmarshal(raw, &m) == nil {
				out.FailedRuns = m
			}
		case "github_status_json":
			var gh ProtoGitHubStatus
			if json.Unmarshal(raw, &gh) == nil {
				out.GitHub = &gh
			}
		case "pkm_undo_json":
			var undo pkmUndoRecord
			if json.Unmarshal(raw, &undo) == nil {
				out.PKMUndo = &undo
			}
		}
	}

	if rows, err := s.q.ListGatewayIssues(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var ov issueOverlay
			if json.Unmarshal([]byte(r.PayloadJson), &ov) == nil {
				out.Issues[r.ID] = &ov
				s.prevIssues[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayChannels(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var ov channelOverlay
			if json.Unmarshal([]byte(r.PayloadJson), &ov) == nil {
				out.Channels[r.ID] = &ov
				s.prevChannels[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayAgents(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var ov agentOverlay
			if json.Unmarshal([]byte(r.PayloadJson), &ov) == nil {
				out.Agents[r.ID] = &ov
				s.prevAgents[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayTemplates(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var rec agentTemplateRecord
			if json.Unmarshal([]byte(r.PayloadJson), &rec) == nil {
				out.Templates[r.ID] = &rec
				s.prevTemplates[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayRuntimes(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var rt ProtoRuntimeSettings
			if json.Unmarshal([]byte(r.PayloadJson), &rt) == nil {
				out.RuntimeSettings[r.ID] = &rt
				s.prevRuntimes[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayCrons(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var ov cronOverlay
			if json.Unmarshal([]byte(r.PayloadJson), &ov) == nil {
				out.Crons[r.ID] = &ov
				s.prevCrons[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayArtifacts(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var ov artifactOverlay
			if json.Unmarshal([]byte(r.PayloadJson), &ov) == nil {
				out.Artifacts[r.ID] = &ov
				s.prevArtifacts[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayLibraryItems(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var item ProtoLibraryItem
			if json.Unmarshal([]byte(r.PayloadJson), &item) == nil {
				out.Library = append(out.Library, item)
				s.prevLibrary[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayMediaInputs(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var meta ProtoMediaInput
			if json.Unmarshal([]byte(r.PayloadJson), &meta) == nil {
				rec := &mediaInputRecord{
					ProtoMediaInput: meta,
					BlobPath:        r.BlobPath,
				}
				if r.BlobPath != "" {
					if data, bErr := s.readMediaBlob(r.BlobPath); bErr == nil {
						rec.Bytes = data
					}
				}
				out.MediaInputs[r.ID] = rec
				s.prevMediaInputs[r.ID] = r.BlobPath
			}
		}
	}

	if rows, err := s.q.ListGatewayMediaJobs(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var rec mediaJobRecord
			if json.Unmarshal([]byte(r.PayloadJson), &rec) == nil {
				out.MediaJobs[r.ID] = &rec
				s.prevMediaJobs[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayPKMPages(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var rec pkmPageExtra
			if json.Unmarshal([]byte(r.PayloadJson), &rec) == nil {
				out.PKMPages[r.Path] = &rec
				s.prevPKMPages[r.Path] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayPKMComments(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var rec ProtoPkmComment
			if json.Unmarshal([]byte(r.PayloadJson), &rec) == nil {
				out.PKMComments = append(out.PKMComments, rec)
				s.prevPKMComments[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewayPKMClips(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var rec struct {
				URL  string `json:"url"`
				Page string `json:"page"`
			}
			if json.Unmarshal([]byte(r.PayloadJson), &rec) == nil && rec.URL != "" {
				out.PKMClips[rec.URL] = rec.Page
				s.prevPKMClips[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewaySessions(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var rec ProtoSession
			if json.Unmarshal([]byte(r.PayloadJson), &rec) == nil {
				out.Sessions[r.ID] = &rec
				s.prevSessions[r.ID] = struct{}{}
			}
		}
	}

	if rows, err := s.q.ListGatewaySessionEvents(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var ev ProtoSessionEvent
			if json.Unmarshal([]byte(r.PayloadJson), &ev) == nil {
				out.SessionEvents[r.SessionID] = append(out.SessionEvents[r.SessionID], ev)
				s.prevSessionEvs[r.SessionID] = append(s.prevSessionEvs[r.SessionID], r.Seq)
			}
		}
	}

	if rows, err := s.q.ListGatewayRequestKeys(ctx); err != nil {
		return out, err
	} else {
		for _, r := range rows {
			var val string
			if err := json.Unmarshal([]byte(r.ResponseJson), &val); err == nil {
				out.RequestKeys[r.ScopeKey] = val
			} else {
				out.RequestKeys[r.ScopeKey] = r.ResponseJson
			}
			s.prevRequestKeys[r.ScopeKey] = struct{}{}
		}
	}

	normalizeLoadedOverlay(&out)
	return out, nil
}

func (s *overlaySQLStore) savePrepared(ctx context.Context, snap preparedOverlaySnapshot) error {
	s.writeMu.Lock()
	defer s.writeMu.Unlock()

	if snap.gen < s.lastSavedGen {
		return nil
	}

	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	q := s.q.WithTx(tx)

	nextKV := make(map[string]struct{}, len(snap.kv))
	for _, row := range snap.kv {
		if err := q.UpsertGatewayKV(ctx, row); err != nil {
			return err
		}
		nextKV[row.Key] = struct{}{}
	}
	for k := range s.prevKV {
		if _, ok := nextKV[k]; !ok {
			if err := q.DeleteGatewayKV(ctx, k); err != nil {
				return err
			}
		}
	}

	nextIssues := make(map[string]struct{}, len(snap.issues))
	for id, row := range snap.issues {
		if err := q.UpsertGatewayIssue(ctx, row); err != nil {
			return err
		}
		nextIssues[id] = struct{}{}
	}
	for id := range s.prevIssues {
		if _, ok := nextIssues[id]; !ok {
			if err := q.DeleteGatewayIssue(ctx, id); err != nil {
				return err
			}
		}
	}

	nextChannels := make(map[string]struct{}, len(snap.channels))
	for id, row := range snap.channels {
		if err := q.UpsertGatewayChannel(ctx, row); err != nil {
			return err
		}
		nextChannels[id] = struct{}{}
	}
	for id := range s.prevChannels {
		if _, ok := nextChannels[id]; !ok {
			if err := q.DeleteGatewayChannel(ctx, id); err != nil {
				return err
			}
		}
	}

	nextAgents := make(map[string]struct{}, len(snap.agents))
	for id, row := range snap.agents {
		if err := q.UpsertGatewayAgent(ctx, row); err != nil {
			return err
		}
		nextAgents[id] = struct{}{}
	}
	for id := range s.prevAgents {
		if _, ok := nextAgents[id]; !ok {
			if err := q.DeleteGatewayAgent(ctx, id); err != nil {
				return err
			}
		}
	}

	nextTemplates := make(map[string]struct{}, len(snap.templates))
	for id, row := range snap.templates {
		if err := q.UpsertGatewayTemplate(ctx, row); err != nil {
			return err
		}
		nextTemplates[id] = struct{}{}
	}
	for id := range s.prevTemplates {
		if _, ok := nextTemplates[id]; !ok {
			if err := q.DeleteGatewayTemplate(ctx, id); err != nil {
				return err
			}
		}
	}

	nextRuntimes := make(map[string]struct{}, len(snap.runtimes))
	for id, row := range snap.runtimes {
		if err := q.UpsertGatewayRuntime(ctx, row); err != nil {
			return err
		}
		nextRuntimes[id] = struct{}{}
	}
	for id := range s.prevRuntimes {
		if _, ok := nextRuntimes[id]; !ok {
			if err := q.DeleteGatewayRuntime(ctx, id); err != nil {
				return err
			}
		}
	}

	nextCrons := make(map[string]struct{}, len(snap.crons))
	for id, row := range snap.crons {
		if err := q.UpsertGatewayCron(ctx, row); err != nil {
			return err
		}
		nextCrons[id] = struct{}{}
	}
	for id := range s.prevCrons {
		if _, ok := nextCrons[id]; !ok {
			if err := q.DeleteGatewayCron(ctx, id); err != nil {
				return err
			}
		}
	}

	nextArtifacts := make(map[string]struct{}, len(snap.artifacts))
	for id, row := range snap.artifacts {
		if err := q.UpsertGatewayArtifact(ctx, row); err != nil {
			return err
		}
		nextArtifacts[id] = struct{}{}
	}
	for id := range s.prevArtifacts {
		if _, ok := nextArtifacts[id]; !ok {
			if err := q.DeleteGatewayArtifact(ctx, id); err != nil {
				return err
			}
		}
	}

	nextLibrary := make(map[string]struct{}, len(snap.library))
	for id, row := range snap.library {
		if err := q.UpsertGatewayLibraryItem(ctx, row); err != nil {
			return err
		}
		nextLibrary[id] = struct{}{}
	}
	for id := range s.prevLibrary {
		if _, ok := nextLibrary[id]; !ok {
			if err := q.DeleteGatewayLibraryItem(ctx, id); err != nil {
				return err
			}
		}
	}

	nextMediaInputs := make(map[string]string, len(snap.mediaInputs))
	for id, item := range snap.mediaInputs {
		row := item.row
		if row.BlobPath == "" && len(item.rawBytes) > 0 {
			bp, wErr := s.writeMediaBlob(id, item.rawBytes)
			if wErr != nil {
				return wErr
			}
			row.BlobPath = bp
		} else if row.BlobPath == "" && s.prevMediaInputs[id] != "" {
			row.BlobPath = s.prevMediaInputs[id]
		}
		if err := q.UpsertGatewayMediaInput(ctx, row); err != nil {
			return err
		}
		nextMediaInputs[id] = row.BlobPath
	}
	var blobsToDelete []string
	for id, oldBlob := range s.prevMediaInputs {
		if _, ok := nextMediaInputs[id]; !ok {
			if err := q.DeleteGatewayMediaInput(ctx, id); err != nil {
				return err
			}
			if oldBlob != "" {
				blobsToDelete = append(blobsToDelete, oldBlob)
			}
		}
	}

	nextMediaJobs := make(map[string]struct{}, len(snap.mediaJobs))
	for id, row := range snap.mediaJobs {
		if err := q.UpsertGatewayMediaJob(ctx, row); err != nil {
			return err
		}
		nextMediaJobs[id] = struct{}{}
	}
	for id := range s.prevMediaJobs {
		if _, ok := nextMediaJobs[id]; !ok {
			if err := q.DeleteGatewayMediaJob(ctx, id); err != nil {
				return err
			}
		}
	}

	nextPKMPages := make(map[string]struct{}, len(snap.pkmPages))
	for p, row := range snap.pkmPages {
		if err := q.UpsertGatewayPKMPage(ctx, row); err != nil {
			return err
		}
		nextPKMPages[p] = struct{}{}
	}
	for p := range s.prevPKMPages {
		if _, ok := nextPKMPages[p]; !ok {
			if err := q.DeleteGatewayPKMPage(ctx, p); err != nil {
				return err
			}
		}
	}

	nextPKMComments := make(map[string]struct{}, len(snap.pkmComments))
	for id, row := range snap.pkmComments {
		if err := q.UpsertGatewayPKMComment(ctx, row); err != nil {
			return err
		}
		nextPKMComments[id] = struct{}{}
	}
	for id := range s.prevPKMComments {
		if _, ok := nextPKMComments[id]; !ok {
			if err := q.DeleteGatewayPKMComment(ctx, id); err != nil {
				return err
			}
		}
	}

	nextPKMClips := make(map[string]struct{}, len(snap.pkmClips))
	for id, row := range snap.pkmClips {
		if err := q.UpsertGatewayPKMClip(ctx, row); err != nil {
			return err
		}
		nextPKMClips[id] = struct{}{}
	}
	for id := range s.prevPKMClips {
		if _, ok := nextPKMClips[id]; !ok {
			if err := q.DeleteGatewayPKMClip(ctx, id); err != nil {
				return err
			}
		}
	}

	nextSessions := make(map[string]struct{}, len(snap.sessions))
	for id, row := range snap.sessions {
		if err := q.UpsertGatewaySession(ctx, row); err != nil {
			return err
		}
		nextSessions[id] = struct{}{}
	}
	for id := range s.prevSessions {
		if _, ok := nextSessions[id]; !ok {
			if err := q.DeleteGatewaySession(ctx, id); err != nil {
				return err
			}
		}
	}

	nextSessionEvs := make(map[string][]int64, len(snap.sessionEvents))
	for sessID, evs := range snap.sessionEvents {
		prevSeqs := s.prevSessionEvs[sessID]
		rewrite := len(evs) < len(prevSeqs)
		seqs := make([]int64, len(evs))
		for i, ev := range evs {
			seqs[i] = ev.seq
			if !rewrite && i < len(prevSeqs) && prevSeqs[i] != ev.seq {
				rewrite = true
			}
		}
		startIdx := len(prevSeqs)
		if rewrite {
			if err := q.DeleteGatewaySessionEventsBySession(ctx, sessID); err != nil {
				return err
			}
			startIdx = 0
		}
		for i := startIdx; i < len(evs); i++ {
			if err := q.UpsertGatewaySessionEvent(ctx, evs[i].row); err != nil {
				return err
			}
		}
		if len(seqs) > 0 {
			nextSessionEvs[sessID] = seqs
		}
	}
	for sessID := range s.prevSessionEvs {
		if _, ok := nextSessionEvs[sessID]; !ok {
			if err := q.DeleteGatewaySessionEventsBySession(ctx, sessID); err != nil {
				return err
			}
		}
	}

	nextRequestKeys := make(map[string]struct{}, len(snap.requestKeys))
	for k, row := range snap.requestKeys {
		if err := q.UpsertGatewayRequestKey(ctx, row); err != nil {
			return err
		}
		nextRequestKeys[k] = struct{}{}
	}
	for k := range s.prevRequestKeys {
		if _, ok := nextRequestKeys[k]; !ok {
			if err := q.DeleteGatewayRequestKey(ctx, k); err != nil {
				return err
			}
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}

	s.lastSavedGen = snap.gen
	s.prevKV = nextKV
	s.prevIssues = nextIssues
	s.prevChannels = nextChannels
	s.prevAgents = nextAgents
	s.prevTemplates = nextTemplates
	s.prevRuntimes = nextRuntimes
	s.prevCrons = nextCrons
	s.prevArtifacts = nextArtifacts
	s.prevLibrary = nextLibrary
	s.prevMediaInputs = nextMediaInputs
	s.prevMediaJobs = nextMediaJobs
	s.prevPKMPages = nextPKMPages
	s.prevPKMComments = nextPKMComments
	s.prevPKMClips = nextPKMClips
	s.prevSessions = nextSessions
	s.prevSessionEvs = nextSessionEvs
	s.prevRequestKeys = nextRequestKeys

	for _, bp := range blobsToDelete {
		s.deleteMediaBlob(bp)
	}
	return nil
}
