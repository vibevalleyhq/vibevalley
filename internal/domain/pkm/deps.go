package pkm

// Pin markdown and sqlite-vec engines in go.mod before Swarm workers branch.
import (
	_ "github.com/viant/sqlite-vec/engine"
	_ "github.com/viant/sqlite-vec/vec"
	_ "github.com/viant/sqlite-vec/vector"
	_ "github.com/yuin/goldmark"
	_ "go.abhg.dev/goldmark/frontmatter"
)
