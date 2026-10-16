package acp

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// TokenUsage is one root accumulator shared by prompt replies and proven
// independent vendor reports (token-usage.ts). Callers serialize access
// (the session lock).
type TokenUsage struct {
	profile Profile
	billed  oar.TokenTotals
	seen    map[string]bool
}

// NewTokenUsage starts at zero.
func NewTokenUsage(profile Profile) *TokenUsage {
	return &TokenUsage{profile: profile, seen: map[string]bool{}}
}

// Prompt is a prompt answer's usage event, nil when it carried none.
func (u *TokenUsage) Prompt(response jsonx.Record) oar.EventBody {
	var context *oar.ContextUsage
	if u.profile.PromptContextUsage != nil {
		context = u.profile.PromptContextUsage(response)
	}
	var prompted *oar.TokenTotals
	if u.profile.PromptTokenUsage != nil {
		prompted = u.profile.PromptTokenUsage(response)
	}
	event, billed := PromptUsage(context, prompted, u.billed)
	u.billed = billed
	return event
}

// Extension is a vendor notification's independent root ledger as a usage
// event, nil when it carries none or was already counted.
func (u *TokenUsage) Extension(method string, params jsonx.Record, opened bool) oar.EventBody {
	if u.profile.SpontaneousTokenUsage == nil {
		return nil
	}
	report := u.profile.SpontaneousTokenUsage(method, params)
	if report == nil || u.seen[report.Key] {
		return nil
	}
	u.seen[report.Key] = true
	// Opening can replay old terminal reports. Remember their identity so a
	// later repeated delivery cannot turn history into a fresh charge.
	if !opened || report.Replayed {
		return nil
	}
	event, billed := PromptUsage(nil, &report.Tokens, u.billed)
	u.billed = billed
	return event
}
