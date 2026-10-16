package runs

// Tokens tell helpers apart; they guard nothing (helpers already run unsandboxed on this machine), so they live in memory only.

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

// The helper's old token stops working.
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
