package ai

// A POST is tried again when it fails before any answer comes (no connection, 408, 409, 429, 5xx, 529). The request is bound to the stream's context,
// so cancelling it ends a read waiting on the network at once. What goes wrong is an `error` event, never a failed stream.

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"iter"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var retryStatus = map[int]bool{408: true, 409: true, 429: true, 500: true, 502: true, 503: true, 504: true, 529: true}

// It doubles each time. Tests shorten it.
var retryBase = time.Second

var httpClient = &http.Client{}

type failed struct {
	message string
	retry   bool
}

type httpRequest struct {
	url     string
	headers func(key string) map[string]string
	body    any
	answer  func(body io.Reader) iter.Seq[AssistantMessageEvent]
}

func cut(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}

func streamHTTP(ctx context.Context, model Model, options StreamOptions, request httpRequest) <-chan AssistantMessageEvent {
	out := make(chan AssistantMessageEvent)
	go func() {
		defer close(out)
		say := func(events []AssistantMessageEvent) {
			for _, e := range events {
				if !send(ctx, out, e) {
					return
				}
			}
		}
		key := options.APIKey
		if key == "" {
			key = GetEnvApiKey(model.Provider)
		}
		if key == "" {
			say(NewAnswer(model, "").Error(StopError, "没有 "+model.Provider+" 的密钥", RawUsage{}))
			return
		}
		reqCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		body := marshal(request.body)
		post := func() (*http.Response, *failed) {
			req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, request.url, bytes.NewReader(body))
			if err != nil {
				return nil, &failed{message: "连不上 " + model.Provider + "：" + err.Error(), retry: false}
			}
			req.Header.Set("content-type", "application/json")
			for k, v := range request.headers(key) {
				req.Header.Set(k, v)
			}
			for k, v := range model.Headers {
				req.Header.Set(k, v)
			}
			for k, v := range options.Headers {
				req.Header.Set(k, v)
			}
			res, err := httpClient.Do(req)
			if err != nil {
				return nil, &failed{message: "连不上 " + model.Provider + "：" + err.Error(), retry: true}
			}
			if res.StatusCode < 200 || res.StatusCode > 299 {
				detail, _ := io.ReadAll(res.Body)
				_ = res.Body.Close()
				return nil, &failed{
					message: model.Provider + " 回了 " + strconv.Itoa(res.StatusCode) + "：" + cut(string(detail), 500),
					retry:   retryStatus[res.StatusCode],
				}
			}
			return res, nil
		}
		retries := 2
		if options.MaxRetries != nil {
			retries = *options.MaxRetries
		}
		var res *http.Response
		for attempt := 0; ; attempt++ {
			got, why := post()
			if ctx.Err() != nil {
				if got != nil {
					_ = got.Body.Close()
				}
				return
			}
			if why == nil {
				res = got
				break
			}
			if !why.retry || attempt >= retries {
				say(NewAnswer(model, "").Error(StopError, why.message, RawUsage{}))
				return
			}
			select {
			case <-time.After(retryBase << attempt):
			case <-ctx.Done():
				return
			}
		}
		defer res.Body.Close()
		for e := range request.answer(res.Body) {
			if !send(ctx, out, e) {
				return
			}
		}
	}()
	return out
}

// A read that fails, or data that is not JSON, is yielded as an error and ends it.
func sseData[T any](body io.Reader) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		reader := bufio.NewReader(body)
		for {
			line, err := reader.ReadString('\n')
			if err != nil {
				// What is left without a newline is not a whole line.
				if !errors.Is(err, io.EOF) {
					var zero T
					yield(zero, err)
				}
				return
			}
			line = strings.TrimSpace(line)
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(line[5:])
			if data == "[DONE]" {
				return
			}
			var value T
			if err := json.Unmarshal([]byte(data), &value); err != nil {
				var zero T
				yield(zero, err)
				return
			}
			if !yield(value, nil) {
				return
			}
		}
	}
}
