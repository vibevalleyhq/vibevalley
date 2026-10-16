package kimi

import (
	"context"
	"io"
	"net/http"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
)

// Kimi's authenticated `/me` profile: the best-effort identity half of account usage.

// AccountIdentity is who the account is, where /me says.
type AccountIdentity struct {
	Email       string
	Plan        string
	DisplayName string
}

func authenticatedField(payload any, field string) string {
	profile := jsonx.AsRecord(payload)
	if text(profile["user_id"]) == "" {
		return ""
	}
	return text(profile[field])
}

// AccountEmail extracts identity only from kimi's authenticated `/me` profile shape.
func AccountEmail(payload any) string { return authenticatedField(payload, "email") }

// AccountPlan is the human-readable membership level `/me` reports.
func AccountPlan(payload any) string { return authenticatedField(payload, "user_level_name") }

// AccountDisplayName is the profile nickname: phone or WeChat sign-ins have
// no email, so this is often the only readable identity.
func AccountDisplayName(payload any) string { return authenticatedField(payload, "nickname") }

// httpClient is what the account reads use (tests replace its transport).
var httpClient = http.DefaultClient

func authorizedGet(ctx context.Context, url, accessToken string, deadline time.Time) (*http.Response, error) {
	timeout, err := remainingMs(deadline)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+accessToken)
	request.Header.Set("Accept", "application/json")
	response, err := httpClient.Do(request)
	if err != nil {
		cancel()
		return nil, err
	}
	response.Body = cancelOnClose{response.Body, cancel}
	return response, nil
}

type cancelOnClose struct {
	io.ReadCloser
	cancel context.CancelFunc
}

func (c cancelOnClose) Close() error {
	err := c.ReadCloser.Close()
	c.cancel()
	return err
}

// FetchAccountIdentity reads `/me`. Identity is a best-effort add-on: a
// missing or older profile endpoint or a transient failure must not discard
// an otherwise valid quota snapshot, so every failure is an empty identity.
func FetchAccountIdentity(ctx context.Context, auth AuthContext, accessToken string, deadline time.Time) AccountIdentity {
	response, err := authorizedGet(ctx, auth.BaseURL+"/me", accessToken, deadline)
	if err != nil {
		return AccountIdentity{}
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return AccountIdentity{}
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return AccountIdentity{}
	}
	profile, _ := jsonx.Parse(body)
	return AccountIdentity{Email: AccountEmail(profile), Plan: AccountPlan(profile), DisplayName: AccountDisplayName(profile)}
}
