package session

import (
	"testing"

	"vibevalley/internal/testkit"
)

// The wanted values are what a real shell prints for `printf '%s\n' <argument>`.
func TestShellCommandUnwrapsTheShell(t *testing.T) {
	for in, want := range map[string]string{
		`/bin/zsh -lc 'git diff --check && git status'`:     `git diff --check && git status`,
		`/bin/zsh -lc "rg -n '"'"'^##'"'"' docs/server.md"`: `rg -n '"^##"' docs/server.md`,
		`/bin/zsh -lc 'echo '"'"'hi'"'"''`:                  `echo 'hi'`,
		`bash -c 'it'\''s'`:                                 `it's`,
		`/bin/bash -lc "echo \"\$HOME\""`:                   `echo "$HOME"`,
		`git status`:                                        `git status`,
		`/bin/zsh -lc ls`:                                   `ls`,
		`/bin/zsh -lc 'unterminated`:                        `/bin/zsh -lc 'unterminated`,
		`/bin/zsh -lc 'a' b`:                                `/bin/zsh -lc 'a' b`,
	} {
		testkit.Eq(t, shellCommand(in), want, in)
	}
}
