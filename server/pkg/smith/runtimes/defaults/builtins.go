package defaults

import (
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/runtimes/antigravity"
	"vibevalley/pkg/smith/runtimes/claude"
	"vibevalley/pkg/smith/runtimes/codex"
	"vibevalley/pkg/smith/runtimes/grok"
	"vibevalley/pkg/smith/runtimes/kimi"
	"vibevalley/pkg/smith/runtimes/opencode"
	"vibevalley/pkg/smith/runtimes/pi"
)

// builtins lists the ported runtimes, alphabetically (antigravity, claude, codex, grok, kimi, opencode, pi).
func builtins() []oar.Runtime {
	return []oar.Runtime{
		antigravity.Runtime(),
		claude.Runtime(),
		codex.Runtime(),
		grok.Runtime(),
		kimi.Runtime(),
		opencode.Runtime(),
		pi.Runtime(),
	}
}
