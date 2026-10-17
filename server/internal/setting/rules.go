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
	for _, key := range []*string{u.ASRKey, u.LLMKey, u.TTSKey, u.DictationKey} {
		if strings.ContainsFunc(trimmed(key), str.IsSpace) {
			return "语音服务的 key 里不该有空格"
		}
	}
	if d := u.Dictation; d != nil && str.Trim(d.URL) != "" {
		if !voiceURL.MatchString(str.Trim(d.URL)) {
			return "听写的地址要是 http(s) 开头的完整地址，到 /v1 为止，比如本机的 http://127.0.0.1:8080/v1"
		}
		if str.Trim(d.Model) == "" {
			return "听写要填模型名，比如本机 speech-server 的 qwen3，或 OpenAI 的 gpt-4o-mini-transcribe"
		}
	}
	if u.Voice == nil {
		return ""
	}
	return voiceProblem(*u.Voice)
}
