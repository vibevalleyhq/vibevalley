package voice

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"strings"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/setting"
	"vibevalley/pkg/x/str"
)

// OpenAI's own cap on one recording.
const dictateMaxBytes = 25 << 20

var dictateFormats = map[string]string{
	"wav": "audio/wav", "m4a": "audio/mp4", "mp3": "audio/mpeg", "webm": "audio/webm", "ogg": "audio/ogg", "flac": "audio/flac",
}

var dictateOff = protocol.VoiceUnavailable{Reason: "听写还没配：在「声音」页的「听写」里填地址和模型"}

// Passes a recording on to the OpenAI-compatible transcription endpoint the owner set, as it is: no prompt, no change to the
// sound. Which model runs where is that endpoint's business.
type dictation struct {
	settings *setting.Service
	client   *http.Client
}

func newDictation(settings *setting.Service) (*dictation, error) {
	// A local model's first request loads it, which takes a while.
	return &dictation{settings: settings, client: &http.Client{Timeout: 2 * time.Minute}}, nil
}

func (*dictation) OnStart(context.Context) error { return nil }
func (*dictation) OnStop()                       {}

func (d *dictation) Dictate(ctx context.Context, audio64, format string) (protocol.Dictated, error) {
	config, on := d.settings.Dictation()
	if !on {
		return protocol.Dictated{}, dictateOff
	}
	format = strings.ToLower(strings.TrimPrefix(str.Trim(format), "."))
	kind, ok := dictateFormats[format]
	if !ok {
		return protocol.Dictated{}, protocol.Refused{Reason: fmt.Sprintf("听写认不得 %q 这种录音", format)}
	}
	audio, err := base64.StdEncoding.DecodeString(audio64)
	if err != nil || len(audio) == 0 {
		return protocol.Dictated{}, protocol.Refused{Reason: "录音是空的，或者不是 base64"}
	}
	if len(audio) > dictateMaxBytes {
		return protocol.Dictated{}, protocol.Refused{Reason: "录音太长了：一段不超过 25 MB"}
	}
	text, err := dictateOnce(ctx, d.client, config, audio, format, kind)
	if err != nil {
		return protocol.Dictated{}, err
	}
	return protocol.Dictated{Text: text}, nil
}

func dictateOnce(ctx context.Context, client *http.Client, config setting.DictationConfig, audio []byte, format, kind string) (string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreatePart(map[string][]string{
		"Content-Disposition": {fmt.Sprintf(`form-data; name="file"; filename="dictation.%s"`, format)},
		"Content-Type":        {kind},
	})
	if err != nil {
		return "", err
	}
	part.Write(audio)
	form.WriteField("model", config.Model)
	form.WriteField("response_format", "json")
	form.Close()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, config.URL+"/audio/transcriptions", &body)
	if err != nil {
		return "", protocol.VoiceUnavailable{Reason: "听写的地址不对：" + err.Error()}
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	if config.Key != "" {
		req.Header.Set("Authorization", "Bearer "+config.Key)
	}
	res, err := client.Do(req)
	if err != nil {
		if errors.Is(ctx.Err(), context.Canceled) {
			return "", err
		}
		return "", protocol.VoiceUnavailable{Reason: "听写的地址连不上：" + err.Error()}
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var got struct {
		Text  string `json:"text"`
		Error *struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	decoded := json.Unmarshal(raw, &got) == nil
	if res.StatusCode/100 != 2 {
		reason := strings.TrimSpace(string(raw))
		if decoded && got.Error != nil && got.Error.Message != "" {
			reason = got.Error.Message
		}
		return "", protocol.VoiceUnavailable{Reason: fmt.Sprintf("听写的地址回了 %d：%s", res.StatusCode, str.Head(reason, 200))}
	}
	if !decoded {
		return "", protocol.VoiceUnavailable{Reason: "听写的地址回的不是 OpenAI 的转写格式"}
	}
	return strings.TrimSpace(got.Text), nil
}
