package main

// vibevalley migrate: a farm kept under the project's old names (heybro, vibefarm) moved to VibeValley's, once
// (farm.MigrateOldNames). It refuses while a farm server runs: the folders it moves would be written to meanwhile.
//
//	go run ./cmd/vibevalley migrate --dry-run   # what would move
//	go run ./cmd/vibevalley migrate

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"

	"vibevalley/internal/farm"
)

func runMigrate(args []string) int {
	set := flag.NewFlagSet("vibevalley migrate", flag.ContinueOnError)
	dryRun := set.Bool("dry-run", false, "only say what would move")
	force := set.Bool("force", false, "migrate even while a farm server seems to run")
	if err := set.Parse(args); err != nil {
		return 2
	}
	home, err := os.UserHomeDir()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	if !*dryRun && !*force {
		if running := farmServers(); len(running) > 0 {
			fmt.Fprintf(os.Stderr, "a farm server is running; quit the app (or stop it) first:\n%s\n", strings.Join(running, "\n"))
			return 1
		}
	}
	report, err := farm.MigrateOldNames(farm.MigrateOptions{UserHome: home, DryRun: *dryRun})
	verb := "moved"
	if *dryRun {
		verb = "would move"
	}
	for _, m := range report.Moves {
		fmt.Printf("%s %s → %s\n", verb, m[0], m[1])
	}
	for _, p := range report.Prefs {
		fmt.Printf("preferences: %s\n", p)
	}
	for _, s := range report.Skipped {
		fmt.Printf("left as it is: %s\n", s)
	}
	if len(report.Rewritten) > 0 {
		fmt.Printf("rewritten: %s\n", strings.Join(report.Rewritten, ", "))
	}
	if len(report.Worktrees) > 0 {
		fmt.Printf("worktrees repaired: %s\n", strings.Join(report.Worktrees, ", "))
	}
	if len(report.Branches) > 0 {
		fmt.Printf("branches renamed: %s\n", strings.Join(report.Branches, ", "))
	}
	if report.Backup != "" {
		fmt.Printf("backup: %s\n", report.Backup)
	}
	if len(report.Moves) == 0 && len(report.Prefs) == 0 {
		fmt.Println("nothing to migrate")
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	return 0
}

// farmServers are the farm servers running now, by their process names (the app's, under each name the project had,
// and `go run ./cmd/vibevalley`), as "pid name"; this process is not one of them.
func farmServers() []string {
	var running []string
	for _, name := range []string{"heybro-server", "vibefarm-server", "vibevalley-server", "vibevalley"} {
		out, err := exec.Command("pgrep", "-x", name).Output()
		if err != nil {
			continue
		}
		for _, pid := range strings.Fields(string(out)) {
			if pid != strconv.Itoa(os.Getpid()) {
				running = append(running, pid+" "+name)
			}
		}
	}
	return running
}
