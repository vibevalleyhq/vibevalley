package runs

// Who is calling the farm's tools (ported from the TypeScript server's tokens.ts, removed): each helper session gets a token of its own, sent
// back as a bearer token by the runtime's MCP client (the farm's /mcp tools). Tokens tell helpers apart; they guard
// nothing (helpers already run unsandboxed on this machine), so they live in memory only and change with every
// session.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"sync"
)

type Tokens struct {
	mu       sync.Mutex
	byHelper map[string]string
}

func newTokens() (*Tokens, error)             { return &Tokens{byHelper: map[string]string{}}, nil }
func (*Tokens) OnStart(context.Context) error { return nil }
func (*Tokens) OnStop()                       {}

// Issue is a fresh token for the helper's new session; its old one stops working.
func (t *Tokens) Issue(helper string) string {
	raw := make([]byte, 18)
	_, _ = rand.Read(raw)
	token := "hb_" + helper + "_" + base64.RawURLEncoding.EncodeToString(raw)
	t.mu.Lock()
	t.byHelper[helper] = token
	t.mu.Unlock()
	return token
}

func (t *Tokens) Revoke(helper string) {
	t.mu.Lock()
	delete(t.byHelper, helper)
	t.mu.Unlock()
}

// Who is the helper a token belongs to; "" when none.
func (t *Tokens) Who(token string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	for helper, tk := range t.byHelper {
		if tk == token {
			return helper
		}
	}
	return ""
}
