package brain

// archive/ keeps the folded-away conversation word for word, so a summary that lost a detail can be looked up again.

import (
	"crypto/sha1"
	"encoding/hex"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Cut from the top when the prompt carries it: the newest notes matter most.
const MEMORY_PROMPT_CHARS = 8_000

// Where an agent with this home keeps its memory; the manager page reads it there (internal/memory).
func MemoryFile(home string) string { return filepath.Join(home, "MEMORY.md") }

type MemorySnapshot struct {
	File      string
	Prompt    string
	Lines     []MemoryLine
	Carried   int
	UpdatedAt int64
	LineCount int
}

func ReadMemory(home string) MemorySnapshot {
	file := MemoryFile(home)
	data, _ := os.ReadFile(file)
	snapshot := memorySnapshot(file, string(data))
	if info, err := os.Stat(file); err == nil {
		snapshot.UpdatedAt = info.ModTime().UnixMilli()
	}
	return snapshot
}

func memorySnapshot(file, text string) MemorySnapshot {
	text = strings.TrimSpace(text)
	snapshot := MemorySnapshot{File: file, Prompt: text, Lines: []MemoryLine{}, UpdatedAt: time.Now().UnixMilli()}
	runes := []rune(text)
	cutoff := max(0, len(runes)-MEMORY_PROMPT_CHARS)
	if cutoff > 0 {
		snapshot.Prompt = "（更早的记录省略了，全文在 " + file + "）\n" + string(runes[cutoff:])
	}
	offset := 0
	if text != "" {
		snapshot.LineCount = len(strings.Split(text, "\n"))
	}
	for _, line := range strings.Split(text, "\n") {
		if parsed, ok := memoryLine(line); ok {
			snapshot.Lines = append(snapshot.Lines, parsed)
			if offset >= cutoff {
				snapshot.Carried++
			}
		}
		offset += len([]rune(line)) + 1
	}
	return snapshot
}

func memoryLine(line string) (MemoryLine, bool) {
	text := strings.TrimSpace(line)
	if text == "" || strings.HasPrefix(text, "#") {
		return MemoryLine{}, false
	}
	if match := datedLine.FindStringSubmatch(text); match != nil {
		return MemoryLine{ID: lineID(text), Date: match[1], Text: match[2]}, true
	}
	return MemoryLine{ID: lineID(text), Text: bulletHead.ReplaceAllString(text, "")}, true
}

// MEMORY.md's lines as the model is told them: neither blank nor headings, without their bullet.
func memoryFileLines(home string) []string {
	data, _ := os.ReadFile(MemoryFile(home))
	var out []string
	for _, line := range strings.Split(string(data), "\n") {
		if t := strings.TrimSpace(line); t != "" && !strings.HasPrefix(t, "#") {
			out = append(out, bulletHead.ReplaceAllString(t, ""))
		}
	}
	return out
}

// `- YYYY-MM-DD note`, or whatever the agent wrote when it tidied.
type MemoryLine struct {
	// Stable while the line is unchanged, so a page can forget the one it showed.
	ID   string `json:"id"`
	Text string `json:"text"`
	Date string `json:"date,omitempty"`
}

var (
	datedLine  = regexp.MustCompile(`^\s*[-*]\s+(\d{4}-\d{2}-\d{2})\s+(.+?)\s*$`)
	bulletHead = regexp.MustCompile(`^[-*]\s+`)
	newlines   = regexp.MustCompile(`\s*\n\s*`)
)

func lineID(line string) string {
	sum := sha1.Sum([]byte(strings.TrimSpace(line)))
	return hex.EncodeToString(sum[:])[:12]
}

func ForgetLine(home, id string) error {
	data, err := os.ReadFile(MemoryFile(home))
	if err != nil {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	for i, l := range lines {
		if strings.TrimSpace(l) != "" && lineID(l) == id {
			kept := append(append([]string{}, lines[:i]...), lines[i+1:]...)
			return os.WriteFile(MemoryFile(home), []byte(strings.Join(kept, "\n")), 0o644)
		}
	}
	return nil
}

func Remember(home, note string, now time.Time) (MemoryLine, error) {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return MemoryLine{}, err
	}
	f, err := os.OpenFile(MemoryFile(home), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return MemoryLine{}, err
	}
	defer f.Close()
	line := "- " + now.Local().Format("2006-01-02") + " " + strings.TrimSpace(newlines.ReplaceAllString(note, " "))
	if _, err := f.WriteString(line + "\n"); err != nil {
		return MemoryLine{}, err
	}
	written, _ := memoryLine(line)
	return written, nil
}

func RewriteMemory(home, text string) (MemorySnapshot, error) {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return MemorySnapshot{}, err
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	file := MemoryFile(home)
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		return MemorySnapshot{}, err
	}
	return memorySnapshot(file, text), nil
}

// Date.toISOString with its colons and dot made dashes.
func isoStamp(now time.Time) string {
	return strings.NewReplacer(":", "-", ".", "-").Replace(now.UTC().Format("2006-01-02T15:04:05.000Z"))
}

func Archive(home, session, text string, now time.Time) (string, error) {
	dir := archiveDir(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, session+"-"+isoStamp(now)+".md")
	return path, os.WriteFile(path, []byte(text), 0o644)
}

type ArchiveFile struct {
	Name  string `json:"name"`
	At    int64  `json:"at"`
	Chars int    `json:"chars"`
}

type ArchiveHit struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

func archiveDir(home string) string { return filepath.Join(home, "archive") }

func archiveNames(home string) []string {
	entries, _ := os.ReadDir(archiveDir(home))
	var names []string
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".md") {
			names = append(names, e.Name())
		}
	}
	return names
}

func ArchiveFiles(home string) []ArchiveFile {
	out := []ArchiveFile{}
	for _, name := range archiveNames(home) {
		path := filepath.Join(archiveDir(home), name)
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		data, _ := os.ReadFile(path)
		out = append(out, ArchiveFile{Name: name, At: info.ModTime().UnixMilli(), Chars: jsLength(string(data))})
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}

// A name with a path in it is none.
func ReadArchive(home, name string) (string, bool) {
	if name != filepath.Base(name) || !strings.HasSuffix(name, ".md") {
		return "", false
	}
	data, err := os.ReadFile(filepath.Join(archiveDir(home), name))
	if err != nil {
		return "", false
	}
	return string(data), true
}

// Any case; 20 hits when limit is 0.
func SearchArchive(home, query string, limit int) []ArchiveHit {
	if limit <= 0 {
		limit = 20
	}
	q := strings.ToLower(strings.TrimSpace(query))
	hits := []ArchiveHit{}
	if q == "" {
		return hits
	}
	names := archiveNames(home)
	sort.Sort(sort.Reverse(sort.StringSlice(names)))
	for _, file := range names {
		data, _ := os.ReadFile(filepath.Join(archiveDir(home), file))
		lines := strings.Split(string(data), "\n")
		for i, l := range lines {
			if len(hits) < limit && strings.Contains(strings.ToLower(l), q) {
				hits = append(hits, ArchiveHit{File: file, Line: i + 1, Text: strings.Join(lines[max(0, i-2):min(len(lines), i+3)], "\n")})
			}
		}
		if len(hits) >= limit {
			break
		}
	}
	return hits
}
