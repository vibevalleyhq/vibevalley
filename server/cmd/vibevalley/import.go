package main

// vibevalley import: an existing farm from the TypeScript server (farm.Import). Names and counts are printed, never what
// the files or rows hold: .env, settings.json and the connectors' rows carry keys.
//
//	node server/tool/dump-pglite.ts ~/.heybro ~/.heybro/pglite-dump.json
//	go run ./cmd/vibevalley import ~/.heybro --into ~/Library/Application\ Support/vibevalley --dump ~/.heybro/pglite-dump.json

import (
	"flag"
	"fmt"
	"os"
	"strings"

	"vibevalley/internal/farm"
)

func runImport(args []string) int {
	set := flag.NewFlagSet("vibevalley import", flag.ContinueOnError)
	into := set.String("into", "", "this server's home to import into (VIBEVALLEY_HOME; the desktop apps use ~/Library/Application Support/vibevalley)")
	dump := set.String("dump", "", "the TypeScript home's database, dumped by server/tool/dump-pglite.ts")
	force := set.Bool("force", false, "import into a farm that already has things in it: its database is replaced, its files overwritten")
	set.Usage = func() {
		fmt.Fprintln(set.Output(), "usage: vibevalley import <ts-home> --into <go-home> [--dump <file>] [--force]")
		set.PrintDefaults()
	}
	// The TypeScript home may come before the flags or after them.
	var from string
	if len(args) > 0 && !strings.HasPrefix(args[0], "-") {
		from, args = args[0], args[1:]
	}
	if err := set.Parse(args); err != nil {
		return 2
	}
	if from == "" && set.NArg() > 0 {
		from = set.Arg(0)
	}
	if from == "" || *into == "" {
		set.Usage()
		return 2
	}
	report, err := farm.Import(farm.ImportOptions{From: from, Into: *into, Dump: *dump, Force: *force})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	fmt.Printf("imported %s into %s\n", from, *into)
	fmt.Printf("files: %s\n", strings.Join(report.Files, ", "))
	if len(report.Tables) == 0 {
		fmt.Println("database: none (the TypeScript home had none)")
	}
	for _, t := range report.Tables {
		fmt.Printf("  %-20s %5d rows dumped, %5d in farm.db\n", t.Name, t.Dumped, t.Stored)
	}
	if len(report.Skipped) > 0 {
		fmt.Printf("not kept: %s\n", strings.Join(report.Skipped, ", "))
	}
	return 0
}
