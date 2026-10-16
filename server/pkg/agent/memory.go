package agent

// The agent's long-term memory, in its own folder: MEMORY.md, short notes it was told to keep, carried in every
// session's system prompt; and archive/, the conversation that compaction folded away, kept word for word so a
// summary that lost a detail can be looked up again.

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

// MEMORY_PROMPT_CHARS: MEMORY.md longer than this is cut from the top when the prompt carries it: the newest notes matter most.
const MEMORY_PROMPT_CHARS = 8_000

func memoryFile(home string) string { return filepath.Join(home, "MEMORY.md") }

// ReadMemory is what the agent remembers, for its system prompt; "" when it remembers nothing.
func ReadMemory(home string) string {
	data, _ := os.ReadFile(memoryFile(home))
	t := strings.TrimSpace(string(data))
	if r := []rune(t); len(r) > MEMORY_PROMPT_CHARS {
		return "（更早的记录省略了，全文在 " + memoryFile(home) + "）\n" + string(r[len(r)-MEMORY_PROMPT_CHARS:])
	}
	return t
}

// MemoryLine is a line of MEMORY.md as a page lists it: `- YYYY-MM-DD note`, or whatever the agent wrote when it tidied.
type MemoryLine struct {
	// A hash of the line: stable while the line is unchanged, so a page can forget the one it showed.
	ID   string `json:"id"`
	Text string `json:"text"`
	// The day it was kept, when the line says.
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

// MemoryLines is MEMORY.md line by line, in the file's order (oldest first); blank lines and headings left out.
func MemoryLines(home string) []MemoryLine {
	data, _ := os.ReadFile(memoryFile(home))
	out := []MemoryLine{}
	for _, line := range strings.Split(string(data), "\n") {
		t := strings.TrimSpace(line)
		if t == "" || strings.HasPrefix(t, "#") {
			continue
		}
		if m := datedLine.FindStringSubmatch(t); m != nil {
			out = append(out, MemoryLine{ID: lineID(t), Date: m[1], Text: m[2]})
		} else {
			out = append(out, MemoryLine{ID: lineID(t), Text: bulletHead.ReplaceAllString(t, "")})
		}
	}
	return out
}

// ForgetLine drops the line with this id from MEMORY.md; nothing when there is none.
func ForgetLine(home, id string) error {
	data, err := os.ReadFile(memoryFile(home))
	if err != nil {
		return nil
	}
	lines := strings.Split(string(data), "\n")
	for i, l := range lines {
		if strings.TrimSpace(l) != "" && lineID(l) == id {
			kept := append(append([]string{}, lines[:i]...), lines[i+1:]...)
			return os.WriteFile(memoryFile(home), []byte(strings.Join(kept, "\n")), 0o644)
		}
	}
	return nil
}

// Remember keeps a note: one dated line in MEMORY.md (the local day).
func Remember(home, note string, now time.Time) error {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	f, err := os.OpenFile(memoryFile(home), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.WriteString("- " + now.Local().Format("2006-01-02") + " " + strings.TrimSpace(newlines.ReplaceAllString(note, " ")) + "\n")
	return err
}

// RewriteMemory rewrites MEMORY.md whole: for the agent tidying what it keeps.
func RewriteMemory(home, text string) error {
	if err := os.MkdirAll(home, 0o755); err != nil {
		return err
	}
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	return os.WriteFile(memoryFile(home), []byte(text), 0o644)
}

// isoStamp is Date.toISOString with its colons and dot made dashes.
func isoStamp(now time.Time) string {
	return strings.NewReplacer(":", "-", ".", "-").Replace(now.UTC().Format("2006-01-02T15:04:05.000Z"))
}

// Archive keeps a folded-away stretch of conversation word for word; it returns where.
func Archive(home, session, text string, now time.Time) (string, error) {
	dir := archiveDir(home)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	path := filepath.Join(dir, session+"-"+isoStamp(now)+".md")
	return path, os.WriteFile(path, []byte(text), 0o644)
}

// ArchiveFile is a folded-away stretch of conversation in archive/.
type ArchiveFile struct {
	Name string `json:"name"`
	// When it was folded away (the file's time, milliseconds).
	At    int64 `json:"at"`
	Chars int   `json:"chars"`
}

// ArchiveHit is a line of the archive that matched, with two lines either side.
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

// ArchiveFiles is the archive, newest first.
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

// ReadArchive is one archived file whole; false when there is no such file (a name with a path in it is none).
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

// SearchArchive is lines in the archive matching query (any case), newest file first; at most limit hits (20 when 0).
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
