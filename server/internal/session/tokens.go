package session

// Tokens tell sessions apart; they guard nothing (sessions already run unsandboxed on this machine), so they live in memory only.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"sync"
)

type tokens struct {
	mu        sync.Mutex
	bySession map[string]string
}

func newTokens() (*tokens, error)             { return &tokens{bySession: map[string]string{}}, nil }
func (*tokens) OnStart(context.Context) error { return nil }
func (*tokens) OnStop()                       {}

// The session's old token stops working.
func (t *tokens) Issue(session string) string {
	raw := make([]byte, 18)
	_, _ = rand.Read(raw)
	token := "hb_" + session + "_" + base64.RawURLEncoding.EncodeToString(raw)
	t.mu.Lock()
	t.bySession[session] = token
	t.mu.Unlock()
	return token
}

func (t *tokens) Revoke(session string) {
	t.mu.Lock()
	delete(t.bySession, session)
	t.mu.Unlock()
}

func (t *tokens) Who(token string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	for session, tk := range t.bySession {
		if tk == token {
			return session
		}
	}
	return ""
}
