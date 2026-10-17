package protocol

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// Client calls a VibeValley server's Handlers over HTTP; its methods are generated (gen.go), one per endpoint. A tagged
// error the server answers (Refused, Missing…) comes back as that type, so errors.As works as on the server.
type Client struct {
	// Base is the server's address, e.g. http://127.0.0.1:8787.
	Base string
	// HTTP is the client to use; nil is http.DefaultClient.
	HTTP *http.Client
	// Header is added to every request (Authorization for a key).
	Header http.Header
}

var _ Handlers = (*Client)(nil)

// Do sends one request and returns the answer's body as is: the status is 2xx, or the error is the tagged one the
// server answered. The command line uses it for endpoints it calls by name.
func (c *Client) Do(ctx context.Context, method, path string, q url.Values, body []byte) ([]byte, error) {
	res, err := c.request(ctx, method, path, q, body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	if res.StatusCode/100 != 2 {
		return nil, answeredError(res.StatusCode, out)
	}
	return out, nil
}

func (c *Client) request(ctx context.Context, method, path string, q url.Values, body []byte) (*http.Response, error) {
	var in io.Reader
	if body != nil {
		in = bytes.NewReader(body)
	}
	target := strings.TrimRight(c.Base, "/") + path
	if len(q) > 0 {
		target += "?" + q.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, in)
	if err != nil {
		return nil, err
	}
	for k, vs := range c.Header {
		req.Header[k] = vs
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	client := c.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	return client.Do(req)
}

// Stream owns the HTTP response and SSE framing. Returning false stops after this event; errors and cancellation close the response too.
func (c *Client) Stream(ctx context.Context, path string, consume func(json.RawMessage) (bool, error)) error {
	res, err := c.request(ctx, http.MethodGet, path, nil, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		body, err := io.ReadAll(res.Body)
		if err != nil {
			return err
		}
		return answeredError(res.StatusCode, body)
	}
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 1<<20), 64<<20)
	var data []string
	for scanner.Scan() {
		line := scanner.Text()
		if value, ok := strings.CutPrefix(line, "data:"); ok {
			data = append(data, strings.TrimPrefix(value, " "))
		} else if line == "" && len(data) > 0 {
			more, err := consume(json.RawMessage(strings.Join(data, "\n")))
			if err != nil || !more {
				return err
			}
			data = nil
		}
	}
	return scanner.Err()
}

// call is Do for a generated method: in is encoded as the body when not nil, the answer decoded into out when not nil.
func (c *Client) call(ctx context.Context, method, path string, q url.Values, in, out any) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	got, err := c.Do(ctx, method, path, q, body)
	if err != nil || out == nil || len(got) == 0 {
		return err
	}
	return json.Unmarshal(got, out)
}

// answeredError is the server's tagged error when the body is one, else the status and the body's text.
func answeredError(status int, body []byte) error {
	var head struct {
		Tag string `json:"_tag"`
	}
	if json.Unmarshal(body, &head) == nil && head.Tag != "" {
		if err := taggedError(head.Tag, body); err != nil {
			return err
		}
	}
	return fmt.Errorf("%d %s: %s", status, http.StatusText(status), strings.TrimSpace(string(body)))
}
