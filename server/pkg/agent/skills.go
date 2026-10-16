package agent

// The system prompt lists only names and when-to-use; the body is read when the model asks for it (load_skill), so a hundred skills cost a hundred
// lines, not a hundred files.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

type SkillInfo struct {
	Name        string
	Description string
	Path        string
}

func DefaultSkillDirs(cwd string) []string {
	home, _ := os.UserHomeDir()
	return []string{filepath.Join(home, ".agents", "skills"), filepath.Join(home, ".claude", "skills"), filepath.Join(cwd, ".agents", "skills")}
}

var (
	frontMatterBlock = regexp.MustCompile(`^---\r?\n([\s\S]*?)\r?\n---`)
	frontMatterKey   = regexp.MustCompile(`^([A-Za-z_][\w-]*):\s*(.*)$`)
	indentedLine     = regexp.MustCompile(`^\s+\S`)
	quotedValue      = regexp.MustCompile(`^(['"])([\s\S]*)(['"])$`)
	lineBreak        = regexp.MustCompile(`\r?\n`)
	frontMatterHead  = regexp.MustCompile(`^---\r?\n[\s\S]*?\r?\n---\r?\n?`)
)

// YAML's simple `key: value` lines only (quotes and folded `>` allowed).
func FrontMatter(text string) map[string]string {
	out := map[string]string{}
	m := frontMatterBlock.FindStringSubmatch(text)
	if m == nil || m[1] == "" {
		return out
	}
	lines := lineBreak.Split(m[1], -1)
	for i := 0; i < len(lines); i++ {
		kv := frontMatterKey.FindStringSubmatch(lines[i])
		if kv == nil {
			continue
		}
		value := strings.TrimSpace(kv[2])
		if value == ">" || value == "|" || value == ">-" || value == "|-" {
			var block []string
			for i+1 < len(lines) && indentedLine.MatchString(lines[i+1]) {
				i++
				block = append(block, strings.TrimSpace(lines[i]))
			}
			sep := "\n"
			if strings.HasPrefix(value, ">") {
				sep = " "
			}
			value = strings.Join(block, sep)
		}
		if q := quotedValue.FindStringSubmatch(value); q != nil && q[1] == q[3] {
			value = q[2]
		}
		out[kv[1]] = value
	}
	return out
}

func SkillBody(text string) string {
	return strings.TrimSpace(frontMatterHead.ReplaceAllString(text, ""))
}

// The first of a name wins. Unreadable folders are skipped.
func ScanSkills(dirs []string) []SkillInfo {
	found := map[string]SkillInfo{}
	for _, dir := range dirs {
		entries, err := os.ReadDir(dir)
		if err != nil {
			continue
		}
		for _, e := range entries {
			if !e.IsDir() && e.Type()&os.ModeSymlink == 0 {
				continue
			}
			path := filepath.Join(dir, e.Name(), "SKILL.md")
			data, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			fm := FrontMatter(string(data))
			name := fm["name"]
			if name == "" {
				name = e.Name()
			}
			if _, ok := found[name]; !ok {
				found[name] = SkillInfo{Name: name, Description: fm["description"], Path: path}
			}
		}
	}
	out := make([]SkillInfo, 0, len(found))
	for _, s := range found {
		out = append(out, s)
	}
	// localeCompare: case folded first.
	sort.Slice(out, func(i, j int) bool {
		a, b := strings.ToLower(out[i].Name), strings.ToLower(out[j].Name)
		if a != b {
			return a < b
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func SkillIndex(skills []SkillInfo, max int) string {
	if max <= 0 {
		max = 160
	}
	lines := make([]string, 0, len(skills))
	for _, s := range skills {
		description := s.Description
		if r := []rune(description); len(r) > max {
			description = string(r[:max]) + "…"
		}
		lines = append(lines, "- "+s.Name+"："+description)
	}
	return strings.Join(lines, "\n")
}

func ReadSkill(skills []SkillInfo, name string) (string, error) {
	for _, s := range skills {
		if s.Name != name {
			continue
		}
		data, err := os.ReadFile(s.Path)
		if err != nil {
			return "", fmt.Errorf("读不到 %s", s.Path)
		}
		return "# " + s.Name + "\n（来自 " + s.Path + "）\n\n" + SkillBody(string(data)), nil
	}
	names := make([]string, 0, len(skills))
	for _, s := range skills {
		names = append(names, s.Name)
	}
	have := strings.Join(names, "、")
	if have == "" {
		have = "（没有）"
	}
	return "", fmt.Errorf("没有叫 %s 的技能。有：%s", name, have)
}
