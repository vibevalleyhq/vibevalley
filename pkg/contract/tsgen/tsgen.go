package tsgen

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const (
	ContractSubdir = "pkg/contract"
	ShapesRelPath  = "packages/protocol/src/go-contract/shapes.ts"
	SchemaRelPath  = "packages/protocol/src/go-contract/schema.ts"
)

// ErrOutOfDate indicates one or more generated files are missing or stale under --check.
var ErrOutOfDate = errors.New("generated go-contract files are out of date")

// Options configures code generation or drift checking against a repository root.
type Options struct {
	RepoRoot string
	Check    bool
}

// GenerateDir parses contract declarations in contractDir and emits TypeScript outputs.
func GenerateDir(contractDir string) (GeneratedFiles, error) {
	pkg, err := ParseDir(contractDir)
	if err != nil {
		return GeneratedFiles{}, err
	}
	return Emit(pkg)
}

// Run executes either --write (creating/updating generated files) or --check against RepoRoot.
func Run(opts Options) error {
	if opts.RepoRoot == "" {
		return fmt.Errorf("repo root must not be empty")
	}
	contractDir := filepath.Join(opts.RepoRoot, ContractSubdir)
	out, err := GenerateDir(contractDir)
	if err != nil {
		return err
	}

	targets := []struct {
		rel  string
		want []byte
	}{
		{rel: ShapesRelPath, want: out.ShapesTS},
		{rel: SchemaRelPath, want: out.SchemaTS},
	}

	if opts.Check {
		var stale []string
		for _, t := range targets {
			abs := filepath.Join(opts.RepoRoot, t.rel)
			got, readErr := os.ReadFile(abs)
			if readErr != nil {
				stale = append(stale, fmt.Sprintf("%s (%v)", t.rel, readErr))
				continue
			}
			if !bytes.Equal(got, t.want) {
				stale = append(stale, t.rel)
			}
		}
		if len(stale) > 0 {
			return fmt.Errorf("%w: %s; run `vpx scripts/gen/go-contract.ts --write`", ErrOutOfDate, strings.Join(stale, ", "))
		}
		return nil
	}

	for _, t := range targets {
		abs := filepath.Join(opts.RepoRoot, t.rel)
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			return fmt.Errorf("mkdir %s: %w", filepath.Dir(abs), err)
		}
		if err := writeFileIfChanged(abs, t.want); err != nil {
			return err
		}
	}
	return nil
}

func writeFileIfChanged(path string, content []byte) error {
	existing, err := os.ReadFile(path)
	if err == nil && bytes.Equal(existing, content) {
		return nil
	}
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", path, err)
	}
	return nil
}
