package farm

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"vibevalley/internal/base"
)

type fakePrefs map[string][]byte

func (p fakePrefs) Export(domain string) ([]byte, error) { return p[domain], nil }

func (p fakePrefs) Import(domain string, plist []byte) error {
	p[domain] = plist
	return nil
}

func oldGit(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-c", "user.name=t", "-c", "user.email=t@vibevalley.test"}, args...)...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func TestMigrateOldNames(t *testing.T) {
	user := t.TempDir()
	support := filepath.Join(user, "Library", "Application Support")
	oldHome := filepath.Join(support, "heybro")
	oldWork := filepath.Join(user, "heybro-work")

	project := filepath.Join(oldWork, "clock-in")
	os.MkdirAll(project, 0o755)
	oldGit(t, project, "init", "-q", "-b", "main")
	oldGit(t, project, "commit", "-q", "--allow-empty", "-m", "first")
	tree := filepath.Join(oldWork, ".worktrees", "clock-in-w1")
	oldGit(t, project, "worktree", "add", "-q", "-b", "heybro/w1", tree)

	os.MkdirAll(oldHome, 0o755)
	db, err := base.OpenDB(filepath.Join(oldHome, "farm.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`insert into participants (id, kind, name, agent_id, runtime, joined_at) values ('w1', 'helper', '小吴', 'lab', 'heybro', 1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`insert into ledger (kind, at, payload) values ('hired', 1, ?)`, `{"runtime":"heybro","worktree":"`+tree+`"}`); err != nil {
		t.Fatal(err)
	}
	db.Close()
	os.WriteFile(filepath.Join(oldHome, "config.json"), []byte(`{"agents":[{"id":"lab","runtime":"heybro"}],"note":"heybro is a word"}`), 0o644)
	os.WriteFile(filepath.Join(oldHome, "farm.json"), []byte(`{"helpers":[{"id":"w1","worktree":"`+tree+`","branch":"heybro/w1"}]}`), 0o644)
	os.WriteFile(filepath.Join(oldHome, "settings.json"), []byte(`{"voice":{"llm":{"vendor":"heybro"}}}`), 0o600)
	os.WriteFile(filepath.Join(oldHome, ".env"), []byte("HEYBRO_FOREMAN_MODEL=x\nexport VIBEFARM_DB=memory\nDEEPSEEK_API_KEY=k\n"), 0o600)
	os.MkdirAll(filepath.Join(user, "Library", "Logs", "heybro"), 0o755)
	os.WriteFile(filepath.Join(user, "Library", "Logs", "heybro", "server.log"), []byte("log"), 0o644)

	os.MkdirAll(filepath.Join(user, ".heybro", "db"), 0o755)
	os.MkdirAll(filepath.Join(support, "heybro Alpha", "Cache"), 0o755)

	prefs := fakePrefs{"dev.heybro.flutter": []byte("<plist><dict><key>flutter.heybro.title.seen</key><true/><key>flutter.farm.choice</key><string>local</string></dict></plist>")}

	dry, err := MigrateOldNames(MigrateOptions{UserHome: user, DryRun: true, Prefs: prefs})
	if err != nil {
		t.Fatal(err)
	}
	if len(dry.Moves) != 3 || len(dry.Prefs) != 1 || dry.Backup != "" {
		t.Fatalf("dry run: %+v", dry)
	}
	if _, err := os.Stat(oldHome); err != nil {
		t.Fatal("a dry run moved something")
	}

	backup := filepath.Join(user, "backup")
	report, err := MigrateOldNames(MigrateOptions{UserHome: user, Backup: backup, Prefs: prefs})
	if err != nil {
		t.Fatal(err)
	}
	newHome := filepath.Join(support, "vibevalley")
	newWork := filepath.Join(user, "vibevalley-work")
	newTree := filepath.Join(newWork, ".worktrees", "clock-in-w1")
	for _, p := range []string{newHome, newWork, filepath.Join(user, "Library", "Logs", "vibevalley", "server.log")} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s did not arrive", p)
		}
	}
	for _, p := range []string{filepath.Join(user, ".heybro", "db"), filepath.Join(support, "heybro Alpha", "Cache")} {
		if _, err := os.Stat(p); err != nil {
			t.Fatalf("%s was moved", p)
		}
	}
	if len(report.Skipped) != 2 {
		t.Fatalf("skipped: %v", report.Skipped)
	}

	read := func(name string) string {
		body, err := os.ReadFile(filepath.Join(newHome, name))
		if err != nil {
			t.Fatal(err)
		}
		return string(body)
	}
	if got := read("config.json"); got != `{"agents":[{"id":"lab","runtime":"vibevalley"}],"note":"heybro is a word"}` {
		t.Fatalf("config.json: %s", got)
	}
	if got := read("farm.json"); got != `{"helpers":[{"id":"w1","worktree":"`+newTree+`","branch":"vibevalley/w1"}]}` {
		t.Fatalf("farm.json: %s", got)
	}
	if got := read("settings.json"); !strings.Contains(got, `"vendor":"vibevalley"`) {
		t.Fatalf("settings.json: %s", got)
	}
	if got := read(".env"); got != "VIBEVALLEY_FOREMAN_MODEL=x\nexport VIBEVALLEY_DB=memory\nDEEPSEEK_API_KEY=k\n" {
		t.Fatalf(".env: %q", got)
	}
	if info, _ := os.Stat(filepath.Join(newHome, ".env")); info.Mode().Perm() != 0o600 {
		t.Fatalf(".env mode: %v", info.Mode())
	}

	db, err = base.OpenDB(filepath.Join(newHome, "farm.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var runtime, payload string
	db.QueryRow(`select runtime from participants where id = 'w1'`).Scan(&runtime)
	db.QueryRow(`select payload from ledger`).Scan(&payload)
	if runtime != "vibevalley" || payload != `{"runtime":"vibevalley","worktree":"`+newTree+`"}` {
		t.Fatalf("database: %s, %s", runtime, payload)
	}

	if got := oldGit(t, newTree, "rev-parse", "--abbrev-ref", "HEAD"); got != "vibevalley/w1" {
		t.Fatalf("worktree: %s", got)
	}
	if got := oldGit(t, filepath.Join(newWork, "clock-in"), "worktree", "list"); !strings.Contains(got, newTree) || strings.Contains(got, "prunable") {
		t.Fatalf("worktree list: %s", got)
	}
	if len(report.Worktrees) != 1 || len(report.Branches) != 1 {
		t.Fatalf("worktrees: %v, branches: %v", report.Worktrees, report.Branches)
	}

	if got := prefs["dev.vibevalley.app"]; !bytes.Contains(got, []byte("<key>flutter.vibevalley.title.seen</key>")) || !bytes.Contains(got, []byte("<key>flutter.farm.choice</key>")) {
		t.Fatalf("preferences: %s", got)
	}

	if body, err := os.ReadFile(filepath.Join(backup, "0-heybro", "config.json")); err != nil || !strings.Contains(string(body), `"runtime":"heybro"`) {
		t.Fatalf("backup: %s %v", body, err)
	}
	if _, err := os.Stat(filepath.Join(backup, "dev.heybro.flutter.plist")); err != nil {
		t.Fatal("the preferences were not backed up")
	}

	again, err := MigrateOldNames(MigrateOptions{UserHome: user, Backup: filepath.Join(user, "backup2"), Prefs: prefs})
	if err != nil || len(again.Moves) != 0 || len(again.Prefs) != 0 {
		t.Fatalf("second run: %+v %v", again, err)
	}
}
