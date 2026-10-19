package voice

import (
	"context"
	"encoding/base64"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/ptr"
)

func TestDictationPassesTheRecordingOn(t *testing.T) {
	type seen struct{ auth, model, format, file, name, kind string }
	var got seen
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/audio/transcriptions" {
			http.NotFound(w, r)
			return
		}
		file, header, err := r.FormFile("file")
		if err != nil {
			t.Error(err)
			return
		}
		body, _ := io.ReadAll(file)
		got = seen{r.Header.Get("Authorization"), r.FormValue("model"), r.FormValue("response_format"), string(body), header.Filename, header.Header.Get("Content-Type")}
		io.WriteString(w, `{"text":" 让阿郑改一下 refreshSession "}`)
	}))
	defer endpoint.Close()
	f := voiceTestWorld(t)
	ctx := context.Background()
	recording := base64.StdEncoding.EncodeToString([]byte("RIFF....WAVE"))

	var off protocol.VoiceUnavailable
	if _, err := f.Voice.Dictate(ctx, recording, "wav"); !errors.As(err, &off) || !strings.Contains(off.Reason, "还没配") {
		t.Fatalf("not set: %v", err)
	}
	if _, err := f.Setting.Save(protocol.SettingsUpdate{Dictation: &protocol.Dictation{URL: endpoint.URL + "/v1/", Model: "qwen3"}}); err != nil {
		t.Fatal(err)
	}
	said, err := f.Voice.Dictate(ctx, recording, ".WAV")
	if err != nil || said.Text != "让阿郑改一下 refreshSession" {
		t.Fatalf("dictated %+v %v", said, err)
	}
	if got != (seen{"", "qwen3", "json", "RIFF....WAVE", "dictation.wav", "audio/wav"}) {
		t.Fatalf("passed on %+v", got)
	}
	if _, err := f.Setting.Save(protocol.SettingsUpdate{DictationKey: ptr.To("sk-dictation")}); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Voice.Dictate(ctx, recording, "wav"); err != nil || got.auth != "Bearer sk-dictation" {
		t.Fatalf("with a key: %q %v", got.auth, err)
	}

	var refused protocol.Refused
	for _, c := range []struct{ audio, format string }{{recording, "aiff"}, {"", "wav"}, {"not base64!", "wav"}} {
		if _, err := f.Voice.Dictate(ctx, c.audio, c.format); !errors.As(err, &refused) {
			t.Fatalf("%q %q: %v", c.audio, c.format, err)
		}
	}
}

func TestDictationSaysWhyTheEndpointFailed(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		io.WriteString(w, `{"error":{"message":"Incorrect API key provided"}}`)
	}))
	f := voiceTestWorld(t)
	ctx := context.Background()
	recording := base64.StdEncoding.EncodeToString([]byte("x"))
	if _, err := f.Setting.Save(protocol.SettingsUpdate{Dictation: &protocol.Dictation{URL: endpoint.URL + "/v1", Model: "gpt-4o-mini-transcribe"}}); err != nil {
		t.Fatal(err)
	}
	var down protocol.VoiceUnavailable
	if _, err := f.Voice.Dictate(ctx, recording, "wav"); !errors.As(err, &down) || down.Reason != "听写的地址回了 401：Incorrect API key provided" {
		t.Fatalf("refused: %v", err)
	}
	endpoint.Close()
	if _, err := f.Voice.Dictate(ctx, recording, "wav"); !errors.As(err, &down) || !strings.HasPrefix(down.Reason, "听写的地址连不上") {
		t.Fatalf("gone: %v", err)
	}
}

func TestDictationSettingsAreChecked(t *testing.T) {
	f := voiceTestWorld(t)
	for _, d := range []protocol.Dictation{{URL: "127.0.0.1:8080/v1", Model: "qwen3"}, {URL: "http://127.0.0.1:8080/v1"}} {
		if _, err := f.Setting.Save(protocol.SettingsUpdate{Dictation: &d}); err == nil {
			t.Fatalf("saved %+v", d)
		}
	}
	status, err := f.Setting.Save(protocol.SettingsUpdate{Dictation: &protocol.Dictation{URL: " http://127.0.0.1:8080/v1/ ", Model: " qwen3 "}})
	if err != nil || status.Dictation != (protocol.Dictation{URL: "http://127.0.0.1:8080/v1", Model: "qwen3"}) {
		t.Fatalf("%+v %v", status.Dictation, err)
	}
	if status, err = f.Setting.Save(protocol.SettingsUpdate{Dictation: &protocol.Dictation{}}); err != nil || status.Dictation != (protocol.Dictation{}) {
		t.Fatalf("cleared: %+v %v", status.Dictation, err)
	}
}
