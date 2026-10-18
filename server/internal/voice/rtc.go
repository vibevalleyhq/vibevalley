package voice

import (
	"context"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/agora"
)

type rtcIdentity struct{ channel, uid string }
type rtcGrant struct {
	credentials agora.Credentials
	expires     time.Time
	starting    bool
	agent       string
}

// Pending grants have the same validity as their signed token; active calls own their grant until Stop.
func (v *voice) pruneGrants() {
	now := v.now()
	for key, grant := range v.grants {
		if !grant.starting && grant.agent == "" && !grant.expires.After(now) {
			delete(v.grants, key)
		}
	}
}

func signGrant(credentials agora.Credentials, key rtcIdentity) (protocol.AgoraGrant, error) {
	token, err := agora.Token(credentials, key.channel, key.uid)
	if err != nil {
		return protocol.AgoraGrant{}, protocol.VoiceUnavailable{Reason: "签不出语音令牌：" + err.Error()}
	}
	return protocol.AgoraGrant{AppID: credentials.AppID, Channel: key.channel, UID: key.uid, Token: token}, nil
}

func (v *voice) Session(context.Context) (protocol.AgoraGrant, error) {
	credentials, err := v.creds()
	if err != nil {
		return protocol.AgoraGrant{}, err
	}
	key := rtcIdentity{agora.NewChannel("vibevalley"), agora.NewUID()}
	issued, err := signGrant(credentials, key)
	if err != nil {
		return protocol.AgoraGrant{}, err
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.stopped {
		return protocol.AgoraGrant{}, protocol.VoiceUnavailable{Reason: "语音服务已经停下"}
	}
	v.pruneGrants()
	v.grants[key] = &rtcGrant{credentials: credentials, expires: v.now().Add(time.Duration(agora.TokenSeconds) * time.Second)}
	return issued, nil
}

func (v *voice) Renew(_ context.Context, channel, uid string) (protocol.AgoraGrant, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.pruneGrants()
	key := rtcIdentity{channel, uid}
	grant := v.grants[key]
	if grant == nil {
		return protocol.AgoraGrant{}, protocol.VoiceUnavailable{Reason: "这通电话的语音凭据已经失效，请重新接通"}
	}
	issued, err := signGrant(grant.credentials, key)
	if err != nil {
		return protocol.AgoraGrant{}, err
	}
	grant.expires = v.now().Add(time.Duration(agora.TokenSeconds) * time.Second)
	return issued, nil
}

func (v *voice) takeGrant(key rtcIdentity) (*rtcGrant, error) {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.pruneGrants()
	grant := v.grants[key]
	if grant == nil {
		return nil, protocol.VoiceUnavailable{Reason: "这通电话的语音凭据已经失效，请重新接通"}
	}
	if grant.starting || grant.agent != "" {
		return nil, protocol.VoiceUnavailable{Reason: "这通电话已经在接通"}
	}
	grant.starting = true
	return grant, nil
}

func (v *voice) revokeGrant(key rtcIdentity, grant *rtcGrant) {
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.grants[key] == grant {
		delete(v.grants, key)
	}
}

func (v *voice) OnStop() {
	v.mu.Lock()
	defer v.mu.Unlock()
	v.stopped = true
	clear(v.grants)
}
