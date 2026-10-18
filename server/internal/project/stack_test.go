package project

import (
	"os"
	"path/filepath"
	"testing"

	"vibevalley/internal/protocol"
)

func TestStackIsReadOffTheMarkerAtTheRoot(t *testing.T) {
	scripts := `{"scripts":{"test":"vitest run","build":"vite build"}}`
	for _, c := range []struct {
		name  string
		files map[string]string
		want  protocol.ProjectStack
	}{
		{"nothing", map[string]string{"README.md": "hi"}, protocol.ProjectStack{}},
		{"go", map[string]string{"go.mod": "module x"}, protocol.ProjectStack{Name: "go", Label: "Go", Test: "go test ./...", Lint: "go vet ./...", Build: "go build ./..."}},
		{"go before node", map[string]string{"go.mod": "module x", "package.json": scripts}, protocol.ProjectStack{Name: "go", Label: "Go", Test: "go test ./...", Lint: "go vet ./...", Build: "go build ./..."}},
		{"rust", map[string]string{"Cargo.toml": "[package]"}, protocol.ProjectStack{Name: "rust", Label: "Rust", Test: "cargo test", Lint: "cargo clippy", Build: "cargo build"}},
		{"flutter", map[string]string{"pubspec.yaml": "dependencies:\n  flutter:\n    sdk: flutter\n"}, protocol.ProjectStack{Name: "flutter", Label: "Flutter", Test: "flutter test", Lint: "flutter analyze"}},
		{"dart", map[string]string{"pubspec.yaml": "name: tool\n"}, protocol.ProjectStack{Name: "dart", Label: "Dart", Test: "dart test", Lint: "dart analyze"}},
		{"npm without a lockfile", map[string]string{"package.json": scripts}, protocol.ProjectStack{Name: "node", Label: "Node（npm）", Test: "npm run test", Build: "npm run build"}},
		{"bun.lock", map[string]string{"package.json": scripts, "bun.lock": ""}, protocol.ProjectStack{Name: "node", Label: "Node（bun）", Test: "bun run test", Build: "bun run build"}},
		{"bun.lockb", map[string]string{"package.json": scripts, "bun.lockb": ""}, protocol.ProjectStack{Name: "node", Label: "Node（bun）", Test: "bun run test", Build: "bun run build"}},
		{"pnpm", map[string]string{"package.json": scripts, "pnpm-lock.yaml": ""}, protocol.ProjectStack{Name: "node", Label: "Node（pnpm）", Test: "pnpm run test", Build: "pnpm run build"}},
		{"yarn", map[string]string{"package.json": scripts, "yarn.lock": ""}, protocol.ProjectStack{Name: "node", Label: "Node（yarn）", Test: "yarn run test", Build: "yarn run build"}},
		{"node without scripts", map[string]string{"package.json": `{"name":"x"}`}, protocol.ProjectStack{Name: "node", Label: "Node（npm）"}},
		{"node with a lint script", map[string]string{"package.json": `{"scripts":{"lint":"eslint ."}}`}, protocol.ProjectStack{Name: "node", Label: "Node（npm）", Lint: "npm run lint"}},
		{"unreadable package.json", map[string]string{"package.json": "{"}, protocol.ProjectStack{Name: "node", Label: "Node（npm）"}},
		{"pyproject with ruff", map[string]string{"pyproject.toml": "[tool.ruff]\n"}, protocol.ProjectStack{Name: "python", Label: "Python", Test: "pytest", Lint: "ruff check ."}},
		{"requirements.txt", map[string]string{"requirements.txt": "requests\n"}, protocol.ProjectStack{Name: "python", Label: "Python", Test: "pytest"}},
		{"a marker in a subfolder only", map[string]string{"server/go.mod": "module x"}, protocol.ProjectStack{}},
	} {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			for name, body := range c.files {
				path := filepath.Join(dir, name)
				if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			if got := stackOf(dir); got != c.want {
				t.Fatalf("got %+v, want %+v", got, c.want)
			}
		})
	}
}
