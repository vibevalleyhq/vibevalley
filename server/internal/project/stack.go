package project

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"vibevalley/internal/protocol"
)

// What the project is built with; false when there is no such project.
func (p *Service) Stack(name string) (protocol.ProjectStack, bool) {
	project := p.find(name)
	if project == nil {
		return protocol.ProjectStack{}, false
	}
	return stackOf(project.Path), true
}

// Only the folder's root is read, first marker wins: a repository with several stacks in subfolders gets its root's.
func stackOf(dir string) protocol.ProjectStack {
	read := func(name string) (string, bool) {
		body, err := os.ReadFile(filepath.Join(dir, name))
		return string(body), err == nil
	}
	has := func(name string) bool { _, ok := read(name); return ok }
	if has("go.mod") {
		return protocol.ProjectStack{Name: "go", Label: "Go", Test: "go test ./...", Lint: "go vet ./...", Build: "go build ./..."}
	}
	if has("Cargo.toml") {
		return protocol.ProjectStack{Name: "rust", Label: "Rust", Test: "cargo test", Lint: "cargo clippy", Build: "cargo build"}
	}
	if pubspec, ok := read("pubspec.yaml"); ok {
		if strings.Contains(pubspec, "flutter") {
			return protocol.ProjectStack{Name: "flutter", Label: "Flutter", Test: "flutter test", Lint: "flutter analyze"}
		}
		return protocol.ProjectStack{Name: "dart", Label: "Dart", Test: "dart test", Lint: "dart analyze"}
	}
	if pkg, ok := read("package.json"); ok {
		return nodeStack(pkg, has)
	}
	if pyproject, ok := read("pyproject.toml"); ok || has("requirements.txt") || has("setup.py") {
		s := protocol.ProjectStack{Name: "python", Label: "Python", Test: "pytest"}
		if strings.Contains(pyproject, "ruff") {
			s.Lint = "ruff check ."
		}
		return s
	}
	return protocol.ProjectStack{}
}

// The package manager is the lockfile's; a command is there only when package.json has that script. `<pm> run <script>`
// on every manager: `bun test` would run bun's own test runner, not the script.
func nodeStack(pkg string, has func(string) bool) protocol.ProjectStack {
	pm := "npm"
	switch {
	case has("bun.lock") || has("bun.lockb"):
		pm = "bun"
	case has("pnpm-lock.yaml"):
		pm = "pnpm"
	case has("yarn.lock"):
		pm = "yarn"
	}
	var manifest struct {
		Scripts map[string]string `json:"scripts"`
	}
	_ = json.Unmarshal([]byte(pkg), &manifest)
	run := func(script string) string {
		if strings.TrimSpace(manifest.Scripts[script]) == "" {
			return ""
		}
		return pm + " run " + script
	}
	return protocol.ProjectStack{Name: "node", Label: "Node（" + pm + "）", Test: run("test"), Lint: run("lint"), Build: run("build")}
}
