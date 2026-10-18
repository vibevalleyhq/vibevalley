package weixin

import (
	"context"
	"errors"
	"fmt"
	"time"

	"vibevalley/pkg/x/clock"
)

type LoginState string

const (
	LoginWaiting LoginState = "waiting"
	LoginScanned LoginState = "scanned"
	LoginVerify  LoginState = "verify"
)

type LoginProgress struct {
	State LoginState
	URL   string
}
type LoginAccount struct {
	Account      Account
	BotID, Owner string
}

// Login owns one QR attempt: redirects, expiry refreshes and verification stay inside the WeChat protocol.
// verification reads the most recent code without taking ownership of the UI that collects it.
func (l *Client) Login(ctx context.Context, progress func(LoginProgress), verification func() string) (LoginAccount, error) {
	if err := ctx.Err(); err != nil {
		return LoginAccount{}, err
	}
	code, show, err := l.qrCode(ctx)
	if err := ctx.Err(); err != nil {
		return LoginAccount{}, err
	}
	if err != nil {
		return LoginAccount{}, fmt.Errorf("拿不到登录二维码：%w", err)
	}
	notify := func(state LoginState) {
		if progress != nil {
			progress(LoginProgress{State: state, URL: show})
		}
	}
	notify(LoginWaiting)
	attempt, cancel := context.WithTimeout(ctx, 8*time.Minute)
	defer cancel()
	baseURL, refreshes := l.base, 0
	for attempt.Err() == nil {
		number := ""
		if verification != nil {
			number = verification()
		}
		status := l.qrStatus(attempt, baseURL, code, number)
		if attempt.Err() != nil {
			break
		}
		switch status.Status {
		case "scaned":
			notify(LoginScanned)
		case "need_verifycode":
			notify(LoginVerify)
			clock.Sleep(attempt, time.Second)
		case "scaned_but_redirect":
			if status.RedirectHost != "" {
				baseURL = "https://" + status.RedirectHost
			}
		case "expired", "verify_code_blocked":
			refreshes++
			if refreshes >= 3 {
				if status.Status == "expired" {
					return LoginAccount{}, errors.New("二维码过期了几次，请重新开始。")
				}
				return LoginAccount{}, errors.New("数字输错了几次，请重新开始。")
			}
			code, show, err = l.qrCode(attempt)
			if attempt.Err() != nil {
				break
			}
			if err != nil {
				return LoginAccount{}, fmt.Errorf("拿不到登录二维码：%w", err)
			}
			notify(LoginWaiting)
		case "binded_redirect":
			return LoginAccount{}, errors.New("这个微信已经连过了：先在微信里删掉它，或者换一个微信扫。")
		case "confirmed":
			if status.BotToken == "" || status.IlinkBotID == "" || status.IlinkUserID == "" {
				return LoginAccount{}, errors.New("微信确认了，但没给齐登录信息，请重试。")
			}
			at := status.BaseURL
			if at == "" {
				at = baseURL
			}
			return LoginAccount{Account: Account{BaseURL: at, Token: status.BotToken}, BotID: status.IlinkBotID, Owner: status.IlinkUserID}, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return LoginAccount{}, err
	}
	return LoginAccount{}, errors.New("等太久没扫，二维码过期了。")
}
