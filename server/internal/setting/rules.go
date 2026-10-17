package setting

import (
	"regexp"
	"strings"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

func keyHint(key string) string { return "…" + str.Slice(key, -4, str.Units(key)) }

var settingsAgora = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)

// Empty strings clear and are always fine.
func settingsProblem(u protocol.SettingsUpdate) string {
	trimmed := func(s *string) string {
		if s == nil {
			return ""
		}
		return str.Trim(*s)
	}
	if deepseek := trimmed(u.DeepseekAPIKey); deepseek != "" && (strings.ContainsFunc(deepseek, str.IsSpace) || str.Units(deepseek) < 8) {
		return "DeepSeek 的 API Key 看着不对：一串不带空格的字，通常以 sk- 开头"
	}
	if appID := trimmed(u.AgoraAppID); appID != "" && !settingsAgora.MatchString(appID) {
		return "Agora 的 App ID 是 32 位的十六进制，在声网控制台的项目里找"
	}
	if certificate := trimmed(u.AgoraAppCertificate); certificate != "" && !settingsAgora.MatchString(certificate) {
		return "Agora 的 App Certificate 是 32 位的十六进制，在声网控制台的项目里找"
	}
	for _, key := range []*string{u.ASRKey, u.LLMKey, u.TTSKey} {
		if strings.ContainsFunc(trimmed(key), str.IsSpace) {
			return "语音服务的 key 里不该有空格"
		}
	}
	if u.Voice == nil {
		return ""
	}
	return voiceProblem(*u.Voice)
}
