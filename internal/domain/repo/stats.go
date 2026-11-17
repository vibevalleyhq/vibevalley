package repo

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	defaultActivityDays = 365
	maxScannedFileBytes = 4 << 20
)

// LanguageStat summarizes file and line counts for one programming or markup language.
type LanguageStat struct {
	Name     string `json:"name"`
	Color    string `json:"color"`
	Files    int    `json:"files"`
	Code     int    `json:"code"`
	Comments int    `json:"comments"`
	Blanks   int    `json:"blanks"`
	Lines    int    `json:"lines"`
}

// LanguageScan holds aggregated language statistics for a repository directory.
type LanguageScan struct {
	RepoPath   string         `json:"repoPath"`
	TotalFiles int            `json:"totalFiles"`
	TotalLines int            `json:"totalLines"`
	Languages  []LanguageStat `json:"languages"`
}

// DayCount records commit count for a single YYYY-MM-DD calendar day.
type DayCount struct {
	Day     string `json:"day"`
	Commits int    `json:"commits"`
}

// AuthorCount records commit count attributed to a git commit author.
type AuthorCount struct {
	Name    string `json:"name"`
	Commits int    `json:"commits"`
}

// ActivityScan captures git history and working tree status for a repository.
type ActivityScan struct {
	RepoPath     string        `json:"repoPath"`
	Branch       string        `json:"branch"`
	HeadCommit   string        `json:"headCommit"`
	DirtyCount   int           `json:"dirtyCount"`
	DirtyFiles   []string      `json:"dirtyFiles,omitempty"`
	TotalCommits int           `json:"totalCommits"`
	Days         []DayCount    `json:"days"`
	Authors      []AuthorCount `json:"authors"`
}

type commentStyle int

const (
	commentNone commentStyle = iota
	commentCStyle
	commentHash
	commentDash
	commentHTML
	commentMarkdown
)

type langSpec struct {
	name    string
	color   string
	comment commentStyle
}

var (
	langGo         = langSpec{"Go", "#00add8", commentCStyle}
	langTypeScript = langSpec{"TypeScript", "#3178c6", commentCStyle}
	langJavaScript = langSpec{"JavaScript", "#f1e05a", commentCStyle}
	langSQL        = langSpec{"SQL", "#e38c00", commentDash}
	langMarkdown   = langSpec{"Markdown", "#083fa1", commentMarkdown}
	langJSON       = langSpec{"JSON", "#292929", commentNone}
	langJSONC      = langSpec{"JSON", "#292929", commentCStyle}
	langYAML       = langSpec{"YAML", "#cb171e", commentHash}
	langCSS        = langSpec{"CSS", "#563d7c", commentCStyle}
	langSass       = langSpec{"Sass", "#c6538c", commentCStyle}
	langHTML       = langSpec{"HTML", "#e34c26", commentHTML}
	langShell      = langSpec{"Shell", "#89e051", commentHash}
	langPython     = langSpec{"Python", "#3572a5", commentHash}
	langRust       = langSpec{"Rust", "#dea584", commentCStyle}
	langJava       = langSpec{"Java", "#b07219", commentCStyle}
	langKotlin     = langSpec{"Kotlin", "#a97bff", commentCStyle}
	langSwift      = langSpec{"Swift", "#f05138", commentCStyle}
	langC          = langSpec{"C", "#555555", commentCStyle}
	langCPP        = langSpec{"C++", "#f34b7d", commentCStyle}
	langCSharp     = langSpec{"C#", "#178600", commentCStyle}
	langRuby       = langSpec{"Ruby", "#701516", commentHash}
	langPHP        = langSpec{"PHP", "#4f5d95", commentCStyle}
	langDart       = langSpec{"Dart", "#00b4ab", commentCStyle}
	langLua        = langSpec{"Lua", "#000080", commentDash}
	langScala      = langSpec{"Scala", "#c22d40", commentCStyle}
	langElixir     = langSpec{"Elixir", "#6e4a7e", commentHash}
	langHaskell    = langSpec{"Haskell", "#5e5086", commentDash}
	langZig        = langSpec{"Zig", "#ec915c", commentCStyle}
	langR          = langSpec{"R", "#198ce7", commentHash}
	langJulia      = langSpec{"Julia", "#a270ba", commentHash}
	langVue        = langSpec{"Vue", "#41b883", commentHTML}
	langSvelte     = langSpec{"Svelte", "#ff3e00", commentHTML}
	langDocker     = langSpec{"Dockerfile", "#384d54", commentHash}
	langJupyter    = langSpec{"Jupyter", "#da5b0b", commentNone}
	langPowerShell = langSpec{"PowerShell", "#012456", commentHash}
	langTerraform  = langSpec{"Terraform", "#844fba", commentHash}
	langTOML       = langSpec{"TOML", "#9c4221", commentHash}
	langXML        = langSpec{"XML", "#0060ac", commentHTML}
	langProto      = langSpec{"Protobuf", "#4285f4", commentCStyle}
	langMakefile   = langSpec{"Makefile", "#427819", commentHash}
)

var extToLang = map[string]langSpec{
	".go":       langGo,
	".ts":       langTypeScript,
	".tsx":      langTypeScript,
	".mts":      langTypeScript,
	".cts":      langTypeScript,
	".js":       langJavaScript,
	".jsx":      langJavaScript,
	".mjs":      langJavaScript,
	".cjs":      langJavaScript,
	".sql":      langSQL,
	".md":       langMarkdown,
	".mdx":      langMarkdown,
	".markdown": langMarkdown,
	".json":     langJSON,
	".jsonc":    langJSONC,
	".json5":    langJSONC,
	".yaml":     langYAML,
	".yml":      langYAML,
	".css":      langCSS,
	".less":     langCSS,
	".scss":     langSass,
	".sass":     langSass,
	".html":     langHTML,
	".htm":      langHTML,
	".sh":       langShell,
	".bash":     langShell,
	".zsh":      langShell,
	".fish":     langShell,
	".py":       langPython,
	".pyi":      langPython,
	".rs":       langRust,
	".java":     langJava,
	".kt":       langKotlin,
	".kts":      langKotlin,
	".swift":    langSwift,
	".c":        langC,
	".h":        langC,
	".cpp":      langCPP,
	".cc":       langCPP,
	".cxx":      langCPP,
	".hpp":      langCPP,
	".hh":       langCPP,
	".cs":       langCSharp,
	".rb":       langRuby,
	".php":      langPHP,
	".dart":     langDart,
	".lua":      langLua,
	".scala":    langScala,
	".ex":       langElixir,
	".exs":      langElixir,
	".hs":       langHaskell,
	".zig":      langZig,
	".r":        langR,
	".jl":       langJulia,
	".vue":      langVue,
	".svelte":   langSvelte,
	".ipynb":    langJupyter,
	".ps1":      langPowerShell,
	".tf":       langTerraform,
	".hcl":      langTerraform,
	".toml":     langTOML,
	".xml":      langXML,
	".svg":      langXML,
	".proto":    langProto,
}

var skipWalkDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"dist":         true,
	"vendor":       true,
	".venv":        true,
	"venv":         true,
	"__pycache__":  true,
	".next":        true,
	"build":        true,
	"target":       true,
	"coverage":     true,
}

var ignoredBasenames = map[string]bool{
	"pnpm-lock.yaml":    true,
	"package-lock.json": true,
	"yarn.lock":         true,
	"bun.lock":          true,
	"bun.lockb":         true,
	"Cargo.lock":        true,
	"go.sum":            true,
	"poetry.lock":       true,
	"uv.lock":           true,
	"Pipfile.lock":      true,
	"Gemfile.lock":      true,
	"composer.lock":     true,
}

// ScanLanguages enumerates tracked files via `git -C <repoPath> ls-files -z` (falling back to a
// filesystem walk skipping `.git`, `node_modules`, `dist`, `vendor`, etc.) and counts files plus
// code, comment, and blank lines per language with color hexes.
func ScanLanguages(ctx context.Context, repoPath string) (LanguageScan, error) {
	if err := ctx.Err(); err != nil {
		return LanguageScan{}, err
	}
	dir, err := ensureDir(repoPath)
	if err != nil {
		return LanguageScan{}, err
	}

	files, err := listRepoFiles(ctx, dir)
	if err != nil {
		return LanguageScan{}, err
	}

	acc := make(map[string]*LanguageStat)
	var totalFiles, totalLines int

	for _, rel := range files {
		if err := ctx.Err(); err != nil {
			return LanguageScan{}, err
		}
		if shouldSkipRelPath(rel) {
			continue
		}
		spec, ok := classifyFileLanguage(rel)
		if !ok {
			continue
		}
		absPath := filepath.Join(dir, filepath.FromSlash(rel))
		info, sErr := os.Stat(absPath)
		if sErr != nil || !info.Mode().IsRegular() || info.Size() > maxScannedFileBytes {
			continue
		}
		raw, rErr := os.ReadFile(absPath)
		if rErr != nil || isBinaryData(raw) {
			continue
		}

		code, comments, blanks := countFileLines(raw, spec.comment)
		entry := acc[spec.name]
		if entry == nil {
			entry = &LanguageStat{
				Name:  spec.name,
				Color: spec.color,
			}
			acc[spec.name] = entry
		}
		entry.Files++
		entry.Code += code
		entry.Comments += comments
		entry.Blanks += blanks
		entry.Lines += code + comments + blanks

		totalFiles++
		totalLines += code + comments + blanks
	}

	langs := make([]LanguageStat, 0, len(acc))
	for _, st := range acc {
		langs = append(langs, *st)
	}
	sort.Slice(langs, func(i, j int) bool {
		aScore := langs[i].Code + langs[i].Comments
		bScore := langs[j].Code + langs[j].Comments
		if aScore != bScore {
			return aScore > bScore
		}
		if langs[i].Files != langs[j].Files {
			return langs[i].Files > langs[j].Files
		}
		return compareFold(langs[i].Name, langs[j].Name) < 0
	})

	return LanguageScan{
		RepoPath:   dir,
		TotalFiles: totalFiles,
		TotalLines: totalLines,
		Languages:  langs,
	}, nil
}

// ScanActivity aggregates daily commit counts, active authors, current branch, HEAD commit SHA,
// and working-tree dirty file count via `git -C <repoPath>`.
func ScanActivity(ctx context.Context, repoPath string, days int) (ActivityScan, error) {
	if err := ctx.Err(); err != nil {
		return ActivityScan{}, err
	}
	dir, err := ensureDir(repoPath)
	if err != nil {
		return ActivityScan{}, err
	}
	if days <= 0 {
		days = defaultActivityDays
	}

	branch, _, bCode, _ := runGit(ctx, dir, "rev-parse", "--abbrev-ref", "HEAD")
	if bCode != 0 || branch == "" {
		if sym, _, sCode, _ := runGit(ctx, dir, "symbolic-ref", "--short", "HEAD"); sCode == 0 && sym != "" {
			branch = sym
		}
	}

	headCommit := ""
	if sha, _, hCode, _ := runGit(ctx, dir, "rev-parse", "HEAD"); hCode == 0 {
		headCommit = sha
	}

	dirtyFiles, err := gitPorcelainDirtyFiles(ctx, dir)
	if err != nil {
		return ActivityScan{}, err
	}

	dayCounts := make(map[string]int)
	authorCounts := make(map[string]int)
	totalCommits := 0

	if headCommit != "" {
		sinceTime := time.Now().Add(-time.Duration(days) * 24 * time.Hour).UTC().Format(time.RFC3339)
		rawLog, stderr, _, lErr := runGitRaw(ctx, dir, "log", "--since="+sinceTime, "--format=%ct%x09%an")
		if lErr != nil {
			return ActivityScan{}, fmt.Errorf("git log: %v (%s)", lErr, stderr)
		}
		for line := range strings.SplitSeq(string(rawLog), "\n") {
			line = strings.TrimRight(line, "\r")
			if line == "" {
				continue
			}
			secText, author, hasTab := strings.Cut(line, "\t")
			if !hasTab {
				continue
			}
			sec, pErr := strconv.ParseInt(strings.TrimSpace(secText), 10, 64)
			if pErr != nil || sec <= 0 {
				continue
			}
			dayKey := time.Unix(sec, 0).Format("2006-01-02")
			dayCounts[dayKey]++
			authorName := strings.TrimSpace(author)
			if authorName == "" {
				authorName = "Unknown"
			}
			authorCounts[authorName]++
			totalCommits++
		}
	}

	dayList := make([]DayCount, 0, len(dayCounts))
	for d, c := range dayCounts {
		dayList = append(dayList, DayCount{Day: d, Commits: c})
	}
	sort.Slice(dayList, func(i, j int) bool {
		return dayList[i].Day < dayList[j].Day
	})

	authorList := make([]AuthorCount, 0, len(authorCounts))
	for name, c := range authorCounts {
		authorList = append(authorList, AuthorCount{Name: name, Commits: c})
	}
	sort.Slice(authorList, func(i, j int) bool {
		if authorList[i].Commits != authorList[j].Commits {
			return authorList[i].Commits > authorList[j].Commits
		}
		return compareFold(authorList[i].Name, authorList[j].Name) < 0
	})

	return ActivityScan{
		RepoPath:     dir,
		Branch:       branch,
		HeadCommit:   headCommit,
		DirtyCount:   len(dirtyFiles),
		DirtyFiles:   dirtyFiles,
		TotalCommits: totalCommits,
		Days:         dayList,
		Authors:      authorList,
	}, nil
}

func ensureDir(rawPath string) (string, error) {
	trimmed := strings.TrimSpace(rawPath)
	if trimmed == "" {
		return "", fmt.Errorf("%w: repository path is required", ErrInvalidArgument)
	}
	abs, err := filepath.Abs(trimmed)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !info.IsDir() {
		return "", fmt.Errorf("%w: %s is not a directory", ErrInvalidArgument, abs)
	}
	return abs, nil
}

func runGitRaw(ctx context.Context, dir string, args ...string) ([]byte, string, int, error) {
	fullArgs := make([]string, 0, len(args)+2)
	if dir != "" {
		fullArgs = append(fullArgs, "-C", dir)
	}
	fullArgs = append(fullArgs, args...)

	cmd := exec.CommandContext(ctx, "git", fullArgs...)
	cmd.Env = append(os.Environ(),
		"GIT_TERMINAL_PROMPT=0",
		"LC_ALL=C",
	)
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	code := 0
	if err != nil {
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			code = exitErr.ExitCode()
		} else {
			code = -1
		}
	}
	return stdout.Bytes(), strings.TrimSpace(stderr.String()), code, err
}

func gitPorcelainDirtyFiles(ctx context.Context, dir string) ([]string, error) {
	raw, stderr, _, err := runGitRaw(ctx, dir, "status", "--porcelain")
	if err != nil {
		return nil, fmt.Errorf("git status: %v (%s)", err, stderr)
	}
	var dirty []string
	for line := range strings.SplitSeq(string(raw), "\n") {
		line = strings.TrimRight(line, "\r")
		if len(line) == 0 {
			continue
		}
		if len(line) > 3 {
			dirty = append(dirty, strings.TrimSpace(line[3:]))
		} else {
			dirty = append(dirty, strings.TrimSpace(line))
		}
	}
	return dirty, nil
}

func listRepoFiles(ctx context.Context, dir string) ([]string, error) {
	raw, _, code, err := runGitRaw(ctx, dir, "ls-files", "-z")
	if err == nil && code == 0 {
		parts := bytes.Split(raw, []byte{0})
		files := make([]string, 0, len(parts))
		for _, p := range parts {
			if len(p) > 0 {
				files = append(files, string(p))
			}
		}
		slices.Sort(files)
		return files, nil
	}

	var files []string
	walkErr := filepath.WalkDir(dir, func(path string, d fs.DirEntry, wErr error) error {
		if wErr != nil {
			return wErr
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if d.IsDir() {
			if path != dir && skipWalkDirs[d.Name()] {
				return filepath.SkipDir
			}
			return nil
		}
		rel, rErr := filepath.Rel(dir, path)
		if rErr != nil {
			return nil
		}
		files = append(files, filepath.ToSlash(rel))
		return nil
	})
	if walkErr != nil {
		return nil, walkErr
	}
	slices.Sort(files)
	return files, nil
}

func shouldSkipRelPath(rel string) bool {
	slash := filepath.ToSlash(rel)
	for seg := range strings.SplitSeq(slash, "/") {
		if skipWalkDirs[seg] {
			return true
		}
	}
	base := filepath.Base(slash)
	if ignoredBasenames[base] {
		return true
	}
	return strings.HasSuffix(base, ".min.js") || strings.HasSuffix(base, ".min.css") || strings.HasSuffix(base, ".map")
}

func classifyFileLanguage(rel string) (langSpec, bool) {
	base := filepath.Base(rel)
	lowerBase := strings.ToLower(base)
	switch {
	case lowerBase == "dockerfile" || strings.HasPrefix(lowerBase, "dockerfile."):
		return langDocker, true
	case lowerBase == "makefile" || lowerBase == "gnumakefile":
		return langMakefile, true
	}
	ext := strings.ToLower(filepath.Ext(base))
	spec, ok := extToLang[ext]
	return spec, ok
}

func isBinaryData(raw []byte) bool {
	sample := raw
	if len(sample) > 8192 {
		sample = sample[:8192]
	}
	return bytes.IndexByte(sample, 0) >= 0
}

func countFileLines(raw []byte, style commentStyle) (code, comments, blanks int) {
	sc := bufio.NewScanner(bytes.NewReader(raw))
	sc.Buffer(make([]byte, 0, 64*1024), 4*1024*1024)

	inBlock := false
	inCodeFence := false

	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" {
			blanks++
			continue
		}

		switch style {
		case commentNone:
			code++

		case commentHash:
			if strings.HasPrefix(line, "#") {
				comments++
			} else {
				code++
			}

		case commentCStyle:
			isComment, nextInBlock := scanBlockCommentLine(line, "//", "/*", "*/", inBlock)
			inBlock = nextInBlock
			if isComment {
				comments++
			} else {
				code++
			}

		case commentDash:
			isComment, nextInBlock := scanBlockCommentLine(line, "--", "/*", "*/", inBlock)
			inBlock = nextInBlock
			if isComment {
				comments++
			} else {
				code++
			}

		case commentHTML:
			isComment, nextInBlock := scanBlockCommentLine(line, "", "<!--", "-->", inBlock)
			inBlock = nextInBlock
			if isComment {
				comments++
			} else {
				code++
			}

		case commentMarkdown:
			if strings.HasPrefix(line, "```") || strings.HasPrefix(line, "~~~") {
				inCodeFence = !inCodeFence
				code++
				continue
			}
			if inCodeFence {
				code++
				continue
			}
			isHTMLComment, nextInBlock := scanBlockCommentLine(line, "", "<!--", "-->", inBlock)
			inBlock = nextInBlock
			if isHTMLComment {
				comments++
			} else if strings.HasPrefix(line, "#") {
				code++
			} else {
				comments++
			}
		}
	}
	return code, comments, blanks
}

func scanBlockCommentLine(trimmedLine, singlePrefix, openTok, closeTok string, inBlock bool) (isComment bool, nextInBlock bool) {
	if inBlock {
		if idx := strings.Index(trimmedLine, closeTok); idx >= 0 {
			rest := strings.TrimSpace(trimmedLine[idx+len(closeTok):])
			if rest == "" {
				return true, false
			}
			return scanBlockCommentLine(rest, singlePrefix, openTok, closeTok, false)
		}
		return true, true
	}
	if singlePrefix != "" && strings.HasPrefix(trimmedLine, singlePrefix) {
		return true, false
	}
	if strings.HasPrefix(trimmedLine, openTok) {
		afterOpen := trimmedLine[len(openTok):]
		if idx := strings.Index(afterOpen, closeTok); idx >= 0 {
			rest := strings.TrimSpace(afterOpen[idx+len(closeTok):])
			if rest == "" {
				return true, false
			}
			return scanBlockCommentLine(rest, singlePrefix, openTok, closeTok, false)
		}
		return true, true
	}
	// If openTok appears after code on the same line without closing, track block state for subsequent lines.
	if openIdx := strings.Index(trimmedLine, openTok); openIdx > 0 {
		rest := trimmedLine[openIdx+len(openTok):]
		if !strings.Contains(rest, closeTok) {
			return false, true
		}
	}
	return false, false
}

func compareFold(a, b string) int {
	la := strings.ToLower(a)
	lb := strings.ToLower(b)
	if la < lb {
		return -1
	}
	if la > lb {
		return 1
	}
	return strings.Compare(a, b)
}
