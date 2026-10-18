package feishu

import (
	"context"
	"errors"
	"strings"

	"vibevalley/pkg/x/clock"
)

type LoginProgress struct{ URL string }
type LoginAccount struct {
	App   App
	Owner string
}

// Login owns the registration lease, polling interval and tenant-domain handoff.
func (l *Client) Login(ctx context.Context, progress func(LoginProgress)) (LoginAccount, error) {
	if err := ctx.Err(); err != nil {
		return LoginAccount{}, err
	}
	registration, err := l.register(ctx)
	if err := ctx.Err(); err != nil {
		return LoginAccount{}, err
	}
	if err != nil {
		return LoginAccount{}, err
	}
	attempt, cancel := context.WithTimeout(ctx, registration.Expires)
	defer cancel()
	if progress != nil {
		progress(LoginProgress{URL: registration.URL})
	}
	domain := "feishu"
	for clock.Sleep(attempt, registration.Interval) {
		poll := l.poll(attempt, registration.DeviceCode, domain)
		if attempt.Err() != nil {
			break
		}
		switch poll.Status {
		case "succeeded":
			if strings.TrimSpace(poll.AppID) == "" || strings.TrimSpace(poll.AppSecret) == "" {
				return LoginAccount{}, errors.New("飞书确认了，但没给齐登录信息，请重试。")
			}
			return LoginAccount{App: App{AppID: poll.AppID, AppSecret: poll.AppSecret, Domain: poll.Domain}, Owner: poll.OpenID}, nil
		case "failed":
			return LoginAccount{}, errors.New(poll.Reason)
		}
		domain = poll.Domain
	}
	if err := ctx.Err(); err != nil {
		return LoginAccount{}, err
	}
	return LoginAccount{}, errors.New("等太久没扫，二维码过期了。")
}
