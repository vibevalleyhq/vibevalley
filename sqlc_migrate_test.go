package vibevalley_test

import (
	"bufio"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
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

	"github.com/vibevalleyhq/vibevalley/internal/config"
	pkgdb "github.com/vibevalleyhq/vibevalley/pkg/db"
	"github.com/vibevalleyhq/vibevalley/pkg/migrate"
)

func TestSQLCMigrationsAndConfigCLI(t *testing.T) {
	t.Parallel()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()

	// 1. Verify root sqlc.yaml has a single unified pkg/db block covering all 11 query and migration files.
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
	if len(rawSQLBlocks) != 1 {
		t.Fatalf("sqlc.yaml must have exactly 1 unified sql block, got %d", len(rawSQLBlocks))
	}

	block, ok := rawSQLBlocks[0].(map[string]any)
	if !ok {
		t.Fatalf("sqlc.yaml sql[0] is %T, want mapping", rawSQLBlocks[0])
	}
	if eng, _ := block["engine"].(string); eng != "sqlite" {
		t.Fatalf("sqlc.yaml sql[0].engine = %q, want sqlite", eng)
	}
	if queriesPath, _ := block["queries"].(string); queriesPath != "pkg/db/queries" {
		t.Fatalf("sqlc.yaml sql[0].queries = %q, want %q", queriesPath, "pkg/db/queries")
	}
	if schemaPath, _ := block["schema"].(string); schemaPath != "pkg/db/migrations" {
		t.Fatalf("sqlc.yaml sql[0].schema = %q, want %q", schemaPath, "pkg/db/migrations")
	}
	genMap, _ := block["gen"].(map[string]any)
	goMap, _ := genMap["go"].(map[string]any)
	if pkgName, _ := goMap["package"].(string); pkgName != "generated" {
		t.Fatalf("sqlc.yaml sql[0].gen.go.package = %q, want generated", pkgName)
	}
	if outDir, _ := goMap["out"].(string); outDir != "pkg/db/generated" {
		t.Fatalf("sqlc.yaml sql[0].gen.go.out = %q, want %q", outDir, "pkg/db/generated")
	}
	if emitEmpty, _ := goMap["emit_empty_slices"].(bool); !emitEmpty {
		t.Fatal("sqlc.yaml sql[0].gen.go.emit_empty_slices must be true")
	}
	if emitPrep, _ := goMap["emit_prepared_queries"].(bool); !emitPrep {
		t.Fatal("sqlc.yaml sql[0].gen.go.emit_prepared_queries must be true")
	}

	verifyMigrationPairsOnDisk(t, "pkg/db/migrations")
	orderedModules := pkgdb.OrderedModules()
	if len(orderedModules) != 11 {
		t.Fatalf("pkgdb.OrderedModules() len = %d, want 11", len(orderedModules))
	}
	for i, mod := range orderedModules {
		qFile := filepath.Join("pkg/db/queries", mod+".sql")
		if _, err := os.Stat(qFile); err != nil {
			t.Fatalf("missing query file %s: %v", qFile, err)
		}
		prefix := fmt.Sprintf("%04d_%s", i+1, mod)
		for _, suffix := range []string{".up.sql", ".down.sql"} {
			migFile := filepath.Join("pkg/db/migrations", prefix+suffix)
			if _, err := os.Stat(migFile); err != nil {
				t.Fatalf("missing migration file %s: %v", migFile, err)
			}
		}
	}

	// 2. Run full SQLite Up -> Status -> DownAll -> Up on unified pkg/db and test pkgdb.ScopeFS per module.
	expectedTables := []string{
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
		"gateway_kv", "gateway_issue", "gateway_channel", "gateway_agent",
		"gateway_template", "gateway_runtime", "gateway_cron", "gateway_artifact",
		"gateway_library_item", "gateway_media_input", "gateway_media_job",
		"gateway_pkm_page", "gateway_pkm_comment", "gateway_pkm_clip",
		"gateway_session", "gateway_session_event", "gateway_request_key",
	}
	expectedTriggers := []string{"channel_event_no_update", "channel_event_no_delete"}

	tmpMigDir := t.TempDir()
	unifiedDBPath := filepath.Join(tmpMigDir, "platform.db")
	pool, err := pkgdb.OpenPool(ctx, unifiedDBPath)
	if err != nil {
		t.Fatalf("pkgdb.OpenPool(%s): %v", unifiedDBPath, err)
	}
	defer func() { _ = pool.Close() }()

	runner, err := migrate.New(pool.WriteDB, pkgdb.PlatformScope, pkgdb.MigrationsFS)
	if err != nil {
		t.Fatalf("migrate.New(%s): %v", pkgdb.PlatformScope, err)
	}

	applied, err := runner.Up(ctx)
	if err != nil || applied != 11 {
		t.Fatalf("%s Up: applied=%d want=11 err=%v", pkgdb.PlatformScope, applied, err)
	}
	if again, err := runner.Up(ctx); err != nil || again != 0 {
		t.Fatalf("%s idempotent Up: applied=%d err=%v", pkgdb.PlatformScope, again, err)
	}

	statuses, err := runner.Status(ctx)
	if err != nil || len(statuses) != 11 {
		t.Fatalf("%s Status after Up: len=%d err=%v", pkgdb.PlatformScope, len(statuses), err)
	}
	for i, st := range statuses {
		if !st.Applied || st.Scope != pkgdb.PlatformScope || st.Version != int64(i+1) || st.Name != orderedModules[i] {
			t.Fatalf("%s Status[%d] = %+v, want scope=%q version=%d name=%q applied=true",
				pkgdb.PlatformScope, i, st, pkgdb.PlatformScope, i+1, orderedModules[i])
		}
	}

	assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, pkgdb.PlatformScope, "table", expectedTables)
	assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, pkgdb.PlatformScope, "trigger", expectedTriggers)

	reverted, err := runner.DownAll(ctx)
	if err != nil || reverted != 11 {
		t.Fatalf("%s DownAll: reverted=%d want=11 err=%v", pkgdb.PlatformScope, reverted, err)
	}
	statusesDown, err := runner.Status(ctx)
	if err != nil || len(statusesDown) != 11 {
		t.Fatalf("%s Status after DownAll: len=%d err=%v", pkgdb.PlatformScope, len(statusesDown), err)
	}
	for _, st := range statusesDown {
		if st.Applied {
			t.Fatalf("%s Status expected unapplied after DownAll: %+v", pkgdb.PlatformScope, st)
		}
	}
	assertZeroNonTrackingObjects(t, ctx, pool.WriteDB, pkgdb.PlatformScope)

	reApplied, err := runner.Up(ctx)
	if err != nil || reApplied != 11 {
		t.Fatalf("%s re-Up after DownAll: applied=%d want=11 err=%v", pkgdb.PlatformScope, reApplied, err)
	}
	assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, pkgdb.PlatformScope, "table", expectedTables)
	assertSQLiteObjectsPresent(t, ctx, pool.ReadDB, pkgdb.PlatformScope, "trigger", expectedTriggers)

	for _, mod := range orderedModules {
		scopeFS, err := pkgdb.ScopeFS(mod)
		if err != nil {
			t.Fatalf("pkgdb.ScopeFS(%q): %v", mod, err)
		}
		migs, err := migrate.ParseFS(scopeFS, "migrations")
		if err != nil || len(migs) != 1 {
			t.Fatalf("migrate.ParseFS(ScopeFS(%q)): migs=%d err=%v", mod, len(migs), err)
		}
		modPool, err := pkgdb.OpenPool(ctx, ":memory:")
		if err != nil {
			t.Fatalf("OpenPool(%q): %v", mod, err)
		}
		modRunner, err := migrate.New(modPool.WriteDB, mod, scopeFS)
		if err != nil {
			_ = modPool.Close()
			t.Fatalf("migrate.New(ScopeFS(%q)): %v", mod, err)
		}
		if n, err := modRunner.Up(ctx); err != nil || n != 1 {
			_ = modPool.Close()
			t.Fatalf("ScopeFS(%q) Up: applied=%d err=%v", mod, n, err)
		}
		if n, err := modRunner.DownAll(ctx); err != nil || n != 1 {
			_ = modPool.Close()
			t.Fatalf("ScopeFS(%q) DownAll: reverted=%d err=%v", mod, n, err)
		}
		assertZeroNonTrackingObjects(t, ctx, modPool.WriteDB, "ScopeFS("+mod+")")
		if n, err := modRunner.Up(ctx); err != nil || n != 1 {
			_ = modPool.Close()
			t.Fatalf("ScopeFS(%q) re-Up: applied=%d err=%v", mod, n, err)
		}
		_ = modPool.Close()
	}

	// 3. Scan pkg/db, internal/durable/store, internal/vault, and internal/domain/* for forbidden raw DDL
	// and assert zero leftover sqlcgen/, queries.sql, migrations/, migrations.go, or gatewaymigrations/ under internal/.
	forbiddenDDL := []string{"CREATE TABLE", "CREATE VIRTUAL TABLE", "CREATE TRIGGER"}
	scanRoots := []string{
		"pkg/db",
		"internal/durable/store",
		"internal/vault",
		"internal/domain",
	}
	for _, root := range scanRoots {
		err := filepath.WalkDir(root, func(path string, d fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if d.IsDir() {
				if root == "pkg/db" && filepath.ToSlash(path) == "pkg/db/generated" {
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
			// internal/vault/sqlstore.go retains SchemaStatements strictly for DialectPostgres; SQLite uses pkg/db.ScopeFS("vault").
			if filepath.ToSlash(path) == "internal/vault/sqlstore.go" {
				for _, kw := range []string{"CREATE VIRTUAL TABLE", "CREATE TRIGGER"} {
					if strings.Contains(upper, kw) {
						t.Errorf("non-generated store file %s contains %q", path, kw)
					}
				}
				if strings.Count(upper, "CREATE TABLE") > 1 {
					t.Errorf("internal/vault/sqlstore.go contains unexpected extra CREATE TABLE outside SchemaStatements")
				}
				return nil
			}
			for _, kw := range forbiddenDDL {
				if strings.Contains(upper, kw) {
					t.Errorf("non-generated store file %s still contains %q", path, kw)
				}
			}
			return nil
		})
		if err != nil {
			t.Fatalf("scan %s: %v", root, err)
		}
	}

	forbiddenInternalNames := map[string]bool{
		"sqlcgen":           true,
		"queries.sql":       true,
		"migrations":        true,
		"migrations.go":     true,
		"gatewaymigrations": true,
	}
	if err := filepath.WalkDir("internal", func(path string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if forbiddenInternalNames[d.Name()] {
			t.Errorf("leftover per-package SQLite artifact under internal/: %s", path)
		}
		return nil
	}); err != nil {
		t.Fatalf("walk internal/: %v", err)
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
	dbDir := filepath.Join(tmpCLI, "data")
	dbPath := filepath.Join(dbDir, "platform.db")
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
	if err != nil || !strings.Contains(migUpOut, "scope=platform") || !strings.Contains(migUpOut, "after=11") || !strings.Contains(migUpOut, "applied=11") {
		t.Fatalf("vibe-server migrate up failed: err=%v out=%q", err, migUpOut)
	}

	migStatusOut, err := runCLI(ctx, serverBin, cliEnv, "migrate", "status")
	if err != nil || strings.Count(migStatusOut, "scope=platform") != 11 || strings.Count(migStatusOut, "applied=true") != 11 {
		t.Fatalf("vibe-server migrate status failed: err=%v out=%q", err, migStatusOut)
	}

	migDownOut, err := runCLI(ctx, serverBin, cliEnv, "migrate", "down", "--all")
	if err != nil || !strings.Contains(migDownOut, "scope=platform") || !strings.Contains(migDownOut, "after=0") || !strings.Contains(migDownOut, "reverted=11") {
		t.Fatalf("vibe-server migrate down --all failed: err=%v out=%q", err, migDownOut)
	}

	migReUpOut, err := runCLI(ctx, serverBin, cliEnv, "migrate", "up")
	if err != nil || !strings.Contains(migReUpOut, "scope=platform") || !strings.Contains(migReUpOut, "after=11") || !strings.Contains(migReUpOut, "applied=11") {
		t.Fatalf("vibe-server migrate re-up failed: err=%v out=%q", err, migReUpOut)
	}

	sidecars, globErr := filepath.Glob(filepath.Join(dbDir, "platform.*.db*"))
	if globErr != nil {
		t.Fatalf("glob sidecar dbs: %v", globErr)
	}
	if len(sidecars) != 0 {
		t.Fatalf("expected zero sidecar DB files alongside %s, found %v", dbPath, sidecars)
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

	sidecarsAfterServe, globErr := filepath.Glob(filepath.Join(dbDir, "platform.*.db*"))
	if globErr != nil {
		t.Fatalf("glob sidecar dbs after serve: %v", globErr)
	}
	if len(sidecarsAfterServe) != 0 {
		t.Fatalf("expected zero sidecar DB files alongside %s after serve, found %v", dbPath, sidecarsAfterServe)
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
