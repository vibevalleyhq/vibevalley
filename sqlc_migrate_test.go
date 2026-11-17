package vibevalley_test

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"
	"time"

	koanfyaml "github.com/knadh/koanf/parsers/yaml"
	"github.com/viant/sqlite-vec/engine"
	"github.com/viant/sqlite-vec/vec"
	_ "modernc.org/sqlite"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/domain/agent"
	"github.com/vibevalleyhq/vibevalley/internal/domain/channel"
	"github.com/vibevalleyhq/vibevalley/internal/domain/game"
	"github.com/vibevalleyhq/vibevalley/internal/domain/gateway"
	"github.com/vibevalleyhq/vibevalley/internal/domain/issue"
	"github.com/vibevalleyhq/vibevalley/internal/domain/memory"
	"github.com/vibevalleyhq/vibevalley/internal/domain/pkm"
	"github.com/vibevalleyhq/vibevalley/internal/domain/repo"
	"github.com/vibevalleyhq/vibevalley/internal/domain/stack"
	domainwatch "github.com/vibevalleyhq/vibevalley/internal/domain/watch"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/vault"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func TestSQLCMigrationsAndConfigCLI(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 1. Verify root sqlc.yaml covers all 11 SQL modules and matching .up.sql/.down.sql scripts.
	sqlcBytes, err := os.ReadFile("sqlc.yaml")
	if err != nil {
		t.Fatalf("read root sqlc.yaml: %v", err)
	}
	parsedYAML, err := koanfyaml.Parser().Unmarshal(sqlcBytes)
	if err != nil {
		t.Fatalf("parse root sqlc.yaml: %v", err)
	}
	if ver, _ := parsedYAML["version"].(string); ver != "2" {
		t.Fatalf("sqlc.yaml version = %v, want \"2\"", parsedYAML["version"])
	}
	rawSQLBlocks, ok := parsedYAML["sql"].([]any)
	if !ok {
		t.Fatalf("sqlc.yaml sql section has unexpected type %T", parsedYAML["sql"])
	}

	expectedPackages := []string{
		"internal/durable/store",
		"internal/vault",
		"internal/domain/agent",
		"internal/domain/repo",
		"internal/domain/game",
		"internal/domain/issue",
		"internal/domain/channel",
		"internal/domain/watch",
		"internal/domain/memory",
		"internal/domain/pkm",
		"internal/domain/gateway",
	}

	configuredOutDirs := make(map[string]map[string]any, len(rawSQLBlocks))
	for i, item := range rawSQLBlocks {
		block, ok := item.(map[string]any)
		if !ok {
			t.Fatalf("sqlc.yaml sql[%d] is %T, want mapping", i, item)
		}
		if eng, _ := block["engine"].(string); eng != "sqlite" {
			t.Fatalf("sqlc.yaml sql[%d].engine = %q, want sqlite", i, eng)
		}
		schemaPath, _ := block["schema"].(string)
		queriesPath, _ := block["queries"].(string)
		genMap, _ := block["gen"].(map[string]any)
		goMap, _ := genMap["go"].(map[string]any)
		outDir, _ := goMap["out"].(string)
		pkgName, _ := goMap["package"].(string)
		if pkgName != "sqlcgen" {
			t.Fatalf("sqlc.yaml sql[%d].gen.go.package = %q, want sqlcgen", i, pkgName)
		}
		if _, err := os.Stat(queriesPath); err != nil {
			t.Fatalf("sqlc.yaml sql[%d] queries missing (%q): %v", i, queriesPath, err)
		}
		verifyMigrationPairsOnDisk(t, schemaPath)
		pkgRoot := filepath.ToSlash(filepath.Dir(outDir))
		configuredOutDirs[pkgRoot] = goMap
	}

	for _, pkg := range expectedPackages {
		goMap, exists := configuredOutDirs[pkg]
		if !exists {
			t.Fatalf("sqlc.yaml missing SQL package %q", pkg)
		}
		if pkg == "internal/domain/memory" || pkg == "internal/domain/pkm" || pkg == "internal/domain/gateway" {
			if emitEmpty, _ := goMap["emit_empty_slices"].(bool); !emitEmpty {
				t.Fatalf("sqlc.yaml for %q must set emit_empty_slices: true", pkg)
			}
		}
		if pkg == "internal/domain/pkm" {
			if emitPrep, _ := goMap["emit_prepared_queries"].(bool); !emitPrep {
				t.Fatalf("sqlc.yaml for %q must set emit_prepared_queries: true", pkg)
			}
		}
	}

	// 2. ParseFS and run full SQLite Up -> Status -> DownAll -> Up on all 11 MigrationsFS variables.
	type moduleSpec struct {
		scope            string
		fsys             fs.FS
		useVec           bool
		expectedTables   []string
		expectedTriggers []string
	}
	modules := []moduleSpec{
		{
			scope:          "durable",
			fsys:           store.MigrationsFS,
			expectedTables: []string{"durable_conversation", "durable_entry", "durable_document", "durable_submission", "durable_task", "durable_signal"},
		},
		{
			scope:          "vault",
			fsys:           vault.MigrationsFS,
			expectedTables: []string{"vault_secret"},
		},
		{
			scope:          "agent",
			fsys:           agent.MigrationsFS,
			expectedTables: []string{"agent_profile", "agent_skill", "agent_runtime"},
		},
		{
			scope:          "repo",
			fsys:           repo.MigrationsFS,
			expectedTables: []string{"repo_repository", "repo_worktree"},
		},
		{
			scope:          "game",
			fsys:           game.MigrationsFS,
			expectedTables: []string{"game_ledger"},
		},
		{
			scope:          "issue",
			fsys:           issue.MigrationsFS,
			expectedTables: []string{"issue", "issue_cron"},
		},
		{
			scope:            "channel",
			fsys:             channel.MigrationsFS,
			expectedTables:   []string{"channel", "channel_member", "channel_event", "channel_read_cursor"},
			expectedTriggers: []string{"channel_event_no_update", "channel_event_no_delete"},
		},
		{
			scope:          "watch",
			fsys:           domainwatch.MigrationsFS,
			expectedTables: []string{"watch_cursor", "watch_seat", "watch_agent_home", "watch_brake_state", "watch_inbox"},
		},
		{
			scope:          "memory",
			fsys:           memory.MigrationsFS,
			expectedTables: []string{"memory_heads", "memory_versions", "memory_version_files", "memory_conflicts", "memory_dreams", "memory_inbox"},
		},
		{
			scope:          "pkm",
			fsys:           pkm.MigrationsFS,
			useVec:         true,
			expectedTables: []string{"pkm_notes", "pkm_aliases", "pkm_blocks", "pkm_links", "pkm_notes_fts", "vector_storage", "_vec_pkm_vectors", "pkm_vectors"},
		},
		{
			scope: "gateway",
			fsys:  gateway.MigrationsFS,
			expectedTables: []string{
				"gateway_kv", "gateway_issue", "gateway_channel", "gateway_agent",
				"gateway_template", "gateway_runtime", "gateway_cron", "gateway_artifact",
				"gateway_library_item", "gateway_media_input", "gateway_media_job",
				"gateway_pkm_page", "gateway_pkm_comment", "gateway_pkm_clip",
				"gateway_session", "gateway_session_event", "gateway_request_key",
			},
		},
	}
	for _, fname := range []string{"migrations/0001_init.up.sql", "migrations/0001_init.down.sql"} {
		gwBytes, gErr := fs.ReadFile(gateway.MigrationsFS, fname)
		stkBytes, sErr := fs.ReadFile(stack.GatewayMigrationsFS(), fname)
		if gErr != nil || sErr != nil || !bytes.Equal(gwBytes, stkBytes) {
			t.Fatalf("gateway/stack migration %s mismatch: gErr=%v sErr=%v equal=%t", fname, gErr, sErr, bytes.Equal(gwBytes, stkBytes))
		}
	}

	tmpMigDir := t.TempDir()
	for _, mod := range modules {
		migs, err := migrate.ParseFS(mod.fsys, "migrations")
		if err != nil || len(migs) == 0 {
			t.Fatalf("migrate.ParseFS(%s): migs=%d err=%v", mod.scope, len(migs), err)
		}

		dbPath := filepath.Join(tmpMigDir, mod.scope+".db")
		db := openTestSQLite(t, dbPath, mod.useVec)

		runner, err := migrate.New(db, mod.scope, mod.fsys)
		if err != nil {
			_ = db.Close()
			t.Fatalf("migrate.New(%s): %v", mod.scope, err)
		}

		applied, err := runner.Up(ctx)
		if err != nil || applied != len(migs) {
			_ = db.Close()
			t.Fatalf("%s Up: applied=%d want=%d err=%v", mod.scope, applied, len(migs), err)
		}
		if again, err := runner.Up(ctx); err != nil || again != 0 {
			_ = db.Close()
			t.Fatalf("%s idempotent Up: applied=%d err=%v", mod.scope, again, err)
		}

		statuses, err := runner.Status(ctx)
		if err != nil || len(statuses) != len(migs) {
			_ = db.Close()
			t.Fatalf("%s Status after Up: len=%d err=%v", mod.scope, len(statuses), err)
		}
		for _, st := range statuses {
			if !st.Applied || st.Scope != mod.scope {
				_ = db.Close()
				t.Fatalf("%s Status expected applied: %+v", mod.scope, st)
			}
		}

		assertSQLiteObjectsPresent(t, ctx, db, mod.scope, "table", mod.expectedTables)
		assertSQLiteObjectsPresent(t, ctx, db, mod.scope, "trigger", mod.expectedTriggers)

		reverted, err := runner.DownAll(ctx)
		if err != nil || reverted != len(migs) {
			_ = db.Close()
			t.Fatalf("%s DownAll: reverted=%d want=%d err=%v", mod.scope, reverted, len(migs), err)
		}
		statusesDown, err := runner.Status(ctx)
		if err != nil {
			_ = db.Close()
			t.Fatalf("%s Status after DownAll: %v", mod.scope, err)
		}
		for _, st := range statusesDown {
			if st.Applied {
				_ = db.Close()
				t.Fatalf("%s Status expected unapplied after DownAll: %+v", mod.scope, st)
			}
		}
		assertZeroNonTrackingObjects(t, ctx, db, mod.scope)

		reApplied, err := runner.Up(ctx)
		if err != nil || reApplied != len(migs) {
			_ = db.Close()
			t.Fatalf("%s re-Up after DownAll: applied=%d want=%d err=%v", mod.scope, reApplied, len(migs), err)
		}
		assertSQLiteObjectsPresent(t, ctx, db, mod.scope, "table", mod.expectedTables)
		assertSQLiteObjectsPresent(t, ctx, db, mod.scope, "trigger", mod.expectedTriggers)
		_ = db.Close()
	}

	// 3. Scan non-generated .go files in the 10 SQLite-only store packages for forbidden raw CREATE DDL.
	sqliteOnlyPackages := []string{
		"internal/durable/store",
		"internal/domain/agent",
		"internal/domain/repo",
		"internal/domain/game",
		"internal/domain/issue",
		"internal/domain/channel",
		"internal/domain/watch",
		"internal/domain/memory",
		"internal/domain/pkm",
		"internal/domain/gateway",
	}
	forbiddenDDL := []string{"CREATE TABLE", "CREATE VIRTUAL TABLE", "CREATE TRIGGER"}
	for _, pkgDir := range sqliteOnlyPackages {
		err := filepath.WalkDir(pkgDir, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				if d.Name() == "sqlcgen" {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(d.Name(), ".go") || strings.HasSuffix(d.Name(), "_test.go") {
				return nil
			}
			src, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			upper := strings.ToUpper(string(src))
			for _, kw := range forbiddenDDL {
				if strings.Contains(upper, kw) {
					t.Errorf("non-generated store file %s still contains %q", path, kw)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scan %s: %v", pkgDir, err)
		}
	}

	// 4. End-to-end vibe-server CLI subprocess test with VIBEVALLEY_HOME + vibevalley.yaml + env + flag overrides.
	tmpCLI := t.TempDir()
	binExt := ""
	if runtime.GOOS == "windows" {
		binExt = ".exe"
	}
	serverBin := filepath.Join(tmpCLI, "vibe-server"+binExt)
	goBin := filepath.Join(runtime.GOROOT(), "bin", "go")
	buildCmd := exec.CommandContext(ctx, goBin, "build", "-o", serverBin, "./cmd/vibe-server")
	buildCmd.Env = append(cleanCLIEnv(tmpCLI), "CGO_ENABLED=0", "GOROOT="+runtime.GOROOT())
	if out, err := buildCmd.CombinedOutput(); err != nil {
		t.Fatalf("build ./cmd/vibe-server: %v\n%s", err, string(out))
	}

	vibeHome := filepath.Join(tmpCLI, "vibe-home")
	workRoot := filepath.Join(tmpCLI, "work")
	dbPath := filepath.Join(tmpCLI, "data", "platform.db")
	yamlPath := filepath.Join(vibeHome, "vibevalley.yaml")
	if err := os.MkdirAll(vibeHome, 0o755); err != nil {
		t.Fatal(err)
	}
	yamlSecret := "sk-e2e-yaml-secret-9911"
	envSecret := "sk-e2e-env-secret-8822"
	mapSecret := "ghp-e2e-secret-token-7733"
	yamlContent := `
work_root: ` + workRoot + `
server:
  addr: 127.0.0.1:9876
  preview_addr: 127.0.0.1:9877
  db_path: ` + dbPath + `
deepseek:
  api_key: ` + yamlSecret + `
secrets:
  github_token: ` + mapSecret + `
`
	if err := os.WriteFile(yamlPath, []byte(yamlContent), 0o600); err != nil {
		t.Fatal(err)
	}

	cliEnv := append(cleanCLIEnv(vibeHome),
		"DEEPSEEK_API_KEY="+envSecret,
		"VIBE_PREVIEW_ADDR=127.0.0.1:0",
	)

	// config check
	chkOut, err := runCLI(ctx, serverBin, cliEnv, "config", "check")
	if err != nil || !strings.Contains(chkOut, "config ok:") || !strings.Contains(chkOut, yamlPath) {
		t.Fatalf("vibe-server config check failed: err=%v out=%q", err, chkOut)
	}

	// config print (asserts raw secrets are absent, redacted value present, and CLI/env overrides applied)
	printOut, err := runCLI(ctx, serverBin, cliEnv, "config", "print", "--addr", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("vibe-server config print failed: %v\n%s", err, printOut)
	}
	for _, secret := range []string{yamlSecret, envSecret, mapSecret} {
		if strings.Contains(printOut, secret) {
			t.Fatalf("vibe-server config print leaked raw secret %q:\n%s", secret, printOut)
		}
	}
	if !strings.Contains(printOut, config.RedactedValue) {
		t.Fatalf("vibe-server config print missing %q:\n%s", config.RedactedValue, printOut)
	}
	if !strings.Contains(printOut, "127.0.0.1:0") || !strings.Contains(printOut, dbPath) {
		t.Fatalf("vibe-server config print missing expected addr/db_path:\n%s", printOut)
	}

	// migrate up -> status -> down --all -> up (using db_path from vibevalley.yaml)
	migUpOut, err := runCLI(ctx, serverBin, cliEnv, "migrate", "up")
	if err != nil || strings.Count(migUpOut, "applied=1") != 11 {
		t.Fatalf("vibe-server migrate up failed: err=%v out=%q", err, migUpOut)
	}

	migStatusOut, err := runCLI(ctx, serverBin, cliEnv, "migrate", "status")
	if err != nil || strings.Count(migStatusOut, "applied=true") != 11 {
		t.Fatalf("vibe-server migrate status failed: err=%v out=%q", err, migStatusOut)
	}

	migDownOut, err := runCLI(ctx, serverBin, cliEnv, "migrate", "down", "--all")
	if err != nil || strings.Count(migDownOut, "reverted=1") != 11 {
		t.Fatalf("vibe-server migrate down --all failed: err=%v out=%q", err, migDownOut)
	}

	migReUpOut, err := runCLI(ctx, serverBin, cliEnv, "migrate", "up")
	if err != nil || strings.Count(migReUpOut, "applied=1") != 11 {
		t.Fatalf("vibe-server migrate re-up failed: err=%v out=%q", err, migReUpOut)
	}

	// serve --ready-json with CLI --addr override
	srvCmd := exec.CommandContext(ctx, serverBin, "serve", "--addr", "127.0.0.1:0", "--ready-json")
	srvCmd.Env = cliEnv
	stdoutPipe, err := srvCmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var srvErr bytes.Buffer
	srvCmd.Stderr = &srvErr
	if err := srvCmd.Start(); err != nil {
		t.Fatalf("start vibe-server serve: %v", err)
	}
	waitDone := make(chan struct{})
	var waitErr error
	go func() {
		waitErr = srvCmd.Wait()
		close(waitDone)
	}()
	defer func() {
		select {
		case <-waitDone:
		default:
			if srvCmd.Process != nil {
				_ = srvCmd.Process.Kill()
			}
			<-waitDone
		}
	}()

	readyCh := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdoutPipe)
		if sc.Scan() {
			readyCh <- sc.Text()
		}
	}()

	var ready struct {
		Addr        string `json:"addr"`
		PreviewAddr string `json:"preview_addr"`
	}
	select {
	case line := <-readyCh:
		if err := json.Unmarshal([]byte(line), &ready); err != nil {
			t.Fatalf("decode ready-json %q: %v", line, err)
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for serve --ready-json; stderr=%s", srvErr.String())
	}
	if ready.Addr == "" || ready.PreviewAddr == "" {
		t.Fatalf("expected non-empty addr and preview_addr, got %+v", ready)
	}

	resp, err := http.Get("http://" + ready.Addr + "/healthz")
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET /healthz status = %d", resp.StatusCode)
	}

	if runtime.GOOS != "windows" {
		if err := srvCmd.Process.Signal(os.Interrupt); err != nil {
			t.Fatalf("signal interrupt: %v", err)
		}
		select {
		case <-waitDone:
			if waitErr != nil {
				t.Fatalf("serve graceful shutdown error: %v (stderr=%s)", waitErr, srvErr.String())
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for serve graceful exit")
		}
	}
}

func verifyMigrationPairsOnDisk(t *testing.T, dir string) {
	t.Helper()
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read migrations dir %q: %v", dir, err)
	}
	ups := make(map[string]bool)
	downs := make(map[string]bool)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		switch {
		case strings.HasSuffix(name, ".up.sql"):
			ups[strings.TrimSuffix(name, ".up.sql")] = true
		case strings.HasSuffix(name, ".down.sql"):
			downs[strings.TrimSuffix(name, ".down.sql")] = true
		default:
			t.Fatalf("unexpected file %q in migrations dir %q", name, dir)
		}
	}
	if len(ups) == 0 {
		t.Fatalf("no .up.sql files found in %q", dir)
	}
	for stem := range ups {
		if !downs[stem] {
			t.Fatalf("missing matching .down.sql for %s.up.sql in %q", stem, dir)
		}
	}
	for stem := range downs {
		if !ups[stem] {
			t.Fatalf("missing matching .up.sql for %s.down.sql in %q", stem, dir)
		}
	}
}

func openTestSQLite(t *testing.T, dbPath string, useVec bool) *sql.DB {
	t.Helper()
	var (
		db  *sql.DB
		err error
	)
	if useVec {
		_ = engine.RegisterVectorFunctions(nil)
		db, err = engine.Open(dbPath)
		if err != nil {
			t.Fatalf("engine.Open %s: %v", dbPath, err)
		}
		if err := vec.Register(db); err != nil {
			_ = db.Close()
			t.Fatalf("vec.Register %s: %v", dbPath, err)
		}
	} else {
		db, err = sql.Open("sqlite", dbPath)
		if err != nil {
			t.Fatalf("sql.Open %s: %v", dbPath, err)
		}
	}
	db.SetMaxOpenConns(1)
	return db
}

func assertSQLiteObjectsPresent(t *testing.T, ctx context.Context, db *sql.DB, scope, objType string, names []string) {
	t.Helper()
	for _, name := range names {
		var found string
		err := db.QueryRowContext(ctx, `SELECT name FROM sqlite_master WHERE type = ? AND name = ?`, objType, name).Scan(&found)
		if err != nil {
			t.Fatalf("%s: expected %s %q in sqlite_master: %v", scope, objType, name, err)
		}
	}
}

func assertZeroNonTrackingObjects(t *testing.T, ctx context.Context, db *sql.DB, scope string) {
	t.Helper()
	rows, err := db.QueryContext(ctx, `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'trigger')`)
	if err != nil {
		t.Fatalf("%s: query sqlite_master: %v", scope, err)
	}
	defer func() { _ = rows.Close() }()

	for rows.Next() {
		var name, objType string
		if err := rows.Scan(&name, &objType); err != nil {
			t.Fatalf("%s: scan sqlite_master: %v", scope, err)
		}
		if name == "schema_migrations" || strings.HasPrefix(name, "sqlite_") {
			continue
		}
		t.Fatalf("%s: unexpected %s %q remaining after DownAll", scope, objType, name)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("%s: iterate sqlite_master: %v", scope, err)
	}
}

func cleanCLIEnv(vibeHome string) []string {
	strip := []string{
		"VIBEVALLEY_HOME",
		"VIBEVALLEY_WORK_ROOT",
		"VIBE_CONFIG",
		"VIBE_SERVER_ADDR",
		"VIBE_PREVIEW_ADDR",
		"VIBE_DB_PATH",
		"VIBE_ALLOW_LOOPBACK_EGRESS",
		"VIBE_SERVER_URL",
		"VIBE_MACHINE_ID",
		"VIBE_WEB_DIST",
		"MYGO_AUTOMATION",
		"DEEPSEEK_API_KEY",
		"GOROOT",
	}
	var out []string
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if slices.Contains(strip, key) {
			continue
		}
		out = append(out, entry)
	}
	return append(out, "VIBEVALLEY_HOME="+vibeHome)
}

func runCLI(ctx context.Context, bin string, env []string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Env = env
	out, err := cmd.CombinedOutput()
	return string(out), err
}
