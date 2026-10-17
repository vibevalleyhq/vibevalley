package voice

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Agora is one way to make a call, not a concept of the farm: its SDK stays behind pkg/agora and the adapter in agora.go, so the
// shapes and the other services never learn its words.
func TestAgoraStaysBehindTheVoiceAdapter(t *testing.T) {
	server, err := filepath.Abs("../..")
	if err != nil {
		t.Fatal(err)
	}
	allowed := func(rel string) bool {
		return strings.HasPrefix(rel, "pkg/agora/") || rel == "internal/voice/agora.go" || rel == "internal/voice/agora_test.go"
	}
	seen := 0
	err = filepath.WalkDir(server, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if name := d.Name(); name == "testdata" || (strings.HasPrefix(name, ".") && path != server) {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(path, ".go") {
			return nil
		}
		file, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(server, path)
		rel = filepath.ToSlash(rel)
		for _, spec := range file.Imports {
			imported, _ := strconv.Unquote(spec.Path.Value)
			if !strings.HasPrefix(imported, "github.com/AgoraIO/") {
				continue
			}
			seen++
			if !allowed(rel) {
				t.Errorf("%s imports %s: Agora's SDK belongs in pkg/agora or internal/voice/agora.go", rel, imported)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if seen == 0 {
		t.Fatal("no Agora import found at all: the walk looks in the wrong place")
	}
}
