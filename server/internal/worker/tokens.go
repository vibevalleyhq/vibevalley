package worker

// Tokens tell workers apart; they guard nothing (workers already run unsandboxed on this machine), so they live in memory only.

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"sync"
)

type tokens struct {
	mu       sync.Mutex
	byWorker map[string]string
}

func newTokens() (*tokens, error)             { return &tokens{byWorker: map[string]string{}}, nil }
func (*tokens) OnStart(context.Context) error { return nil }
func (*tokens) OnStop()                       {}

// The worker's old token stops working.
func (t *tokens) Issue(worker string) string {
	raw := make([]byte, 18)
	_, _ = rand.Read(raw)
	token := "hb_" + worker + "_" + base64.RawURLEncoding.EncodeToString(raw)
	t.mu.Lock()
	t.byWorker[worker] = token
	t.mu.Unlock()
	return token
}

func (t *tokens) Revoke(worker string) {
	t.mu.Lock()
	delete(t.byWorker, worker)
	t.mu.Unlock()
}

func (t *tokens) Who(token string) string {
	t.mu.Lock()
	defer t.mu.Unlock()
	for worker, tk := range t.byWorker {
		if tk == token {
			return worker
		}
	}
	return ""
}
