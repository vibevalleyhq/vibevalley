package db_test

import (
	"context"
	"database/sql"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/viant/sqlite-vec/vec"
	"github.com/viant/sqlite-vec/vector"

	"github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/db/generated"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func TestIsMemoryDSN(t *testing.T) {
	t.Parallel()

	cases := []struct {
		dsn  string
		want bool
	}{
		{dsn: ":memory:", want: true},
		{dsn: " :memory: ", want: true},
		{dsn: "file::memory:?cache=shared", want: true},
		{dsn: "file:memdb1?mode=memory&cache=shared", want: true},
		{dsn: "/tmp/platform.db", want: false},
		{dsn: "file:/tmp/platform.db?_pragma=busy_timeout(15000)", want: false},
		{dsn: "", want: false},
	}

	for _, tc := range cases {
		if got := db.IsMemoryDSN(tc.dsn); got != tc.want {
			t.Errorf("IsMemoryDSN(%q) = %v, want %v", tc.dsn, got, tc.want)
		}
	}
}

func TestOpenPoolMemoryAndFileWAL(t *testing.T) {
	t.Parallel()

	if _, err := db.OpenPool(context.Background(), "   "); err == nil {
		t.Fatal("expected error for blank dsn")
	}

	canceledCtx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := db.OpenPool(canceledCtx, ":memory:"); !errors.Is(err, context.Canceled) {
		t.Fatalf("expected context.Canceled, got %v", err)
	}

	ctx := context.Background()

	memPool, err := db.OpenPool(ctx, ":memory:")
	if err != nil {
		t.Fatalf("OpenPool(:memory:): %v", err)
	}
	defer func() {
		if err := memPool.Close(); err != nil {
			t.Fatalf("memPool.Close: %v", err)
		}
	}()
	if !memPool.IsMem || !memPool.SameDB || memPool.WriteDB == nil || memPool.ReadDB != memPool.WriteDB {
		t.Fatalf("unexpected memory pool state: %+v", memPool)
	}
	assertSQLitePragmas(t, ctx, memPool.WriteDB, "memory", 15000, 1, 1)

	nestedPath := filepath.Join(t.TempDir(), "nested", "db", "platform.db")
	filePool, err := db.OpenPool(ctx, nestedPath)
	if err != nil {
		t.Fatalf("OpenPool(%q): %v", nestedPath, err)
	}
	defer func() {
		if err := filePool.Close(); err != nil {
			t.Fatalf("filePool.Close: %v", err)
		}
	}()
	if filePool.IsMem || filePool.SameDB || filePool.WriteDB == nil || filePool.ReadDB == nil || filePool.ReadDB == filePool.WriteDB {
		t.Fatalf("unexpected file pool state: %+v", filePool)
	}
	if _, err := os.Stat(filepath.Dir(nestedPath)); err != nil {
		t.Fatalf("expected parent dir created: %v", err)
	}
	assertSQLitePragmas(t, ctx, filePool.WriteDB, "wal", 15000, 1, 1)
	assertSQLitePragmas(t, ctx, filePool.ReadDB, "wal", 15000, 1, 1)

	var nilPool *db.Pool
	if err := nilPool.Close(); err != nil {
		t.Fatalf("nilPool.Close: %v", err)
	}
}

func assertSQLitePragmas(t *testing.T, ctx context.Context, conn *sql.DB, wantJournal string, wantBusy int, wantFK int, wantSync int) {
	t.Helper()
	var journal string
	if err := conn.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journal); err != nil {
		t.Fatalf("PRAGMA journal_mode: %v", err)
	}
	if strings.ToLower(journal) != wantJournal {
		t.Fatalf("journal_mode = %q, want %q", journal, wantJournal)
	}
	var busy int
	if err := conn.QueryRowContext(ctx, "PRAGMA busy_timeout").Scan(&busy); err != nil {
		t.Fatalf("PRAGMA busy_timeout: %v", err)
	}
	if busy != wantBusy {
		t.Fatalf("busy_timeout = %d, want %d", busy, wantBusy)
	}
	var fk int
	if err := conn.QueryRowContext(ctx, "PRAGMA foreign_keys").Scan(&fk); err != nil {
		t.Fatalf("PRAGMA foreign_keys: %v", err)
	}
	if fk != wantFK {
		t.Fatalf("foreign_keys = %d, want %d", fk, wantFK)
	}
	var syncMode int
	if err := conn.QueryRowContext(ctx, "PRAGMA synchronous").Scan(&syncMode); err != nil {
		t.Fatalf("PRAGMA synchronous: %v", err)
	}
	if syncMode != wantSync {
		t.Fatalf("synchronous = %d, want %d", syncMode, wantSync)
	}
}

func TestPlatformMigrationsUpStatusDownAllUp(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	dsns := []struct {
		name string
		dsn  string
	}{
		{name: "memory", dsn: ":memory:"},
		{name: "wal_file", dsn: filepath.Join(t.TempDir(), "state", "platform.db")},
	}

	wantModules := db.OrderedModules()
	wantTables := []string{
		"durable_conversation", "durable_entry", "durable_document", "durable_submission", "durable_task", "durable_signal",
		"vault_secret",
		"agent_profile", "agent_skill", "agent_runtime",
		"repo_repository", "repo_worktree",
		"game_ledger",
		"issue", "issue_cron",
		"channel", "channel_member", "channel_event", "channel_read_cursor",
		"watch_cursor", "watch_seat", "watch_agent_home", "watch_brake_state", "watch_inbox",
		"memory_heads", "memory_versions", "memory_version_files", "memory_conflicts", "memory_dreams", "memory_inbox",
		"pkm_notes", "pkm_aliases", "pkm_blocks", "pkm_links", "pkm_notes_fts", "vector_storage", "_vec_pkm_vectors", "pkm_vectors",
		"gateway_kv", "gateway_issue", "gateway_channel", "gateway_agent", "gateway_template",
		"gateway_runtime", "gateway_cron", "gateway_artifact", "gateway_library_item",
		"gateway_media_input", "gateway_media_job", "gateway_pkm_page", "gateway_pkm_comment",
		"gateway_pkm_clip", "gateway_session", "gateway_session_event", "gateway_request_key",
	}
	wantTriggers := []string{"channel_event_no_update", "channel_event_no_delete"}

	for _, tc := range dsns {
		t.Run(tc.name, func(t *testing.T) {
			pool, err := db.OpenPool(ctx, tc.dsn)
			if err != nil {
				t.Fatalf("OpenPool: %v", err)
			}
			defer func() { _ = pool.Close() }()

			runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
			if err != nil {
				t.Fatalf("migrate.New: %v", err)
			}

			applied, err := runner.Up(ctx)
			if err != nil || applied != 11 {
				t.Fatalf("Up = (%d, %v), want (11, nil)", applied, err)
			}
			if again, err := runner.Up(ctx); err != nil || again != 0 {
				t.Fatalf("idempotent Up = (%d, %v), want (0, nil)", again, err)
			}

			statuses, err := runner.Status(ctx)
			if err != nil || len(statuses) != 11 {
				t.Fatalf("Status = (%d entries, %v), want 11 entries", len(statuses), err)
			}
			for i, st := range statuses {
				if st.Scope != db.PlatformScope || !st.Applied || st.Version != int64(i+1) || st.Name != wantModules[i] {
					t.Fatalf("status[%d] = %+v, want scope=%q version=%d name=%q applied=true", i, st, db.PlatformScope, i+1, wantModules[i])
				}
			}

			assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, "table", wantTables)
			assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, "trigger", wantTriggers)

			reverted, err := runner.DownAll(ctx)
			if err != nil || reverted != 11 {
				t.Fatalf("DownAll = (%d, %v), want (11, nil)", reverted, err)
			}

			statusesDown, err := runner.Status(ctx)
			if err != nil || len(statusesDown) != 11 {
				t.Fatalf("Status after DownAll = (%d, %v)", len(statusesDown), err)
			}
			for i, st := range statusesDown {
				if st.Applied {
					t.Fatalf("status[%d] unexpectedly applied after DownAll: %+v", i, st)
				}
			}
			assertZeroNonTrackingObjects(t, ctx, pool.WriteDB)

			reApplied, err := runner.Up(ctx)
			if err != nil || reApplied != 11 {
				t.Fatalf("re-Up = (%d, %v), want (11, nil)", reApplied, err)
			}
			assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, "table", wantTables)
			assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, "trigger", wantTriggers)
		})
	}
}

func TestOrderedModulesAndScopeFS(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	wantOrder := []string{
		"durable", "vault", "agent", "repo", "game", "issue",
		"channel", "watch", "memory", "pkm", "gateway",
	}
	gotOrder := db.OrderedModules()
	if !slices.Equal(gotOrder, wantOrder) {
		t.Fatalf("OrderedModules() = %v, want %v", gotOrder, wantOrder)
	}

	gotOrder[0] = "mutated"
	if gotAgain := db.OrderedModules(); !slices.Equal(gotAgain, wantOrder) {
		t.Fatalf("OrderedModules() returned shared slice: %v", gotAgain)
	}

	for _, invalid := range []string{"", "unknown", " durable", "durable ", "0001_durable"} {
		if _, err := db.ScopeFS(invalid); err == nil {
			t.Fatalf("ScopeFS(%q) expected error, got nil", invalid)
		}
	}

	for _, mod := range wantOrder {
		t.Run(mod, func(t *testing.T) {
			scopeFS, err := db.ScopeFS(mod)
			if err != nil {
				t.Fatalf("ScopeFS(%q): %v", mod, err)
			}

			downRel := "migrations/0001_" + mod + ".down.sql"
			upRel := "migrations/0001_" + mod + ".up.sql"
			if err := fstest.TestFS(scopeFS, downRel, upRel); err != nil {
				t.Fatalf("fstest.TestFS(%q): %v", mod, err)
			}

			entries, err := fs.ReadDir(scopeFS, "migrations")
			if err != nil || len(entries) != 2 {
				t.Fatalf("ReadDir(%q/migrations) = (%d, %v)", mod, len(entries), err)
			}

			pool, err := db.OpenPool(ctx, ":memory:")
			if err != nil {
				t.Fatalf("OpenPool: %v", err)
			}
			defer func() { _ = pool.Close() }()

			runner, err := migrate.New(pool.WriteDB, mod, scopeFS)
			if err != nil {
				t.Fatalf("migrate.New(%q): %v", mod, err)
			}
			if n, err := runner.Up(ctx); err != nil || n != 1 {
				t.Fatalf("%s Up = (%d, %v), want (1, nil)", mod, n, err)
			}
			statuses, err := runner.Status(ctx)
			if err != nil || len(statuses) != 1 || !statuses[0].Applied || statuses[0].Name != mod {
				t.Fatalf("%s Status = %+v (err=%v)", mod, statuses, err)
			}
			if n, err := runner.DownAll(ctx); err != nil || n != 1 {
				t.Fatalf("%s DownAll = (%d, %v), want (1, nil)", mod, n, err)
			}
			assertZeroNonTrackingObjects(t, ctx, pool.WriteDB)
			if n, err := runner.Up(ctx); err != nil || n != 1 {
				t.Fatalf("%s re-Up = (%d, %v), want (1, nil)", mod, n, err)
			}
		})
	}
}

func TestGeneratedQueriesAndVectorSearch(t *testing.T) {
	t.Parallel()
	ctx := context.Background()

	dbPath := filepath.Join(t.TempDir(), "db", "platform.db")
	pool, err := db.OpenPool(ctx, dbPath)
	if err != nil {
		t.Fatalf("OpenPool: %v", err)
	}
	defer func() { _ = pool.Close() }()

	runner, err := migrate.New(pool.WriteDB, db.PlatformScope, db.MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New: %v", err)
	}
	if _, err := runner.Up(ctx); err != nil {
		t.Fatalf("Up: %v", err)
	}

	qWrite := generated.New(pool.WriteDB)
	qRead := generated.New(pool.ReadDB)

	// Verify emit_empty_slices: true produces non-nil empty slices.
	emptyTasks, err := qRead.ListTasksByOwner(ctx, "owner-none")
	if err != nil {
		t.Fatalf("ListTasksByOwner: %v", err)
	}
	if emptyTasks == nil || len(emptyTasks) != 0 {
		t.Fatalf("expected non-nil empty slice, got %#v", emptyTasks)
	}

	// Verify durable write + read queries across WriteDB and ReadDB.
	if err := qWrite.InsertConversation(ctx, generated.InsertConversationParams{
		ID:               "conv-1",
		OwnerTaskID:      "task-1",
		ParentID:         "",
		ForkEntrySeq:     0,
		HeadSeq:          1,
		NextSeq:          2,
		ProviderAffinity: "anthropic",
		MetadataJson:     "{}",
		CreatedAtMs:      100,
		UpdatedAtMs:      100,
	}); err != nil {
		t.Fatalf("InsertConversation: %v", err)
	}
	if err := qWrite.InsertEntry(ctx, generated.InsertEntryParams{
		ConversationID: "conv-1",
		Seq:            1,
		Kind:           "user",
		PayloadJson:    `{"text":"hello"}`,
		CreatedAtMs:    101,
	}); err != nil {
		t.Fatalf("InsertEntry: %v", err)
	}

	conv, err := qRead.GetConversation(ctx, "conv-1")
	if err != nil {
		t.Fatalf("GetConversation via ReadDB: %v", err)
	}
	if conv.ID != "conv-1" || conv.OwnerTaskID != "task-1" || conv.ProviderAffinity != "anthropic" {
		t.Fatalf("unexpected conversation: %+v", conv)
	}
	entries, err := qRead.ListEntriesFrom(ctx, generated.ListEntriesFromParams{
		ConversationID: "conv-1",
		Seq:            1,
	})
	if err != nil || len(entries) != 1 || entries[0].PayloadJson != `{"text":"hello"}` {
		t.Fatalf("ListEntriesFrom via ReadDB = (%+v, %v)", entries, err)
	}

	// Verify emit_prepared_queries: true works cleanly against the unified schema.
	prepWrite, err := generated.Prepare(ctx, pool.WriteDB)
	if err != nil {
		t.Fatalf("generated.Prepare(WriteDB): %v", err)
	}
	defer func() {
		if err := prepWrite.Close(); err != nil {
			t.Fatalf("prepWrite.Close: %v", err)
		}
	}()
	maxSeq, err := prepWrite.ReadMaxSignalInsertSeq(ctx)
	if err != nil || maxSeq != 0 {
		t.Fatalf("ReadMaxSignalInsertSeq = (%d, %v), want (0, nil)", maxSeq, err)
	}

	// Verify sqlite-vec writes on WriteDB and vector search + vec_cosine on ReadDB.
	const datasetID = "db-foundation-test"
	t.Cleanup(func() {
		vec.InvalidateCache("pkm_vectors", datasetID)
	})

	embA, err := vector.EncodeEmbedding([]float32{1, 0, 0, 0})
	if err != nil {
		t.Fatalf("EncodeEmbedding A: %v", err)
	}
	embB, err := vector.EncodeEmbedding([]float32{0, 1, 0, 0})
	if err != nil {
		t.Fatalf("EncodeEmbedding B: %v", err)
	}

	if err := prepWrite.UpsertVector(ctx, generated.UpsertVectorParams{
		DatasetID: datasetID,
		ID:        "note-a",
		Content:   sql.NullString{String: "alpha", Valid: true},
		Meta:      sql.NullString{String: `{"tier":"project"}`, Valid: true},
		Embedding: embA,
	}); err != nil {
		t.Fatalf("UpsertVector A: %v", err)
	}
	if err := prepWrite.UpsertVector(ctx, generated.UpsertVectorParams{
		DatasetID: datasetID,
		ID:        "note-b",
		Content:   sql.NullString{String: "beta", Valid: true},
		Meta:      sql.NullString{String: `{"tier":"area"}`, Valid: true},
		Embedding: embB,
	}); err != nil {
		t.Fatalf("UpsertVector B: %v", err)
	}
	vec.InvalidateCache("pkm_vectors", datasetID)

	matches, err := vec.Search(ctx, pool.ReadDB, "pkm_vectors", datasetID, []float32{0.99, 0.01, 0, 0})
	if err != nil {
		t.Fatalf("vec.Search via ReadDB: %v", err)
	}
	if len(matches) < 2 || matches[0].ID != "note-a" {
		t.Fatalf("unexpected vec.Search matches: %+v", matches)
	}

	qBlob, err := vector.EncodeEmbedding([]float32{1, 0, 0, 0})
	if err != nil {
		t.Fatalf("EncodeEmbedding query: %v", err)
	}
	var cos float64
	if err := pool.ReadDB.QueryRowContext(
		ctx,
		`SELECT vec_cosine(embedding, ?) FROM _vec_pkm_vectors WHERE dataset_id = ? AND id = ?`,
		qBlob, datasetID, "note-a",
	).Scan(&cos); err != nil {
		t.Fatalf("vec_cosine via ReadDB: %v", err)
	}
	if math.Abs(cos-1.0) > 1e-6 {
		t.Fatalf("vec_cosine = %v, want 1.0", cos)
	}
}

func assertSQLiteObjectsPresent(t *testing.T, ctx context.Context, conn *sql.DB, objType string, names []string) {
	t.Helper()
	for _, name := range names {
		var found string
		err := conn.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = ? AND name = ?`, objType, name).Scan(&found)
		if err != nil {
			t.Fatalf("expected %s %q in sqlite_master: %v", objType, name, err)
		}
	}
}

func assertZeroNonTrackingObjects(t *testing.T, ctx context.Context, conn *sql.DB) {
	t.Helper()
	rows, err := conn.QueryContext(ctx, `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'trigger')`)
	if err != nil {
		t.Fatalf("query sqlite_master: %v", err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var name, objType string
		if err := rows.Scan(&name, &objType); err != nil {
			t.Fatalf("scan sqlite_master: %v", err)
		}
		if name == "schema_migrations" || strings.HasPrefix(name, "sqlite_") {
			continue
		}
		t.Fatalf("unexpected %s %q remaining after DownAll", objType, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("iterate sqlite_master: %v", err)
	}
}
