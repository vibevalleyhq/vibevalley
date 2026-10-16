package agent

// The basic tools, nanobot's and every coding agent's: read, write and edit files, list a folder, search, run a
// command, fetch a web page. Paths are the work directory's unless absolute. No sandbox: like vibevalley's helpers,
// the agent works on this machine in its folder (AGENTS.md「帮工没有权限确认」), so a host gives these only to
// agents that are meant to change things (not the manager).

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	"vibevalley/pkg/agentcore"
)

type CodingOptions struct {
	// Where relative paths and commands are.
	Cwd string
	// A command is stopped after this long (2 minutes when 0).
	CommandTimeout time.Duration
	// Laid over the environment commands run with; a nil value takes a variable away.
	Env map[string]*string
}

func why(err error) string {
	var pathErr *fs.PathError
	if errors.As(err, &pathErr) {
		return pathErr.Err.Error()
	}
	return err.Error()
}

func CodingTools(o CodingOptions) []agentcore.AgentTool {
	cwd := o.Cwd
	timeout := o.CommandTimeout
	if timeout == 0 {
		timeout = 120 * time.Second
	}
	runEnv := WithEnv(o.Env)
	at := func(path string) string {
		if filepath.IsAbs(path) {
			return path
		}
		return filepath.Join(cwd, path)
	}
	shown := func(path string) string {
		r, err := filepath.Rel(cwd, path)
		if err == nil && r != "" && r != "." && !strings.HasPrefix(r, "..") {
			return r
		}
		return path
	}

	type readParams struct {
		Path   string `json:"path"`
		Offset *int   `json:"offset"`
		Limit  *int   `json:"limit"`
	}
	read := TextTool(TextToolSpec[readParams]{
		Name:        "read_file",
		Description: "读一个文本文件，每行前面带行号。大文件用 offset（从第几行开始，1 起）和 limit（读几行）分段读。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"path": agentcore.StringSchema(), "offset": agentcore.IntegerSchema(), "limit": agentcore.IntegerSchema(),
		}, "path"),
		Run: func(_ context.Context, p readParams, _ ToolContext) (string, error) {
			data, err := os.ReadFile(at(p.Path))
			if err != nil {
				return "", fmt.Errorf("读不了 %s：%s", p.Path, why(err))
			}
			lines := strings.Split(string(data), "\n")
			from := 1
			if p.Offset != nil {
				from = max(1, *p.Offset)
			}
			limit := 2000
			if p.Limit != nil {
				limit = *p.Limit
			}
			to := min(len(lines), from-1+limit)
			var body []string
			for i := from - 1; i < to; i++ {
				body = append(body, fmt.Sprintf("%6d\t%s", i+1, lines[i]))
			}
			text := strings.Join(body, "\n")
			if to < len(lines) {
				return fmt.Sprintf("%s\n（共 %d 行，这里到第 %d 行；接着读用 offset=%d）", text, len(lines), to, to+1), nil
			}
			return text, nil
		},
	})

	type writeParams struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	write := TextTool(TextToolSpec[writeParams]{
		Name:        "write_file",
		Description: "写一个文件（整个覆盖；没有的目录会建好）。改已有文件的一部分用 edit_file。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"path": agentcore.StringSchema(), "content": agentcore.StringSchema()}, "path", "content"),
		Run: func(_ context.Context, p writeParams, _ ToolContext) (string, error) {
			file := at(p.Path)
			if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
				return "", fmt.Errorf("写不了 %s：%s", p.Path, why(err))
			}
			if err := os.WriteFile(file, []byte(p.Content), 0o644); err != nil {
				return "", fmt.Errorf("写不了 %s：%s", p.Path, why(err))
			}
			return fmt.Sprintf("写好了 %s（%d 行）", shown(file), len(strings.Split(p.Content, "\n"))), nil
		},
	})

	type editParams struct {
		Path       string `json:"path"`
		OldText    string `json:"old_text"`
		NewText    string `json:"new_text"`
		ReplaceAll bool   `json:"replace_all"`
	}
	edit := TextTool(TextToolSpec[editParams]{
		Name:        "edit_file",
		Description: "把文件里的一段原文换成新的。old_text 要和文件里一字不差、而且只出现一次（不唯一就多带几行上下文），要全换就把 replace_all 设成 true。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"path": agentcore.StringSchema(), "old_text": agentcore.StringSchema(), "new_text": agentcore.StringSchema(), "replace_all": agentcore.BooleanSchema(),
		}, "path", "old_text", "new_text"),
		Run: func(_ context.Context, p editParams, _ ToolContext) (string, error) {
			file := at(p.Path)
			data, err := os.ReadFile(file)
			if err != nil {
				return "", fmt.Errorf("读不了 %s：%s", p.Path, why(err))
			}
			text := string(data)
			if p.OldText == "" {
				return "", errors.New("old_text 是空的：要新建文件用 write_file。")
			}
			count := strings.Count(text, p.OldText)
			if count == 0 {
				return "", fmt.Errorf("%s 里找不到 old_text：先 read_file 看清原文（空格、缩进都要一样）。", p.Path)
			}
			if count > 1 && !p.ReplaceAll {
				return "", fmt.Errorf("old_text 在 %s 里出现了 %d 次：多带几行上下文让它唯一，或者设 replace_all。", p.Path, count)
			}
			next := strings.Replace(text, p.OldText, p.NewText, 1)
			replaced := 1
			if p.ReplaceAll {
				next = strings.ReplaceAll(text, p.OldText, p.NewText)
				replaced = count
			}
			if err := os.WriteFile(file, []byte(next), 0o644); err != nil {
				return "", fmt.Errorf("写不了 %s：%s", p.Path, why(err))
			}
			return fmt.Sprintf("改好了 %s（换了 %d 处）", shown(file), replaced), nil
		},
	})

	type listParams struct {
		Path  *string `json:"path"`
		Depth *int    `json:"depth"`
	}
	list := TextTool(TextToolSpec[listParams]{
		Name:        "list_dir",
		Description: "列一个目录里有什么（目录后面带 /）。depth 是往下看几层，默认 1。不进 .git、node_modules。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"path": agentcore.StringSchema(), "depth": agentcore.IntegerSchema()}),
		Run: func(_ context.Context, p listParams, _ ToolContext) (string, error) {
			path := "."
			if p.Path != nil {
				path = *p.Path
			}
			depth := 1
			if p.Depth != nil {
				depth = *p.Depth
			}
			var out []string
			var walk func(dir string, level int) error
			walk = func(dir string, level int) error {
				entries, err := os.ReadDir(dir)
				if err != nil {
					return err
				}
				sort.Slice(entries, func(i, j int) bool { return localeLess(entries[i].Name(), entries[j].Name()) })
				for _, e := range entries {
					if len(out) >= 500 {
						return nil
					}
					if e.Name() == ".git" || e.Name() == "node_modules" {
						continue
					}
					slash := ""
					if e.IsDir() {
						slash = "/"
					}
					out = append(out, strings.Repeat("  ", level)+e.Name()+slash)
					if e.IsDir() && level+1 < depth {
						if err := walk(filepath.Join(dir, e.Name()), level+1); err != nil {
							return err
						}
					}
				}
				return nil
			}
			if err := walk(at(path), 0); err != nil {
				return "", fmt.Errorf("列不了 %s：%s", path, why(err))
			}
			if len(out) == 0 {
				return "（空的）", nil
			}
			more := ""
			if len(out) >= 500 {
				more = "\n…（太多了，只列了 500 个）"
			}
			return strings.Join(out, "\n") + more, nil
		},
	})

	type grepParams struct {
		Pattern    string  `json:"pattern"`
		Path       *string `json:"path"`
		Glob       *string `json:"glob"`
		IgnoreCase bool    `json:"ignore_case"`
	}
	grep := TextTool(TextToolSpec[grepParams]{
		Name:        "grep",
		Description: "在文件里搜一个正则，返回「文件:行号:那一行」。path 默认工作目录；glob 只搜某些文件，比如 *.ts。",
		Parameters: agentcore.ObjectSchema(map[string]any{
			"pattern": agentcore.StringSchema(), "path": agentcore.StringSchema(), "glob": agentcore.StringSchema(), "ignore_case": agentcore.BooleanSchema(),
		}, "pattern"),
		Run: func(ctx context.Context, p grepParams, _ ToolContext) (string, error) {
			argv := []string{"rg", "--line-number", "--no-heading", "--color=never", "--max-count=50"}
			if p.IgnoreCase {
				argv = append(argv, "-i")
			}
			if p.Glob != nil {
				argv = append(argv, "--glob", *p.Glob)
			}
			path := "."
			if p.Path != nil {
				path = *p.Path
			}
			argv = append(argv, "--", p.Pattern, at(path))
			ran, err := Run(ctx, argv, cwd, 30*time.Second, runEnv)
			if err != nil {
				if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
					return "", errors.New("这台机器没有 ripgrep（rg）：用 bash 跑 grep -rn 代替。")
				}
				return "", err
			}
			if ran.Code == 1 || strings.TrimSpace(ran.Output) == "" {
				return "没搜到。", nil
			}
			return strings.TrimSpace(ran.Output), nil
		},
	})

	type bashParams struct {
		Command        string   `json:"command"`
		TimeoutSeconds *float64 `json:"timeout_seconds"`
	}
	bash := TextTool(TextToolSpec[bashParams]{
		Name:        "bash",
		Description: fmt.Sprintf("在工作目录里跑一条 shell 命令，返回它的输出和退出码。默认 %s 秒超时，可以用 timeout_seconds 改。不要用它读写文件（用 read_file、edit_file），不要起不会结束的进程。", formatSeconds(timeout)),
		Parameters:  agentcore.ObjectSchema(map[string]any{"command": agentcore.StringSchema(), "timeout_seconds": agentcore.NumberSchema()}, "command"),
		Run: func(ctx context.Context, p bashParams, _ ToolContext) (string, error) {
			limit := timeout
			if p.TimeoutSeconds != nil && *p.TimeoutSeconds != 0 {
				limit = time.Duration(*p.TimeoutSeconds * float64(time.Second))
			}
			ran, err := Run(ctx, []string{"/bin/bash", "-lc", p.Command}, cwd, limit, runEnv)
			if err != nil {
				return "", err
			}
			output := strings.TrimSpace(ran.Output)
			if output == "" {
				output = "（没有输出）"
			}
			if ran.TimedOut {
				return output + "\n（超时，停掉了）", nil
			}
			return fmt.Sprintf("%s\n（退出码 %d）", output, ran.Code), nil
		},
	})

	type fetchParams struct {
		URL string `json:"url"`
	}
	fetch := TextTool(TextToolSpec[fetchParams]{
		Name:        "web_fetch",
		Description: "打开一个网页，返回它的正文（HTML 变成纯文本）。",
		Parameters:  agentcore.ObjectSchema(map[string]any{"url": agentcore.StringSchema()}, "url"),
		Run: func(ctx context.Context, p fetchParams, _ ToolContext) (string, error) {
			ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
			defer cancel()
			req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
			if err != nil {
				return "", fmt.Errorf("打不开 %s：%s", p.URL, err.Error())
			}
			req.Header.Set("user-agent", "vibevalley-agent/0.1")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				if errors.Is(ctx.Err(), context.DeadlineExceeded) {
					return "", fmt.Errorf("打开 %s 超时了", p.URL)
				}
				return "", fmt.Errorf("打不开 %s：%s", p.URL, err.Error())
			}
			defer res.Body.Close()
			body, err := io.ReadAll(res.Body)
			if err != nil {
				return "", fmt.Errorf("打不开 %s：%s", p.URL, err.Error())
			}
			text := string(body)
			if strings.Contains(res.Header.Get("content-type"), "html") {
				text = HtmlText(text)
			}
			return fmt.Sprintf("%d %s\n\n%s", res.StatusCode, p.URL, text), nil
		},
	})

	return []agentcore.AgentTool{read, write, edit, list, grep, bash, fetch}
}

func formatSeconds(d time.Duration) string {
	s := d.Seconds()
	if s == float64(int64(s)) {
		return fmt.Sprintf("%d", int64(s))
	}
	return fmt.Sprintf("%g", s)
}

// localeLess orders names as localeCompare does closely enough: case folded first.
func localeLess(a, b string) bool {
	la, lb := strings.ToLower(a), strings.ToLower(b)
	if la != lb {
		return la < lb
	}
	return a < b
}

// WithEnv is this process's environment with env laid over it (a nil value takes a variable away).
func WithEnv(env map[string]*string) []string {
	if len(env) == 0 {
		return os.Environ()
	}
	vars := map[string]string{}
	var order []string
	for _, kv := range os.Environ() {
		k, v, _ := strings.Cut(kv, "=")
		if _, ok := vars[k]; !ok {
			order = append(order, k)
		}
		vars[k] = v
	}
	for k, v := range env {
		if v == nil {
			delete(vars, k)
			continue
		}
		if _, ok := vars[k]; !ok {
			order = append(order, k)
		}
		vars[k] = *v
	}
	out := make([]string, 0, len(vars))
	for _, k := range order {
		if v, ok := vars[k]; ok {
			out = append(out, k+"="+v)
		}
	}
	return out
}

// Ran is what running a program came to: its output (stdout and stderr together, clipped), its exit code (-1 when
// killed by a signal), whether it was stopped for taking too long.
type Ran struct {
	Code     int
	Output   string
	TimedOut bool
}

// capped keeps output until it is 200 000 bytes long.
type capped struct {
	mu  sync.Mutex
	buf strings.Builder
}

func (c *capped) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.buf.Len() < 200_000 {
		c.buf.Write(p)
	}
	return len(p), nil
}

// Run runs a program in cwd. When it takes longer than timeout it is sent SIGTERM, and SIGKILL 2 s later; when ctx
// ends (the turn was stopped) it goes at once. It runs in a process group of its own, and the group is what is
// killed, so a child it left behind does not hold its output open (TS kills only the child).
func Run(ctx context.Context, argv []string, cwd string, timeout time.Duration, env []string) (Ran, error) {
	if len(argv) == 0 {
		return Ran{}, errors.New("跑不起来：没有命令")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = cwd
	cmd.Env = env
	out := &capped{}
	cmd.Stdout = out
	cmd.Stderr = out
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// A daemon that left its own group may still hold the output open: stop waiting for it.
	cmd.WaitDelay = 2 * time.Second
	if err := cmd.Start(); err != nil {
		return Ran{}, fmt.Errorf("跑不起来：%w", err)
	}
	kill := func(sig syscall.Signal) {
		if cmd.Process != nil {
			_ = syscall.Kill(-cmd.Process.Pid, sig)
		}
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	timedOut := false
	var err error
	select {
	case err = <-exited:
	case <-timer.C:
		timedOut = true
		kill(syscall.SIGTERM)
		select {
		case err = <-exited:
		case <-time.After(2 * time.Second):
			kill(syscall.SIGKILL)
			err = <-exited
		}
	case <-ctx.Done():
		kill(syscall.SIGTERM)
		select {
		case err = <-exited:
		case <-time.After(2 * time.Second):
			kill(syscall.SIGKILL)
			err = <-exited
		}
	}
	code := 0
	if err != nil {
		var exit *exec.ExitError
		if !errors.As(err, &exit) {
			return Ran{}, fmt.Errorf("跑不起来：%w", err)
		}
		code = exit.ExitCode()
	}
	out.mu.Lock()
	defer out.mu.Unlock()
	return Ran{Code: code, Output: out.buf.String(), TimedOut: timedOut}, nil
}

var (
	htmlBreak    = regexp.MustCompile(`(?i)<br\s*/?>`)
	htmlBlockEnd = regexp.MustCompile(`(?i)</(p|div|h[1-6]|li|tr|section|article|header|footer)>`)
	htmlTag      = regexp.MustCompile(`<[^>]+>`)
	spaceBeforeN = regexp.MustCompile(`[ \t]+\n`)
	blankLines   = regexp.MustCompile(`\n{3,}`)
	hiddenOpen   = regexp.MustCompile(`(?i)<(script|style|noscript|svg)`)
)

// dropHidden takes out <script>, <style>, <noscript> and <svg> elements with what is in them (TS's one regex with
// a back-reference, which RE2 lacks).
func dropHidden(html string) string {
	var b strings.Builder
	rest := html
	for {
		loc := hiddenOpen.FindStringSubmatchIndex(rest)
		if loc == nil {
			b.WriteString(rest)
			return b.String()
		}
		tag := strings.ToLower(rest[loc[2]:loc[3]])
		closeAt := strings.Index(strings.ToLower(rest[loc[1]:]), "</"+tag+">")
		if closeAt < 0 {
			// No end: not an element to drop; go on after its first character.
			b.WriteString(rest[:loc[0]+1])
			rest = rest[loc[0]+1:]
			continue
		}
		b.WriteString(rest[:loc[0]])
		rest = rest[loc[1]+closeAt+len(tag)+3:]
	}
}

// HtmlText is a web page's words: scripts, styles and tags gone, entities decoded, blank lines squeezed.
func HtmlText(html string) string {
	text := dropHidden(html)
	text = htmlBreak.ReplaceAllString(text, "\n")
	text = htmlBlockEnd.ReplaceAllString(text, "\n")
	text = htmlTag.ReplaceAllString(text, "")
	text = strings.NewReplacer("&nbsp;", " ").Replace(text)
	text = strings.ReplaceAll(text, "&amp;", "&")
	text = strings.ReplaceAll(text, "&lt;", "<")
	text = strings.ReplaceAll(text, "&gt;", ">")
	text = strings.ReplaceAll(text, "&quot;", `"`)
	text = strings.ReplaceAll(text, "&#39;", "'")
	text = spaceBeforeN.ReplaceAllString(text, "\n")
	text = blankLines.ReplaceAllString(text, "\n\n")
	return strings.TrimSpace(text)
}

// IsDir reports a directory (for hosts checking their work directory).
func IsDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
