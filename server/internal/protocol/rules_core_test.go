package protocol

import (
	"fmt"
	"slices"
	"strings"
	"testing"
)

func coreMsg(change func(*ChatMessage)) ChatMessage {
	m := ChatMessage{Seq: 1, Conversation: 1, From: "foreman", FromKind: SenderKindForeman, Name: "管家", Kind: MessageKindChat, Text: "好", Final: true}
	change(&m)
	return m
}

func TestForOwner(t *testing.T) {
	coreEqual(t, ForOwner(coreMsg(func(*ChatMessage) {})), true)
	coreEqual(t, ForOwner(coreMsg(func(m *ChatMessage) { m.Final = false })), false, "not while the manager is still speaking")
	coreEqual(t, ForOwner(coreMsg(func(m *ChatMessage) { m.From, m.FromKind = "user", SenderKindUser })), false)
	coreEqual(t, ForOwner(coreMsg(func(m *ChatMessage) { m.Kind, m.From, m.FromKind = MessageKindNotice, "system", SenderKindSystem })), false)
	coreEqual(t, ForOwner(coreMsg(func(m *ChatMessage) { m.Kind, m.From, m.FromKind = MessageKindReport, "w1", SenderKindHelper })), true)
	coreEqual(t, ForOwner(coreMsg(func(m *ChatMessage) { m.Kind = MessageKindDispatch })), true)
	coreEqual(t, ForOwner(coreMsg(func(m *ChatMessage) { m.From, m.FromKind, m.Mentions = "w1", SenderKindHelper, []string{"w2"} })), false, "helpers among themselves")
	coreEqual(t, ForOwner(coreMsg(func(m *ChatMessage) { m.From, m.FromKind, m.Mentions = "w1", SenderKindHelper, []string{"user"} })), true)
}

func TestPlainText(t *testing.T) {
	coreEqual(t, PlainText("## 结论\n**改好了**，见 [PR](https://x/1)\n- 一\n- 二\n```ts\nconst a = 1\n```"), "结论\n改好了，见 PR (https://x/1)\n· 一\n· 二\nconst a = 1")
	coreEqual(t, PlainText("a *b* c\r# h - x"), "a b c\rh · x", "JavaScript's line ends")
}

func TestOwnerLine(t *testing.T) {
	coreEqual(t, OwnerLine(coreMsg(func(m *ChatMessage) { m.Text = "好的" }), &Conversation{Kind: ConversationKindSquare}), "【管家】\n好的")
	coreEqual(t, OwnerLine(coreMsg(func(m *ChatMessage) {
		m.Kind, m.From, m.FromKind, m.Name, m.Outcome, m.Text = MessageKindReport, "w1", SenderKindHelper, "后端老周", corePtr(OutcomeFailed), "测试挂了"
	}), &Conversation{Kind: ConversationKindThread}), "【后端老周 · 没做成】\n测试挂了")
	coreEqual(t, OwnerLine(coreMsg(func(m *ChatMessage) {
		m.From, m.FromKind, m.Name, m.Mentions, m.Text = "w1", SenderKindHelper, "后端老周", []string{"user"}, "@主人 用哪个库？"
	}), &Conversation{Kind: ConversationKindThread}), "【后端老周 · 在工单串里】\n@主人 用哪个库？")
}

func TestSplitText(t *testing.T) {
	coreEqual(t, SplitText("短", 1800), []string{"短"})
	long := strings.Repeat("甲", 60) + "\n" + strings.Repeat("乙", 60)
	coreEqual(t, SplitText(long, 80), []string{strings.Repeat("甲", 60), strings.Repeat("乙", 60)})
	coreEqual(t, len(SplitText(strings.Repeat("丙", 200), 80)), 3)
}

func TestFlushText(t *testing.T) {
	coreEqual(t, FlushText([]string{"【管家】\n一", "【管家】\n二"}), []string{"【管家】\n一", "【管家】\n二"})
	digest := FlushText([]string{"【管家】\n一", "【管家】\n二", "【老周 · 做完了】\n三", "【管家】\n四"})
	coreEqual(t, len(digest), 1)
	coreMatches(t, digest[0], `^你不在的时候有 4 条消息：\n【管家】 一\n`)
}

func TestIsPairing(t *testing.T) {
	coreEqual(t, IsPairing("482913", "482913"), true)
	coreEqual(t, IsPairing(" 482 913 ", "482913"), true)
	coreEqual(t, IsPairing("配对 482913", "482913"), true)
	coreEqual(t, IsPairing("482914", "482913"), false)
	coreEqual(t, IsPairing("你好 482913", "482913"), false)
	coreEqual(t, ShortID("o9cq80wWj3kD8bq"), "o9cq…D8bq")
	coreEqual(t, ShortID("short"), "short")
}

const (
	coreNow = 1_800_000_000_000
	coreDay = 86_400_000
)

func coreMemory(id, text string, change func(*Memory)) Memory {
	m := Memory{ID: id, Agent: "lab", Kind: MemoryKindNote, Text: text, At: coreNow - coreDay}
	if change != nil {
		change(&m)
	}
	return m
}

func coreCue(text string, change func(*Cue)) Cue {
	c := Cue{Helper: "w9", Project: "clock", Text: text, Skip: map[string]bool{}, Now: coreNow}
	if change != nil {
		change(&c)
	}
	return c
}

func coreIDs(memories []Memory) []string {
	out := []string{}
	for _, m := range memories {
		out = append(out, m.ID)
	}
	return out
}

func TestTermsOf(t *testing.T) {
	var terms []string
	for term := range TermsOf("用 pnpm test 跑测试") {
		terms = append(terms, term)
	}
	slices.Sort(terms)
	want := []string{"pnpm", "test", "测试", "跑测"}
	slices.Sort(want)
	coreEqual(t, terms, want)
	if TermsOf("我们需要一个接口")["一个"] {
		t.Error("一个 is too common")
	}
}

func TestPickNotes(t *testing.T) {
	memories := []Memory{
		coreMemory("here", "迁移文件在 db/migrations，改表先写迁移", func(m *Memory) { m.Project = corePtr("clock") }),
		coreMemory("everywhere", "主人要提交信息写中文", nil),
		coreMemory("other", "博客用 hugo 生成", func(m *Memory) { m.Project = corePtr("blog") }),
		coreMemory("other-related", "分页接口用 limit 和 offset 参数，默认 20 条", func(m *Memory) { m.Project = corePtr("blog") }),
	}
	coreEqual(t, coreIDs(Pick(memories, coreCue("打卡记录的接口加个分页", nil))), []string{"here", "everywhere"})
	coreEqual(t, coreIDs(Pick(memories, coreCue("分页接口加上 limit 和 offset 参数", nil))), []string{"other-related", "here", "everywhere"})
}

func TestPickJobs(t *testing.T) {
	var memories []Memory
	for i := range 5 {
		memories = append(memories, coreMemory(fmt.Sprintf("job%d", i), fmt.Sprintf("第 %d 件活 → 做好了", i), func(m *Memory) {
			m.Kind, m.Project, m.Helper, m.At = MemoryKindJob, corePtr("clock"), corePtr(fmt.Sprintf("w%d", i)), coreNow-int64(i)*coreDay
		}))
	}
	memories = append(memories,
		coreMemory("note", "迁移文件在 db/migrations", func(m *Memory) { m.Project = corePtr("clock") }),
		coreMemory("job-blog", "博客的活 → 做好了", func(m *Memory) { m.Kind, m.Project, m.Helper = MemoryKindJob, corePtr("blog"), corePtr("w8") }),
	)
	coreEqual(t, coreIDs(Pick(memories, coreCue("随便做点什么", nil))), []string{"note", "job0", "job1", "job2"})
	coreEqual(t, coreIDs(Pick(memories, coreCue("随便做点什么", func(c *Cue) { c.Helper, c.Skip = "w0", map[string]bool{"note": true} }))), []string{"job1", "job2", "job3"})
	var many []Memory
	for i := range 20 {
		many = append(many, coreMemory(fmt.Sprintf("n%d", i), fmt.Sprintf("这个项目的第 %d 条约定", i), func(m *Memory) { m.Project = corePtr("clock") }))
	}
	coreEqual(t, len(Pick(many, coreCue("做点什么", nil))), RecallCount)
}

func TestLineOf(t *testing.T) {
	coreEqual(t, LineOf(coreMemory("1", "迁移文件在 db/migrations", func(m *Memory) { m.Project = corePtr("clock") }), "clock"), "- （这个项目）迁移文件在 db/migrations")
	coreEqual(t, LineOf(coreMemory("2", "主人要提交信息写中文", nil), "clock"), "- （所有项目）主人要提交信息写中文")
}

func TestNextForgotten(t *testing.T) {
	var many []Memory
	for i := range MemoryKeep - 1 {
		many = append(many, coreMemory(fmt.Sprintf("n%d", i), fmt.Sprintf("第 %d 条", i), func(m *Memory) { m.At = coreNow - int64(i)*coreDay }))
	}
	coreEqual(t, len(NextForgotten(many, 1)), 0)
	recalled := slices.Clone(many)
	for i := range recalled {
		if recalled[i].ID == fmt.Sprintf("n%d", MemoryKeep-2) {
			recalled[i].RecalledAt = corePtr[int64](coreNow)
		}
	}
	coreEqual(t, NextForgotten(recalled, 3), []string{fmt.Sprintf("n%d", MemoryKeep-3), fmt.Sprintf("n%d", MemoryKeep-4)})
}

func TestSettingsProblem(t *testing.T) {
	coreMatches(t, SettingsProblem(SettingsUpdate{DeepseekAPIKey: corePtr("sk has spaces")}), "DeepSeek")
	coreMatches(t, SettingsProblem(SettingsUpdate{AgoraAppCertificate: corePtr("123")}), "Certificate")
	coreMatches(t, SettingsProblem(SettingsUpdate{AgoraAppID: corePtr("not-an-app-id")}), "App ID")
	coreEqual(t, SettingsProblem(SettingsUpdate{DeepseekAPIKey: corePtr(""), AgoraAppID: corePtr("")}), "", "clearing is always fine")
	coreEqual(t, SettingsProblem(SettingsUpdate{AgoraAppID: corePtr("0123456789ABCDEF0123456789abcdef"), DeepseekAPIKey: corePtr(" sk-12345678 ")}), "")
	coreMatches(t, SettingsProblem(SettingsUpdate{TTSKey: corePtr(" a b ")}), "空格")
	coreMatches(t, SettingsProblem(SettingsUpdate{Voice: &SettingsUpdateVoice{SilenceMs: corePtr[int64](50)}}), "200 到 2000")
	coreMatches(t, SettingsProblem(SettingsUpdate{Voice: &SettingsUpdateVoice{Persona: corePtr("  ")}}), "人设")
	coreMatches(t, SettingsProblem(SettingsUpdate{Voice: &SettingsUpdateVoice{LLM: VoiceLLM{VoiceLLMOpenai{URL: "not a url", Model: "x"}}}}), "http")
	coreEqual(t, KeyHint("sk-saved-in-settings-1234"), "…1234")
	coreEqual(t, KeyHint("ab"), "…ab")
}

func TestVoiceOverrides(t *testing.T) {
	defaults := DefaultVoice()
	wanted := defaults
	wanted.Area, wanted.SilenceMs, wanted.Greeting = AreaCN, 600, "在呢。"
	over := VoiceOverrides(defaults, wanted)
	coreEqual(t, over, SettingsUpdateVoice{Area: corePtr(AreaCN), SilenceMs: corePtr[int64](600), Greeting: corePtr("在呢。")})
	coreEqual(t, VoiceSettingsOver(defaults, over), wanted)
	coreEqual(t, VoiceSettingsOver(defaults, SettingsUpdateVoice{}), defaults)
	tts := VoiceTTS{VoiceTTSMicrosoft{Region: "eastasia", VoiceName: "zh-CN-XiaoxiaoNeural"}}
	wanted = defaults
	wanted.TTS = tts
	coreEqual(t, VoiceOverrides(defaults, wanted), SettingsUpdateVoice{TTS: tts})
	coreEqual(t, NeedsTTSKey(tts), true)
	coreEqual(t, NeedsASRKey(defaults.ASR), false)
	coreEqual(t, NeedsLLMKey(VoiceLLM{VoiceLLMOpenai{URL: "https://x", Model: "m"}}), true)
}

func TestPhaseText(t *testing.T) {
	working := Helper{ID: "w1", Phase: Phase{PhaseWorking{Since: 2, Doing: Doing{Action: WorkerActionRunCommand, Label: "pnpm test"}}}}
	coreEqual(t, PhaseText(working, 4), "在跑命令：pnpm test")
	coreEqual(t, IsBusy(working), true)
	coreEqual(t, DoingOf(working).Label, "pnpm test")
	quiet := working
	quiet.Phase = Phase{PhaseWorking{Since: 2, Doing: Doing{Action: WorkerActionRunCommand, Label: "pnpm test"}, QuietSince: corePtr[int64](3)}}
	coreMatches(t, PhaseText(quiet, 240_003), `4 分钟没动静了`)
	coreMatches(t, PhaseText(quiet, 503), `（已经 1 秒没动静了）`)
	retrying := working
	retrying.Phase = Phase{PhaseWorking{Since: 2, Doing: Doing{Action: WorkerActionThinking}, Retry: &Retry{Attempt: 2, Of: corePtr[int64](3)}}}
	coreMatches(t, PhaseText(retrying, 4), `重试第 2/3 次`)
	resting := Helper{Phase: Phase{PhaseResting{}}, Conflict: &Conflict{Base: "main", Files: []string{"a.ts", "b.ts"}}}
	coreEqual(t, PhaseText(resting, 0), "歇着（上一轮没做完），合进 main 会冲突（a.ts、b.ts）")
	coreEqual(t, CanHarvest(resting), true)
	coreEqual(t, DoingOf(resting), Doing{Action: WorkerActionNone})
}

func TestMoneyWords(t *testing.T) {
	coreEqual(t, SpentText(Spent{Tokens: 26_000, CNY: corePtr(0.03)}), "约 ¥0.03 · 2.6 万 token")
	coreEqual(t, SpentText(Spent{Tokens: 12_500}), "1.3 万 token", "toFixed rounds halves up")
	coreEqual(t, Yuan(0.004), "不到 ¥0.01")
	coreEqual(t, Yuan(0.125), "¥0.13")
	coreEqual(t, Yuan(1.005), "¥1.00", "1.005 is a little under")
	coreEqual(t, coreNumber(66.7), "66.7")
	coreEqual(t, coreNumber(1e21), "1e+21")
	coreEqual(t, coreNumber(1.5e-7), "1.5e-7")
	coreEqual(t, coreNumber(123456789012), "123456789012")
	coreEqual(t, QuotaText(AccountUsage{AccountUsageOk{Windows: []UsageWindow{{Label: "5 小时", UsedPercent: 33.3}}}}), "5 小时 剩 66.7%")
	left, ok := QuotaLeft(AccountUsage{AccountUsageOk{Windows: []UsageWindow{{UsedPercent: 30}, {UsedPercent: 120}}}})
	coreEqual(t, [2]any{left, ok}, [2]any{0.0, true})
}
