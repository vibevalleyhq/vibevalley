package agent

// The tools on their own: the coding tools in a scratch folder, skills' front matter, memory and the archive,
// schedules (when due, a missed run caught up once), an MCP server over stdio. Offline.
// Ported from the TypeScript @heybro/agent's tools.test.ts (removed).

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/agentcore"
)

type res struct {
	out string
	err error
}

func call(t *testing.T, tools []agentcore.AgentTool, name string, params string) res {
	t.Helper()
	for _, tool := range tools {
		if tool.Name == name {
			out, err := CallTool(context.Background(), tool, json.RawMessage(params), ToolContext{CallID: "t"})
			return res{out, err}
		}
	}
	t.Fatalf("no %s", name)
	return res{}
}

func ok(t *testing.T, r res) string {
	t.Helper()
	if r.err != nil {
		t.Fatal(r.err)
	}
	return r.out
}

func failed(t *testing.T, r res) string {
	t.Helper()
	if r.err == nil {
		t.Fatal("expected a failure")
	}
	return r.err.Error()
}

func TestReadWriteAndEditAFile(t *testing.T) {
	dir := home(t)
	tools := CodingTools(CodingOptions{Cwd: dir})
	match(t, `写好了 src/a\.ts（4 行）`, ok(t, call(t, tools, "write_file", `{"path":"src/a.ts","content":"one\ntwo\nthree\ntwo"}`)))
	match(t, `^ {5}2\ttwo\n（共 4 行，这里到第 2 行；接着读用 offset=3）$`, ok(t, call(t, tools, "read_file", `{"path":"src/a.ts","offset":2,"limit":1}`)))
	match(t, `出现了 2 次`, failed(t, call(t, tools, "edit_file", `{"path":"src/a.ts","old_text":"two","new_text":"2"}`)))
	match(t, `找不到 old_text`, failed(t, call(t, tools, "edit_file", `{"path":"src/a.ts","old_text":"four","new_text":"4"}`)))
	ok(t, call(t, tools, "edit_file", `{"path":"src/a.ts","old_text":"two","new_text":"$&2","replace_all":true}`))
	data, _ := os.ReadFile(filepath.Join(dir, "src/a.ts"))
	eq(t, string(data), "one\n$&2\nthree\n$&2")
}

func TestListSearchRun(t *testing.T) {
	dir := home(t)
	_ = os.MkdirAll(filepath.Join(dir, "node_modules", "x"), 0o755)
	_ = os.MkdirAll(filepath.Join(dir, "lib"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "lib", "b.txt"), []byte("needle here\n"), 0o644)
	tools := CodingTools(CodingOptions{Cwd: dir, CommandTimeout: time.Second})
	eq(t, ok(t, call(t, tools, "list_dir", `{"depth":2}`)), "lib/\n  b.txt")
	found := ok(t, call(t, tools, "grep", `{"pattern":"needle"}`))
	if found != "这台机器没有 ripgrep（rg）：用 bash 跑 grep -rn 代替。" && !strings.Contains(found, "b.txt:1:needle here") {
		t.Fatal(found)
	}
	eq(t, ok(t, call(t, tools, "bash", `{"command":"echo hi; exit 3"}`)), "hi\n（退出码 3）")
	match(t, `超时，停掉了`, ok(t, call(t, tools, "bash", `{"command":"sleep 5","timeout_seconds":0.2}`)))
}

func TestAWebPageBecomesItsWords(t *testing.T) {
	eq(t, HtmlText("<html><style>x{}</style><h1>标题</h1><p>一 &amp; 二</p><script>no()</script></html>"), "标题\n一 & 二")
}

func TestSkillsFrontMatterFirstOfANameWins(t *testing.T) {
	dir := home(t)
	eq(t, FrontMatter("---\nname: \"tidy\"\ndescription: >\n  整理代码\n  时用\n---\nbody"), map[string]string{"name": "tidy", "description": "整理代码 时用"})
	eq(t, SkillBody("---\nname: x\n---\n\n正文"), "正文")
	for _, s := range [][2]string{{"a", "第一个"}, {"b", "第二个"}} {
		_ = os.MkdirAll(filepath.Join(dir, s[0], "tidy"), 0o755)
		_ = os.WriteFile(filepath.Join(dir, s[0], "tidy", "SKILL.md"), []byte("---\nname: tidy\ndescription: "+s[1]+"\n---\n"+s[1]+"的正文"), 0o644)
	}
	skills := ScanSkills([]string{filepath.Join(dir, "a"), filepath.Join(dir, "b"), filepath.Join(dir, "missing")})
	eq(t, len(skills), 1)
	eq(t, skills[0].Description, "第一个")
	body, err := ReadSkill(skills, "tidy")
	match(t, `第一个的正文$`, ok(t, res{body, err}))
	_, err = ReadSkill(skills, "nope")
	match(t, `有：tidy`, err.Error())
}

func TestMemoryRememberRewriteArchive(t *testing.T) {
	dir := home(t)
	tools := SelfTools(SelfOptions{Home: dir, Skills: func() []SkillInfo { return nil }, Memory: true})
	ok(t, call(t, tools, "remember", `{"note":"用户喜欢\n简短的回答"}`))
	match(t, `^- \d{4}-\d\d-\d\d 用户喜欢 简短的回答$`, ReadMemory(dir))
	ok(t, call(t, tools, "rewrite_memory", `{"content":"- 只说中文"}`))
	eq(t, ReadMemory(dir), "- 只说中文")
	eq(t, ok(t, call(t, tools, "search_archive", `{"query":"端口"}`)), "还没有归档的旧对话。")
	if _, err := Archive(dir, "s", "## 用户\n服务端口是 8787\n## 助手\n好", time.Now()); err != nil {
		t.Fatal(err)
	}
	match(t, `s-.*\.md:2\n## 用户\n服务端口是 8787`, ok(t, call(t, tools, "search_archive", `{"query":"端口"}`)))
	var names []string
	for _, tool := range SelfTools(SelfOptions{Home: dir, Skills: func() []SkillInfo { return nil }}) {
		names = append(names, tool.Name)
	}
	eq(t, names, []string{"load_skill", "search_archive"})
	lines := MemoryLines(dir)
	eq(t, len(lines), 1)
	eq(t, lines[0].Text, "只说中文")
	if err := ForgetLine(dir, lines[0].ID); err != nil {
		t.Fatal(err)
	}
	eq(t, len(MemoryLines(dir)), 0)
}

func ids(jobs []Job) []string {
	out := []string{}
	for _, j := range jobs {
		out = append(out, j.ID)
	}
	return out
}

func TestSchedulesWhenEachKindIsDue(t *testing.T) {
	created := "2026-10-12T00:00:00.000Z"
	thirty := 30.0
	at := Job{ID: "a", Name: "a", At: "2026-10-12T01:00:00.000Z", Created: created}
	every := Job{ID: "e", Name: "e", EveryMinutes: &thirty, Created: created}
	cron := Job{ID: "c", Name: "c", Cron: "0 * * * *", Created: created}
	next, _ := NextRun(at)
	eq(t, isoTime(next), "2026-10-12T01:00:00.000Z")
	ran := at
	ran.LastRun = "2026-10-12T01:00:00.000Z"
	_, again := NextRun(ran)
	eq(t, again, false)
	next, _ = NextRun(every)
	eq(t, isoTime(next), "2026-10-12T00:30:00.000Z")
	next, _ = NextRun(cron)
	eq(t, next.UTC().Minute(), 0)
	now, _ := parseDate("2026-10-12T00:45:00.000Z")
	eq(t, ids(DueJobs([]Job{at, every, cron}, now)), []string{"e"})
	if _, err := ParseCron("every day"); err == nil {
		t.Fatal("every day is not cron")
	}
}

func TestSchedulesAMissedJobRunsOnce(t *testing.T) {
	dir := home(t)
	var woke []string
	s := MakeSchedules(dir, func(text string) { woke = append(woke, text) })
	match(t, `正好给一个`, failed(t, call(t, s.Tools, "schedule", `{"name":"x","message":"m"}`)))
	match(t, `cron 写得不对`, failed(t, call(t, s.Tools, "schedule", `{"name":"x","message":"m","cron":"nope"}`)))
	ok(t, call(t, s.Tools, "schedule", `{"name":"巡检","message":"看看测试","every_minutes":10}`))
	time.Sleep(2 * time.Millisecond)
	ok(t, call(t, s.Tools, "schedule", `{"name":"提醒","message":"开会","at":"`+isoTime(time.Now().Add(time.Minute))+`"}`))
	match(t, `「巡检」每 10 分钟[\s\S]*「提醒」`, ok(t, call(t, s.Tools, "list_schedules", `{}`)))
	// Away for an hour: six runs missed, one run.
	later := time.Now().Add(time.Hour)
	s.Tick(later)
	eq(t, len(woke), 2)
	match(t, `^【定时任务「巡检」到点了`, woke[0])
	s.Tick(later)
	eq(t, len(woke), 2)
	left := s.List()
	eq(t, len(left), 1)
	eq(t, left[0].Name, "巡检")
	ok(t, call(t, s.Tools, "cancel_schedule", `{"id":"`+left[0].ID+`"}`))
	eq(t, ok(t, call(t, s.Tools, "list_schedules", `{}`)), "没有定好的事。")
}

const fakeMCP = `
const rl = require('node:readline').createInterface({ input: process.stdin })
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n')
rl.on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  else if (m.method === 'tools/list' && !(m.params && m.params.cursor)) send({ id: m.id, result: { tools: [{ name: 'add', description: 'adds', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } }], nextCursor: 'p2' } })
  else if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'boom', inputSchema: { type: 'object' } }] } })
  else if (m.method === 'tools/call' && m.params.name === 'add') send({ id: m.id, result: { content: [{ type: 'text', text: String(m.params.arguments.a + m.params.arguments.b) }] } })
  else if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: '炸了' }], isError: true } })
})
`

func TestAnMCPServerOverStdio(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("no node on PATH")
	}
	dir := home(t)
	_ = os.WriteFile(filepath.Join(dir, "fake.cjs"), []byte(fakeMCP), 0o644)
	all := ConnectAll(context.Background(), []McpServer{
		{Name: "calc", Command: node, Args: []string{filepath.Join(dir, "fake.cjs")}},
		{Name: "gone", Command: filepath.Join(dir, "no-such-server")},
	})
	defer all.Close()
	var names []string
	for _, tool := range all.Tools {
		names = append(names, tool.Name)
	}
	eq(t, names, []string{"calc__add", "calc__boom"})
	eq(t, len(all.Failed), 1)
	match(t, `^连不上 MCP 服务 gone`, all.Failed[0])
	sum, err := CallTool(context.Background(), all.Tools[0], json.RawMessage(`{"a":2,"b":3}`), ToolContext{CallID: "t"})
	eq(t, ok(t, res{sum, err}), "5")
	_, err = CallTool(context.Background(), all.Tools[1], json.RawMessage(`{}`), ToolContext{CallID: "t"})
	eq(t, err.Error(), "炸了")
}

func TestMCPNamesAndContent(t *testing.T) {
	eq(t, McpToolName("my server", "a.b"), "my_server__a_b")
	eq(t, McpContentText([]McpContent{{Type: "text", Text: "a"}, {Type: "image"}, {Type: "resource", Resource: &McpResource{URI: "file:///x"}}}), "a\n[image]\n[file:///x]")
}

func TestAToolWithNoParametersIsStillAnObject(t *testing.T) {
	none := TextTool(TextToolSpec[struct{}]{Name: "n", Parameters: agentcore.ObjectSchema(nil), Run: func(context.Context, struct{}, ToolContext) (string, error) { return "", nil }})
	eq(t, ai2json(ParametersJsonSchema(none)), `{"properties":{},"type":"object"}`)
	some := TextTool(TextToolSpec[struct{}]{Name: "s", Parameters: agentcore.ObjectSchema(map[string]any{"a": agentcore.StringSchema()}), Run: func(context.Context, struct{}, ToolContext) (string, error) { return "", nil }})
	eq(t, ParametersJsonSchema(some)["type"], "object")
}

func ai2json(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

// The forms of a moment `new Date` reads (checked against Node in Asia/Shanghai): the schedule tool takes them all.
func TestScheduleAtReadsTheFormsJSDateReads(t *testing.T) {
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Skip("no zone data")
	}
	local := time.Local
	time.Local = shanghai
	defer func() { time.Local = local }()
	for text, want := range map[string]string{
		"2026-10-13T09:00:00+08:00":    "2026-10-13T01:00:00.000Z",
		"2026-10-13T09:00:00+0800":     "2026-10-13T01:00:00.000Z",
		"2026-10-13T09:00:00.000+0800": "2026-10-13T01:00:00.000Z",
		"2026-10-13T09:00+0800":        "2026-10-13T01:00:00.000Z",
		"2026-10-13 09:00:00+08:00":    "2026-10-13T01:00:00.000Z",
		"2026-10-13T09:00:00":          "2026-10-13T01:00:00.000Z",
		"2026-10-13 09:00":             "2026-10-13T01:00:00.000Z",
		"2026/10/13 09:00":             "2026-10-13T01:00:00.000Z",
		"2026/10/13 09:00:00":          "2026-10-13T01:00:00.000Z",
		"2026/10/13":                   "2026-10-12T16:00:00.000Z",
		"2026-10-13":                   "2026-10-13T00:00:00.000Z",
		"2026-10-12T01:00:00.000Z":     "2026-10-12T01:00:00.000Z",
	} {
		got, ok := parseDate(text)
		if !ok || isoTime(got) != want {
			t.Errorf("%s: got %s (%v), want %s", text, isoTime(got), ok, want)
		}
	}
	if _, ok := parseDate("明天早上"); ok {
		t.Error("明天早上 is not a moment")
	}
}
