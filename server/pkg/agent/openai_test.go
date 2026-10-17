package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

func chatServe(t *testing.T, c ChatCompletions) string {
	t.Helper()
	server := httptest.NewServer(c)
	t.Cleanup(server.Close)
	return server.URL
}

func chatAsk(t *testing.T, url string, body any) (*http.Response, string) {
	t.Helper()
	raw, _ := json.Marshal(body)
	res, err := http.Post(url, "application/json", strings.NewReader(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(res.Body)
	return res, string(got)
}

func chatWords(words ...string) <-chan string {
	out := make(chan string, len(words))
	for _, w := range words {
		out <- w
	}
	close(out)
	return out
}

func chatOnly(model string, answer func(ctx context.Context, text string) <-chan string) func(string) func(context.Context, string) <-chan string {
	return func(m string) func(context.Context, string) <-chan string {
		if m != model {
			return nil
		}
		return answer
	}
}

func TestChatCompletionsTakesTheNewestUserText(t *testing.T) {
	for raw, want := range map[string]string{
		`{"messages":[{"role":"system","content":"你是管家"},{"role":"user","content":"旧的"},{"role":"assistant","content":"好"},{"role":"user","content":" 让老周跑测试 "}]}`: "让老周跑测试",
		`{"messages":[{"role":"user","content":[{"type":"text","text":"看看"},{"type":"image_url"},{"type":"text","text":"进度"}]}]}`:                                  "看看进度",
		`{"messages":[{"role":"assistant","content":"好"}]}`: "",
		`{}`: "",
	} {
		var req chatRequest
		if err := json.Unmarshal([]byte(raw), &req); err != nil {
			t.Fatal(err)
		}
		if got := req.newestUserText(); got != want {
			t.Fatalf("%s: %q", raw, got)
		}
	}
}

func TestChatCompletionsChunksAreOpenAIs(t *testing.T) {
	var first, want any
	json.Unmarshal([]byte(strings.TrimPrefix(chatChunk("id1", 7, "m", "好", false, true), "data: ")), &first)
	json.Unmarshal([]byte(`{"id":"id1","object":"chat.completion.chunk","created":7,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}`), &want)
	if !reflect.DeepEqual(first, want) {
		t.Fatalf("first: %v", first)
	}
	var stop any
	json.Unmarshal([]byte(strings.TrimPrefix(chatChunk("id1", 7, "m", "", true, false), "data: ")), &stop)
	choice := stop.(map[string]any)["choices"].([]any)[0]
	if !reflect.DeepEqual(choice, map[string]any{"index": float64(0), "delta": map[string]any{}, "finish_reason": "stop"}) {
		t.Fatalf("stop: %v", choice)
	}
}

func TestChatCompletionsAnswersWholeWithoutStream(t *testing.T) {
	var heard string
	url := chatServe(t, ChatCompletions{Answerer: chatOnly("m", func(_ context.Context, text string) <-chan string {
		heard = text
		return chatWords("好，", "这就去。")
	})})
	res, body := chatAsk(t, url, map[string]any{"model": "m", "messages": []any{map[string]any{"role": "user", "content": "跑测试"}}})
	var got struct {
		Object  string `json:"object"`
		Model   string `json:"model"`
		Choices []struct {
			Message      struct{ Role, Content string } `json:"message"`
			FinishReason string                         `json:"finish_reason"`
		} `json:"choices"`
	}
	json.Unmarshal([]byte(body), &got)
	if res.StatusCode != 200 || got.Object != "chat.completion" || got.Model != "m" || len(got.Choices) != 1 {
		t.Fatalf("%d %s", res.StatusCode, body)
	}
	if c := got.Choices[0]; c.Message.Role != "assistant" || c.Message.Content != "好，这就去。" || c.FinishReason != "stop" || heard != "跑测试" {
		t.Fatalf("%+v heard %q", c, heard)
	}
}

func TestChatCompletionsRefusesInOpenAIsShape(t *testing.T) {
	answer := func(context.Context, string) <-chan string { return chatWords("在") }
	strict := chatServe(t, ChatCompletions{Answerer: chatOnly("m", answer)})
	lenient := chatServe(t, ChatCompletions{Answerer: chatOnly("m", answer), Misheard: "没听清"})
	for _, c := range []struct {
		url    string
		body   any
		status int
		code   string
	}{
		{strict, map[string]any{"model": "nope", "messages": []any{map[string]any{"role": "user", "content": "在吗"}}}, 404, "model_not_found"},
		{strict, map[string]any{"model": "m", "messages": []any{}}, 400, "no_user_message"},
		{strict, "not an object", 400, "invalid_json"},
	} {
		res, body := chatAsk(t, c.url, c.body)
		var got struct {
			Error struct{ Code string } `json:"error"`
		}
		json.Unmarshal([]byte(body), &got)
		if res.StatusCode != c.status || got.Error.Code != c.code {
			t.Fatalf("%v: %d %s", c.body, res.StatusCode, body)
		}
	}
	if res, body := chatAsk(t, lenient, map[string]any{"model": "m", "messages": []any{}}); res.StatusCode != 200 || !strings.Contains(body, "没听清") {
		t.Fatalf("misheard: %d %s", res.StatusCode, body)
	}
	if res, err := http.Get(strict); err != nil || res.StatusCode != 405 {
		t.Fatalf("GET: %v %v", res, err)
	}
}
