package main

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/vibevalleyhq/vibevalley/pkg/contract/tsgen"
)

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "vibe-tsgen: %v\n", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer, stderr io.Writer) error {
	fs := flag.NewFlagSet("vibe-tsgen", flag.ContinueOnError)
	fs.SetOutput(stderr)
	write := fs.Bool("write", false, "write generated TypeScript files")
	check := fs.Bool("check", false, "verify generated TypeScript files are up to date")
	root := fs.String("root", "", "repository root path (defaults to auto-discovered root from cwd)")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if fs.NArg() > 0 {
		return fmt.Errorf("unexpected positional arguments: %v", fs.Args())
	}
	if *write == *check {
		return errors.New("specify exactly one of --write or --check")
	}

	repoRoot := *root
	if repoRoot == "" {
		discovered, err := findRepoRoot()
		if err != nil {
			return err
		}
		repoRoot = discovered
	} else {
		abs, err := filepath.Abs(repoRoot)
		if err != nil {
			return fmt.Errorf("resolve root %q: %w", repoRoot, err)
		}
		repoRoot = abs
	}

	if err := tsgen.Run(tsgen.Options{RepoRoot: repoRoot, Check: *check}); err != nil {
		return err
	}
	if *check {
		fmt.Fprintln(stdout, "go-contract: up to date")
	} else {
		fmt.Fprintf(stdout, "go-contract: wrote %s and %s\n", tsgen.ShapesRelPath, tsgen.SchemaRelPath)
	}
	return nil
}

func findRepoRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", fmt.Errorf("getwd: %w", err)
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			if _, err := os.Stat(filepath.Join(dir, tsgen.ContractSubdir)); err == nil {
				return dir, nil
			}
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", errors.New("could not locate repository root containing go.mod and pkg/contract")
		}
		dir = parent
	}
}
