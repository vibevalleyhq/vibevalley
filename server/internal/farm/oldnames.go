package farm

// Moving a farm kept under the project's old names to VibeValley's, once (`vibevalley migrate`). The project was
// called heybro, then for a day vibefarm; a farm from then keeps its home, logs and work folder under those names,
// calls its own runtime and the voice line's "farm manager" vendor "heybro", and holds paths to all of these in its
// files and database. MigrateOldNames moves the folders, rewrites what refers to them, repairs the projects' git
// worktrees and copies the app's preferences, after copying everything it touches to a backup folder. Nothing else
// reads the old names: a farm that was not migrated is not found.

import (
	"bytes"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"time"
)

// oldNames are the project's names before VibeValley, newest first: when two old farms want the same place, the
// newer one moves there.
var oldNames = []string{"vibefarm", "heybro"}

// channelSuffixes are the desktop app's channels as its folders and preferences name them.
var channelSuffixes = []struct{ folder, domain string }{{"", ""}, {" Beta", ".beta"}, {" Alpha", ".alpha"}}

// MigrateOptions is whose farm to migrate, and how.
type MigrateOptions struct {
	// UserHome is the user's home folder (~).
	UserHome string
	// DryRun only reports what would be done.
	DryRun bool
	// Backup is where everything is copied before it changes; empty: ~/vibevalley-migration-<time>.
	Backup string
	// Prefs reads and writes the desktop app's preferences; nil: macOS `defaults`.
	Prefs PrefsStore
}

// MigrateReport is what was (or, in a dry run, would be) done.
type MigrateReport struct {
	Moves     [][2]string
	Rewritten []string
	Worktrees []string
	Branches  []string
	Prefs     []string
	Skipped   []string
	Backup    string
}

// PrefsStore reads and writes a preferences domain as plist XML (macOS `defaults export` / `import`).
type PrefsStore interface {
	Export(domain string) ([]byte, error)
	Import(domain string, plist []byte) error
}

type move struct {
	from, to string
	home     bool // a farm's home: its files and database are rewritten
	work     bool // a work folder: its worktrees are repaired
}

// MigrateOldNames moves a farm kept under the old names to the new ones (see the file's comment).
func MigrateOldNames(opt MigrateOptions) (MigrateReport, error) {
	var report MigrateReport
	if opt.UserHome == "" {
		return report, errors.New("migrate: no user home")
	}
	if opt.Prefs == nil {
		opt.Prefs = macDefaults{}
	}
	moves := plannedMoves(opt.UserHome, &report)
	for _, m := range moves {
		report.Moves = append(report.Moves, [2]string{m.from, m.to})
	}
	prefs := plannedPrefs(opt.Prefs, &report)
	if opt.DryRun || (len(moves) == 0 && len(prefs) == 0) {
		return report, nil
	}

	backup := opt.Backup
	if backup == "" {
		backup = filepath.Join(opt.UserHome, "vibevalley-migration-"+time.Now().Format("20060102-150405"))
	}
	report.Backup = backup
	if err := os.MkdirAll(backup, 0o755); err != nil {
		return report, err
	}
	for i, m := range moves {
		if err := copyTree(m.from, filepath.Join(backup, fmt.Sprintf("%d-%s", i, filepath.Base(m.from)))); err != nil {
			return report, fmt.Errorf("migrate: backing up %s: %w", m.from, err)
		}
	}
	for _, m := range moves {
		if err := os.MkdirAll(filepath.Dir(m.to), 0o755); err != nil {
			return report, err
		}
		if err := os.Rename(m.from, m.to); err != nil {
			return report, fmt.Errorf("migrate: moving %s: %w", m.from, err)
		}
	}

	// Paths first, the longest first, so a home inside another moved folder is replaced whole; each ends at a / or the
	// end of a JSON string, so ".../heybro" does not catch ".../heybro Alpha".
	var replacements [][2]string
	for _, m := range moves {
		replacements = append(replacements, [2]string{m.from + "/", m.to + "/"}, [2]string{m.from + `"`, m.to + `"`})
	}
	slicesSortByLenDesc(replacements)
	replacements = append(replacements, oldIDReplacements()...)
	// The helpers' branches get the new prefix where the work folder moved: renameBranches renames them in git too.
	if slices.ContainsFunc(moves, func(m move) bool { return m.work }) {
		for _, name := range oldNames {
			replacements = append(replacements, [2]string{`"` + name + `/`, `"vibevalley/`})
		}
	}
	for _, m := range moves {
		if !m.home {
			continue
		}
		rewritten, err := rewriteHome(m.to, replacements)
		report.Rewritten = append(report.Rewritten, rewritten...)
		if err != nil {
			return report, err
		}
	}
	for _, m := range moves {
		if !m.work {
			continue
		}
		repaired, err := repairWorktrees(m.to, replacements)
		report.Worktrees = append(report.Worktrees, repaired...)
		if err != nil {
			return report, err
		}
		renamed, err := renameBranches(m.to)
		report.Branches = append(report.Branches, renamed...)
		if err != nil {
			return report, err
		}
	}
	for _, p := range prefs {
		plist, err := opt.Prefs.Export(p[0])
		if err != nil {
			return report, err
		}
		if err := os.WriteFile(filepath.Join(backup, p[0]+".plist"), plist, 0o600); err != nil {
			return report, err
		}
		for _, name := range oldNames {
			plist = bytes.ReplaceAll(plist, []byte("<key>flutter."+name+"."), []byte("<key>flutter.vibevalley."))
		}
		if err := opt.Prefs.Import(p[1], plist); err != nil {
			return report, err
		}
	}
	return report, nil
}

// oldIDReplacements turn the old names used as identifiers (the farm's own runtime, the voice line's vendor) into the
// new one, wherever a JSON string is exactly the old name.
func oldIDReplacements() [][2]string {
	var out [][2]string
	for _, name := range oldNames {
		out = append(out, [2]string{`"` + name + `"`, `"vibevalley"`})
	}
	return out
}

// plannedMoves are the old folders that move, each to a new place nothing is in yet.
func plannedMoves(home string, report *MigrateReport) []move {
	var moves []move
	taken := map[string]bool{}
	want := func(from, to string, isHome, isWork bool) {
		if _, err := os.Stat(from); err != nil {
			return
		}
		if isHome && !isFarmHome(from) {
			why := "not a farm"
			if isDir(filepath.Join(from, "db")) {
				why = "the TypeScript server's home: `vibevalley import` brings it in"
			}
			report.Skipped = append(report.Skipped, from+" ("+why+")")
			return
		}
		if _, err := os.Stat(to); err == nil || taken[to] {
			report.Skipped = append(report.Skipped, from+" ("+to+" is there already)")
			return
		}
		taken[to] = true
		moves = append(moves, move{from: from, to: to, home: isHome, work: isWork})
	}
	support := filepath.Join(home, "Library", "Application Support")
	logs := filepath.Join(home, "Library", "Logs")
	for _, name := range oldNames {
		want(filepath.Join(home, "."+name), filepath.Join(home, ".vibevalley"), true, false)
		for _, c := range channelSuffixes {
			want(filepath.Join(support, name+c.folder), filepath.Join(support, "vibevalley"+c.folder), true, false)
		}
	}
	for _, name := range oldNames {
		for _, c := range channelSuffixes {
			want(filepath.Join(logs, name+c.folder), filepath.Join(logs, "vibevalley"+c.folder), false, false)
		}
		want(filepath.Join(home, name+"-work"), filepath.Join(home, "vibevalley-work"), false, true)
	}
	return moves
}

// plannedPrefs are the old preference domains to copy to the new ones, [from, to], where the new one is empty.
func plannedPrefs(prefs PrefsStore, report *MigrateReport) [][2]string {
	var out [][2]string
	old := map[string]string{"heybro": "dev.heybro.flutter", "vibefarm": "dev.vibefarm.app"}
	for _, c := range channelSuffixes {
		to := "dev.vibevalley.app" + c.domain
		if plist, err := prefs.Export(to); err == nil && hasKeys(plist) {
			continue
		}
		for _, name := range oldNames {
			from := old[name] + c.domain
			if plist, err := prefs.Export(from); err == nil && hasKeys(plist) {
				out = append(out, [2]string{from, to})
				report.Prefs = append(report.Prefs, from+" → "+to)
				break
			}
		}
	}
	return out
}

func hasKeys(plist []byte) bool { return bytes.Contains(plist, []byte("<key>")) }

// isFarmHome is whether dir is this server's home: its database is farm.db, the TypeScript server's was db/.
func isFarmHome(dir string) bool {
	if isDir(filepath.Join(dir, "db")) {
		return false
	}
	for _, f := range []string{"farm.db", "farm.json", "config.json"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err == nil {
			return true
		}
	}
	return false
}

func isDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

var envOldKey = regexp.MustCompile(`(?m)^(\s*(?:export\s+)?)(?:HEYBRO|VIBEFARM)_`)

// rewriteHome replaces the old paths and names in a farm home's JSON files, its .env and its database.
func rewriteHome(home string, replacements [][2]string) ([]string, error) {
	var rewritten []string
	err := filepath.WalkDir(home, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		name := d.Name()
		ext := filepath.Ext(name)
		if ext != ".json" && ext != ".jsonl" && name != ".env" {
			return nil
		}
		body, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		next := string(body)
		for _, r := range replacements {
			next = strings.ReplaceAll(next, r[0], r[1])
		}
		if name == ".env" {
			next = envOldKey.ReplaceAllString(next, "${1}VIBEVALLEY_")
		}
		if next == string(body) {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		rewritten = append(rewritten, path)
		return os.WriteFile(path, []byte(next), info.Mode().Perm())
	})
	if err != nil {
		return rewritten, err
	}
	dbPath := filepath.Join(home, "farm.db")
	if _, err := os.Stat(dbPath); err != nil {
		return rewritten, nil
	}
	tables, err := rewriteDatabase(dbPath, replacements)
	for _, t := range tables {
		rewritten = append(rewritten, dbPath+":"+t)
	}
	return rewritten, err
}

// rewriteDatabase replaces the old paths and names in every text column of farm.db, and a column that is exactly an
// old name (a runtime) with the new one; it answers the tables it changed.
func rewriteDatabase(path string, replacements [][2]string) ([]string, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	rows, err := db.Query(`select name from sqlite_master where type = 'table' and name not like 'sqlite_%'`)
	if err != nil {
		return nil, err
	}
	var tables []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			rows.Close()
			return nil, err
		}
		tables = append(tables, name)
	}
	rows.Close()
	var changed []string
	for _, table := range tables {
		cols, err := textColumns(db, table)
		if err != nil {
			return changed, err
		}
		n := int64(0)
		for _, col := range cols {
			for _, r := range replacements {
				res, err := db.Exec(fmt.Sprintf(`update %q set %q = replace(%q, ?, ?) where instr(%q, ?) > 0`, table, col, col, col), r[0], r[1], r[0])
				if err != nil {
					return changed, fmt.Errorf("migrate: %s.%s: %w", table, col, err)
				}
				k, _ := res.RowsAffected()
				n += k
			}
			for _, name := range oldNames {
				res, err := db.Exec(fmt.Sprintf(`update %q set %q = 'vibevalley' where %q = ?`, table, col, col), name)
				if err != nil {
					return changed, fmt.Errorf("migrate: %s.%s: %w", table, col, err)
				}
				k, _ := res.RowsAffected()
				n += k
			}
		}
		if n > 0 {
			changed = append(changed, table)
		}
	}
	return changed, nil
}

func textColumns(db *sql.DB, table string) ([]string, error) {
	rows, err := db.Query(fmt.Sprintf(`pragma table_info(%q)`, table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var cols []string
	for rows.Next() {
		var (
			cid, notNull, pk int
			name, kind       string
			def              sql.NullString
		)
		if err := rows.Scan(&cid, &name, &kind, &notNull, &def, &pk); err != nil {
			return nil, err
		}
		if k := strings.ToLower(kind); k == "text" || k == "" {
			cols = append(cols, name)
		}
	}
	return cols, rows.Err()
}

// repairWorktrees points the helpers' worktrees under a moved work folder (<root>/.worktrees) and their projects back
// at each other: each worktree's .git file names its project's old path, which `git worktree repair` then fixes on
// both sides.
func repairWorktrees(root string, replacements [][2]string) ([]string, error) {
	entries, err := os.ReadDir(filepath.Join(root, ".worktrees"))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var repaired []string
	for _, e := range entries {
		tree := filepath.Join(root, ".worktrees", e.Name())
		body, err := os.ReadFile(filepath.Join(tree, ".git"))
		if err != nil {
			continue
		}
		gitdir := strings.TrimSpace(strings.TrimPrefix(string(body), "gitdir:"))
		for _, r := range replacements {
			gitdir = strings.ReplaceAll(gitdir, r[0], r[1])
		}
		project, _, ok := strings.Cut(gitdir, string(filepath.Separator)+".git"+string(filepath.Separator)+"worktrees"+string(filepath.Separator))
		if !ok || !isDir(project) {
			continue
		}
		if out, err := exec.Command("git", "-C", project, "worktree", "repair", tree).CombinedOutput(); err != nil {
			return repaired, fmt.Errorf("migrate: repairing %s: %v: %s", tree, err, out)
		}
		repaired = append(repaired, tree)
	}
	return repaired, nil
}

// renameBranches renames the helpers' branches in the projects of a moved work folder from the old prefixes
// (heybro/, vibefarm/) to vibevalley/, as the farm's data now names them; a branch checked out in a worktree is renamed
// there. A branch whose new name is taken already stays.
func renameBranches(root string) ([]string, error) {
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var renamed []string
	for _, e := range entries {
		project := filepath.Join(root, e.Name())
		if !e.IsDir() || !isDir(filepath.Join(project, ".git")) {
			continue
		}
		var refs []string
		for _, name := range oldNames {
			refs = append(refs, "refs/heads/"+name+"/")
		}
		out, err := exec.Command("git", append([]string{"-C", project, "for-each-ref", "--format=%(refname:short)"}, refs...)...).Output()
		if err != nil {
			return renamed, fmt.Errorf("migrate: branches of %s: %w", project, err)
		}
		checkedOut := map[string]string{}
		if list, err := exec.Command("git", "-C", project, "worktree", "list", "--porcelain").Output(); err == nil {
			var tree string
			for _, line := range strings.Split(string(list), "\n") {
				if p, ok := strings.CutPrefix(line, "worktree "); ok {
					tree = p
				} else if b, ok := strings.CutPrefix(line, "branch refs/heads/"); ok {
					checkedOut[b] = tree
				}
			}
		}
		for _, branch := range strings.Fields(string(out)) {
			_, rest, _ := strings.Cut(branch, "/")
			next := "vibevalley/" + rest
			if exec.Command("git", "-C", project, "show-ref", "--verify", "--quiet", "refs/heads/"+next).Run() == nil {
				continue
			}
			where := project
			if tree, ok := checkedOut[branch]; ok {
				where = tree
			}
			if out, err := exec.Command("git", "-C", where, "branch", "-m", branch, next).CombinedOutput(); err != nil {
				return renamed, fmt.Errorf("migrate: renaming %s in %s: %v: %s", branch, project, err, out)
			}
			renamed = append(renamed, e.Name()+": "+branch+" → "+next)
		}
	}
	return renamed, nil
}

// copyTree copies dir to dest: as a clone on APFS (cp -c), else a plain copy.
func copyTree(dir, dest string) error {
	if err := exec.Command("cp", "-cRp", dir, dest).Run(); err == nil {
		return nil
	}
	if out, err := exec.Command("cp", "-Rp", dir, dest).CombinedOutput(); err != nil {
		return fmt.Errorf("%v: %s", err, out)
	}
	return nil
}

func slicesSortByLenDesc(pairs [][2]string) {
	for i := 1; i < len(pairs); i++ {
		for j := i; j > 0 && len(pairs[j][0]) > len(pairs[j-1][0]); j-- {
			pairs[j], pairs[j-1] = pairs[j-1], pairs[j]
		}
	}
}

// macDefaults is the app's preferences through macOS `defaults`.
type macDefaults struct{}

func (macDefaults) Export(domain string) ([]byte, error) {
	return exec.Command("defaults", "export", domain, "-").Output()
}

func (macDefaults) Import(domain string, plist []byte) error {
	cmd := exec.Command("defaults", "import", domain, "-")
	cmd.Stdin = bytes.NewReader(plist)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("defaults import %s: %v: %s", domain, err, out)
	}
	return nil
}
