package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/vibevalleyhq/vibevalley/pkg/contract/tsgen"
)

const version = "0.1.0-dev"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "vibe-tsgen: %v\n", err)
		os.Exit(1)
	}
}

func newRootCommand(stdout, stderr io.Writer) *cobra.Command {
	if stdout == nil {
		stdout = os.Stdout
	}
	if stderr == nil {
		stderr = os.Stderr
	}

	var (
		write    bool
		check    bool
		rootPath string
	)

	rootCmd := &cobra.Command{
		Use:           "vibe-tsgen",
		Short:         "Generate TypeScript contracts and Zod schemas from pkg/contract",
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(_ *cobra.Command, _ []string) error {
			if write == check {
				return errors.New("specify exactly one of --write or --check")
			}
			return executeTSGen(rootPath, check, stdout)
		},
	}
	rootCmd.SetOut(stdout)
	rootCmd.SetErr(stderr)
	rootCmd.SetVersionTemplate("vibe-tsgen {{.Version}}\n")

	rootCmd.PersistentFlags().StringVar(&rootPath, "root", "", "repository root path (defaults to auto-discovered root from cwd)")
	rootCmd.Flags().BoolVar(&write, "write", false, "write generated TypeScript files")
	rootCmd.Flags().BoolVar(&check, "check", false, "verify generated TypeScript files are up to date")

	generateCmd := &cobra.Command{
		Use:   "generate",
		Short: "Write generated TypeScript files",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return executeTSGen(rootPath, false, stdout)
		},
	}

	checkCmd := &cobra.Command{
		Use:   "check",
		Short: "Verify generated TypeScript files are up to date",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			return executeTSGen(rootPath, true, stdout)
		},
	}

	versionCmd := &cobra.Command{
		Use:   "version",
		Short: "Print vibe-tsgen version",
		Args:  cobra.NoArgs,
		RunE: func(_ *cobra.Command, _ []string) error {
			_, err := fmt.Fprintf(stdout, "vibe-tsgen %s\n", version)
			return err
		},
	}

	rootCmd.AddCommand(generateCmd, checkCmd, versionCmd)
	return rootCmd
}

func run(args []string, stdout io.Writer, stderr io.Writer) error {
	rootCmd := newRootCommand(stdout, stderr)
	if args == nil {
		args = []string{}
	}
	rootCmd.SetArgs(args)
	return rootCmd.Execute()
}

func executeTSGen(rootPath string, check bool, stdout io.Writer) error {
	repoRoot := rootPath
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

	if err := tsgen.Run(tsgen.Options{RepoRoot: repoRoot, Check: check}); err != nil {
		return err
	}
	if check {
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
