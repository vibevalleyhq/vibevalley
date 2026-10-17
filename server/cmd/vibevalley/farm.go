package main

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode"

	"vibevalley/internal/protocol"
)

// Farm commands: one per endpoint in protocol.Endpoints, `vibevalley <group> <op> [path parameters…] [--query value…]
// [--json body]`, sent to the server over HTTP and its answer printed as JSON. Nothing here knows an endpoint by name.

const defaultServer = "http://127.0.0.1:8787"

var pathParam = regexp.MustCompile(`\{(\w+)\}`)

// args splits a command's words into its positional ones and its --name value flags (--name=value too).
type args struct {
	words []string
	flags map[string]string
}

// Flags that take no value.
var switches = []string{"watch"}

func parseArgs(raw []string) (args, error) {
	a := args{flags: map[string]string{}}
	for i := 0; i < len(raw); i++ {
		w := raw[i]
		name, ok := strings.CutPrefix(w, "--")
		if !ok || name == "" {
			a.words = append(a.words, w)
			continue
		}
		if k, v, ok := strings.Cut(name, "="); ok {
			a.flags[k] = v
			continue
		}
		if slices.Contains(switches, name) {
			a.flags[name] = "true"
			continue
		}
		if i+1 >= len(raw) {
			return a, fmt.Errorf("--%s 后面要一个值", name)
		}
		a.flags[name] = raw[i+1]
		i++
	}
	return a, nil
}

func client(a args) *protocol.Client {
	return &protocol.Client{Base: cmp.Or(a.flags["server"], os.Getenv("VIBEVALLEY_SERVER"), defaultServer)}
}

// kebab is how a command writes an op: editNode is edit-node.
func kebab(op string) string {
	var b strings.Builder
	for i, r := range op {
		if unicode.IsUpper(r) {
			if i > 0 {
				b.WriteByte('-')
			}
			r = unicode.ToLower(r)
		}
		b.WriteRune(r)
	}
	return b.String()
}

func endpoint(group, op string) (protocol.Endpoint, bool) {
	for _, e := range protocol.Endpoints {
		g, o, _ := strings.Cut(e.Op, ".")
		if g == group && kebab(o) == op {
			return e, true
		}
	}
	return protocol.Endpoint{}, false
}

func isGroup(word string) bool {
	return slices.ContainsFunc(protocol.Endpoints, func(e protocol.Endpoint) bool { return strings.HasPrefix(e.Op, word+".") })
}

// call runs one farm command: words[0] is the group, words[1] the op.
func call(ctx context.Context, raw []string) error {
	a, err := parseArgs(raw)
	if err != nil {
		return err
	}
	if len(a.words) < 2 {
		return usage(os.Stderr, a.words[0])
	}
	e, ok := endpoint(a.words[0], a.words[1])
	if !ok {
		usage(os.Stderr, a.words[0])
		return fmt.Errorf("没有 %s %s", a.words[0], a.words[1])
	}
	names := pathParam.FindAllStringSubmatch(e.Path, -1)
	given := a.words[2:]
	if len(given) != len(names) {
		return fmt.Errorf("%s 要 %d 个参数（%s），给了 %d 个", e.Op, len(names), placeholders(e.Path), len(given))
	}
	i := 0
	path := pathParam.ReplaceAllStringFunc(e.Path, func(string) string { i++; return url.PathEscape(given[i-1]) })
	q := url.Values{}
	for _, name := range e.Query {
		if v, ok := a.flags[name]; ok {
			q.Set(name, v)
		}
	}
	for name := range a.flags {
		if !slices.Contains(e.Query, name) && !slices.Contains([]string{"server", "json"}, name) {
			if known := flagsOf(e); len(known) > 0 {
				return fmt.Errorf("%s 不认 --%s（认的：%s）", e.Op, name, strings.Join(known, " "))
			}
			return fmt.Errorf("%s 不带参数，不认 --%s", e.Op, name)
		}
	}
	var body []byte
	if e.Body {
		body, err = bodyOf(a.flags["json"])
		if err != nil {
			return err
		}
	} else if _, ok := a.flags["json"]; ok {
		return fmt.Errorf("%s 不带请求体", e.Op)
	}
	out, err := client(a).Do(ctx, e.Method, path, q, body)
	if err != nil {
		return err
	}
	return printJSON(os.Stdout, out)
}

// bodyOf is --json's value, "-" for stdin, or {} when there is none.
func bodyOf(v string) ([]byte, error) {
	switch v {
	case "":
		return []byte("{}"), nil
	case "-":
		return io.ReadAll(os.Stdin)
	}
	if !json.Valid([]byte(v)) {
		return nil, errors.New("--json 不是 JSON")
	}
	return []byte(v), nil
}

func printJSON(w io.Writer, out []byte) error {
	if len(bytes.TrimSpace(out)) == 0 {
		return nil
	}
	var b bytes.Buffer
	if err := json.Indent(&b, out, "", "  "); err != nil {
		_, err = w.Write(out)
		return err
	}
	b.WriteByte('\n')
	_, err := w.Write(b.Bytes())
	return err
}

func placeholders(path string) string {
	var out []string
	for _, m := range pathParam.FindAllStringSubmatch(path, -1) {
		out = append(out, "<"+m[1]+">")
	}
	return strings.Join(out, " ")
}

func flagsOf(e protocol.Endpoint) []string {
	var out []string
	for _, q := range e.Query {
		out = append(out, "--"+q)
	}
	if e.Body {
		out = append(out, "--json")
	}
	return out
}

// stream prints /api/v1/state or /api/v1/events: the first frame, or every one with --watch (events are always watched).
func stream(ctx context.Context, path string, raw []string) error {
	a, err := parseArgs(raw)
	if err != nil {
		return err
	}
	watch := path == protocol.EventsPath || a.flags["watch"] == "true"
	return client(a).Stream(ctx, path, func(data json.RawMessage) (bool, error) {
		return watch, printJSON(os.Stdout, data)
	})
}

func usage(w io.Writer, only string) error {
	fmt.Fprint(w, `用法：
  vibevalley                                 和 VibeValley 自己的 agent 聊（runtime chat vibevalley）
  vibevalley runtime chat <runtime> [--model --effort --resume --cwd -p]
                                             和一个农机直接聊，不经过农场
  vibevalley oar <command> [args...]         smith 的 oar 命令行，农机和农场的一样（oar help 列出命令）
  vibevalley issue run <id>                  开工，等它交回来，打出改动
  vibevalley state [--watch]                 核心状态（GET /api/v1/state）
  vibevalley events                          副作用（GET /api/v1/events）
  vibevalley <group> <op> [参数…] [--json 请求体|-]
                                             调农场的一个接口，答复是 JSON

  --server 地址，或 VIBEVALLEY_SERVER，默认 `+defaultServer+`。能力表：docs/reference/capabilities.md

`)
	// Grouped in the order api.go first names them; api.go interleaves them.
	var groups []string
	for _, e := range protocol.Endpoints {
		if g, _, _ := strings.Cut(e.Op, "."); !slices.Contains(groups, g) && (only == "" || g == only) {
			groups = append(groups, g)
		}
	}
	for _, group := range groups {
		for _, e := range protocol.Endpoints {
			if g, o, _ := strings.Cut(e.Op, "."); g == group {
				words := slices.DeleteFunc([]string{g, kebab(o), placeholders(e.Path), strings.Join(flagsOf(e), " ")}, func(w string) bool { return w == "" })
				fmt.Fprintln(w, "  "+strings.Join(words, " "))
			}
		}
	}
	return nil
}
