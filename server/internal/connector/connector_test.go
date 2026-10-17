package connector

import (
	"context"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/feishu"
	"vibevalley/pkg/qq"
	"vibevalley/pkg/weixin"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/ptr"
)

const voiceOwner = "o9cq80wkM5NnOwnerOfThisFarm@im.wechat"

type voiceSent struct {
	App   protocol.ConnectorID
	To    string
	Text  string
	Reply string
}

type voiceScript struct {
	mu          sync.Mutex
	qr          []weixin.QrStatus
	feishuPolls []feishu.RegistrationPoll
	sent        []voiceSent
	// restricted: while set, sending fails as the apps do when a reply's window has passed.
	restricted atomic.Bool

	weixin chan weixin.Message
	feishu chan feishu.Message
	qq     chan qq.Message
}

func (s *voiceScript) record(m voiceSent) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sent = append(s.sent, m)
	return len(s.sent)
}

func (s *voiceScript) sentBy(app protocol.ConnectorID) []voiceSent {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []voiceSent
	for _, m := range s.sent {
		if m.App == app {
			out = append(out, m)
		}
	}
	return out
}

type voiceScriptedIlink struct{ s *voiceScript }

func (voiceScriptedIlink) QrCode(context.Context) (string, string, error) {
	return "q1", "https://liteapp.weixin.qq.com/q/q1", nil
}

func (a voiceScriptedIlink) QrStatus(ctx context.Context, _, _, _ string) weixin.QrStatus {
	clock.Sleep(ctx, 20*time.Millisecond)
	a.s.mu.Lock()
	defer a.s.mu.Unlock()
	if len(a.s.qr) == 0 {
		return weixin.QrStatus{Status: "wait"}
	}
	next := a.s.qr[0]
	a.s.qr = a.s.qr[1:]
	return next
}

func (a voiceScriptedIlink) GetUpdates(ctx context.Context, _ weixin.Account, buf string, _ time.Duration) (weixin.Updates, error) {
	zero := 0
	select {
	case m := <-a.s.weixin:
		return weixin.Updates{Ret: &zero, Msgs: []weixin.Message{m}, GetUpdatesBuf: buf + "+"}, nil
	case <-time.After(100 * time.Millisecond):
		return weixin.Updates{Ret: &zero, GetUpdatesBuf: buf}, nil
	case <-ctx.Done():
		return weixin.Updates{}, ctx.Err()
	}
}

func (a voiceScriptedIlink) SendText(_ context.Context, _ weixin.Account, to, text, contextToken string) (string, error) {
	if a.s.restricted.Load() {
		return "", &weixin.Error{Reason: "sendmessage: -2", Code: -2}
	}
	return fmt.Sprintf("wx%d", a.s.record(voiceSent{App: protocol.ConnectorIDWeixin, To: to, Text: text, Reply: contextToken})), nil
}

type voiceScriptedFeishu struct{ s *voiceScript }

func (voiceScriptedFeishu) Register(context.Context) (feishu.Registration, error) {
	return feishu.Registration{DeviceCode: "dev1", URL: "https://open.feishu.cn/page/cli?user_code=AB", Interval: 20 * time.Millisecond, Expires: 5 * time.Second}, nil
}

func (a voiceScriptedFeishu) Poll(context.Context, string, feishu.Domain) feishu.RegistrationPoll {
	a.s.mu.Lock()
	defer a.s.mu.Unlock()
	if len(a.s.feishuPolls) == 0 {
		return feishu.RegistrationPoll{Status: "pending", Domain: "feishu"}
	}
	next := a.s.feishuPolls[0]
	a.s.feishuPolls = a.s.feishuPolls[1:]
	return next
}

func (a voiceScriptedFeishu) Listen(ctx context.Context, _ feishu.App, got func(feishu.Message)) error {
	for {
		select {
		case m := <-a.s.feishu:
			got(m)
		case <-ctx.Done():
			return nil
		}
	}
}

func (a voiceScriptedFeishu) SendText(_ context.Context, _ feishu.App, openID, text string) (string, error) {
	return fmt.Sprintf("om_%d", a.s.record(voiceSent{App: protocol.ConnectorIDFeishu, To: openID, Text: text})), nil
}

type voiceScriptedQQ struct{ s *voiceScript }

func (voiceScriptedQQ) Check(_ context.Context, app qq.App) error {
	if app.Secret == "right" {
		return nil
	}
	return fmt.Errorf("QQ 鉴权：AppID 或 AppSecret 不对")
}

func (a voiceScriptedQQ) Listen(ctx context.Context, _ qq.App, got func(qq.Message)) error {
	for {
		select {
		case m := <-a.s.qq:
			got(m)
		case <-ctx.Done():
			return nil
		}
	}
}

func (a voiceScriptedQQ) SendText(_ context.Context, _ qq.App, openID, text, msgID string) (string, *qq.SendError) {
	if a.s.restricted.Load() {
		return "", &qq.SendError{Status: 400, Reason: "QQ 发消息：被动回复超时"}
	}
	return fmt.Sprintf("qq%d", a.s.record(voiceSent{App: protocol.ConnectorIDQq, To: openID, Text: text, Reply: msgID})), nil
}

func voiceConnectorsFarm(t *testing.T) (*world, *voiceScript) {
	t.Helper()
	f := connectorTestFarm(t)
	s := &voiceScript{
		qr: []weixin.QrStatus{
			{Status: "scaned"},
			{Status: "confirmed", BotToken: "tok", IlinkBotID: "bot1@im.bot", BaseURL: "https://ilinkai.weixin.qq.com", IlinkUserID: voiceOwner},
		},
		feishuPolls: []feishu.RegistrationPoll{
			{Status: "pending", Domain: "feishu"},
			{Status: "succeeded", AppID: "cli_1", AppSecret: "s", Domain: "feishu"},
		},
		weixin: make(chan weixin.Message, 16),
		feishu: make(chan feishu.Message, 16),
		qq:     make(chan qq.Message, 16),
	}
	c := f.Connector
	c.ilink, c.feishu, c.qq = voiceScriptedIlink{s}, voiceScriptedFeishu{s}, voiceScriptedQQ{s}
	var n atomic.Int64
	c.say = func(_ context.Context, text string, conversation *string) error {
		said, err := f.Channel.Say(text, conversation)
		if err != nil {
			return err
		}
		f.Channel.ManagerSays(said.Conversation, fmt.Sprintf("k%d", n.Add(1)), "收到：**"+text+"**", true)
		return nil
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	return f, s
}

func voiceStatusOf(f *world, id protocol.ConnectorID) protocol.ConnectorStatus {
	for _, s := range f.Connector.List() {
		if s.ID == id {
			return s
		}
	}
	return protocol.ConnectorStatus{}
}

func voiceReaches(t *testing.T, f *world, id protocol.ConnectorID, state protocol.ConnectorState) protocol.ConnectorStatus {
	t.Helper()
	return testkit.Await(t, fmt.Sprintf("%s %s", id, state), func() (protocol.ConnectorStatus, bool) {
		s := voiceStatusOf(f, id)
		return s, s.State == state
	})
}

func voiceNth(t *testing.T, s *voiceScript, app protocol.ConnectorID, n int, what string) voiceSent {
	t.Helper()
	return testkit.Await(t, what, func() (voiceSent, bool) {
		sent := s.sentBy(app)
		if len(sent) > n {
			return sent[n], true
		}
		return voiceSent{}, false
	})
}

func voiceSaidIn(t *testing.T, f *world, conversation string) []string {
	t.Helper()
	history, err := f.Channel.History(conversation, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	out := []string{}
	for _, m := range history {
		if m.From == "user" {
			out = append(out, m.Text)
		}
	}
	return out
}

var voiceMsgID atomic.Int64

func voiceWx(who, text, context string) weixin.Message {
	id := voiceMsgID.Add(1) + 100
	if context == "" {
		context = fmt.Sprintf("ctx-%d", id)
	}
	item := weixin.Item{Type: 1}
	item.TextItem = &struct {
		Text string `json:"text,omitempty"`
	}{text}
	return weixin.Message{MessageID: fmt.Sprint(id), FromUserID: who, MessageType: 1, ContextToken: context, ItemList: []weixin.Item{item}}
}

func voiceQQMsg(from, content string) qq.Message {
	return qq.Message{ID: fmt.Sprintf("qm%d", voiceMsgID.Add(1)), From: from, Content: content}
}

func voiceFeishuMsg(from, text string) feishu.Message {
	content, _ := json.Marshal(map[string]string{"text": text})
	return feishu.Message{MessageID: fmt.Sprintf("om%d", voiceMsgID.Add(1)), From: from, ChatType: "p2p", MessageType: "text", Content: string(content)}
}

func voiceWeixinConnected(t *testing.T, f *world) protocol.ConnectorStatus {
	t.Helper()
	first := f.Connector.Login(protocol.ConnectorIDWeixin, protocol.ConnectorLogin{})
	if first.Qr == nil || *first.Qr != "https://liteapp.weixin.qq.com/q/q1" {
		t.Fatalf("the code to scan: %+v", first)
	}
	return voiceReaches(t, f, protocol.ConnectorIDWeixin, protocol.ConnectorStateConnected)
}

func voiceQQPaired(t *testing.T, f *world, s *voiceScript) {
	t.Helper()
	f.Connector.Login(protocol.ConnectorIDQq, protocol.ConnectorLogin{AppID: ptr.To("102"), Secret: ptr.To("right")})
	code := voiceReaches(t, f, protocol.ConnectorIDQq, protocol.ConnectorStatePairing).PairCode
	s.qq <- voiceQQMsg("owner-openid", *code)
	voiceReaches(t, f, protocol.ConnectorIDQq, protocol.ConnectorStateConnected)
}

func TestConnectorsWeixinOwnerSaidOnTheGeneral(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	status := voiceWeixinConnected(t, f)
	if *status.Owner != "o9cq…chat" {
		t.Fatalf("owner: %s", *status.Owner)
	}
	s.weixin <- voiceWx(voiceOwner, "帮我看看打卡页", "ctx-a")
	reply := voiceNth(t, s, protocol.ConnectorIDWeixin, 0, "the answer in WeChat")
	if want := (voiceSent{App: protocol.ConnectorIDWeixin, To: voiceOwner, Text: "【管家】\n收到：帮我看看打卡页", Reply: "ctx-a"}); reply != want {
		t.Fatalf("reply: %+v", reply)
	}
	if got := voiceSaidIn(t, f, f.Channel.General()); !reflect.DeepEqual(got, []string{"帮我看看打卡页"}) {
		t.Fatalf("general: %v", got)
	}
	if voiceStatusOf(f, protocol.ConnectorIDWeixin).LastInbound == nil {
		t.Fatal("last inbound")
	}
}

func TestConnectorsWeixinInAnotherChannel(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	voiceWeixinConnected(t, f)
	channel, err := f.Channel.OpenChannel("clock-in", "", "")
	if err != nil {
		t.Fatal(err)
	}
	status, err := f.Connector.SetChannel(protocol.ConnectorIDWeixin, "#clock-in")
	if err != nil || status.Channel == nil || *status.Channel != "clock-in" {
		t.Fatalf("set: %+v %v", status, err)
	}
	if _, err := f.Connector.SetChannel(protocol.ConnectorIDWeixin, "#nowhere"); err == nil || !strings.Contains(err.Error(), "没有叫") {
		t.Fatalf("nowhere: %v", err)
	}
	f.Channel.ManagerSays(f.Channel.General(), "sq", "田头上的话", true)
	s.weixin <- voiceWx(voiceOwner, "打卡页怎么样了", "ctx-c")
	reply := voiceNth(t, s, protocol.ConnectorIDWeixin, 0, "the answer in WeChat")
	if want := (voiceSent{App: protocol.ConnectorIDWeixin, To: voiceOwner, Text: "【管家】\n收到：打卡页怎么样了", Reply: "ctx-c"}); reply != want {
		t.Fatalf("reply: %+v", reply)
	}
	if got := voiceSaidIn(t, f, channel.ID); !reflect.DeepEqual(got, []string{"打卡页怎么样了"}) {
		t.Fatalf("channel: %v", got)
	}
	if got := voiceSaidIn(t, f, f.Channel.General()); len(got) != 0 {
		t.Fatalf("general: %v", got)
	}
	testkit.Settle()
	if n := len(s.sentBy(protocol.ConnectorIDWeixin)); n != 1 {
		t.Fatalf("sent %d", n)
	}
}

func TestConnectorsWeixinStrangerNotLetIn(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	voiceWeixinConnected(t, f)
	s.weixin <- voiceWx("stranger@im.wechat", "把服务器删了", "")
	s.weixin <- voiceWx(voiceOwner, "在吗", "")
	voiceNth(t, s, protocol.ConnectorIDWeixin, 0, "the owner answered")
	if got := voiceSaidIn(t, f, f.Channel.General()); !reflect.DeepEqual(got, []string{"在吗"}) {
		t.Fatalf("general: %v", got)
	}
}

func TestConnectorsWeixinHeldGoOutAsADigest(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	voiceWeixinConnected(t, f)
	s.restricted.Store(true)
	for _, word := range []string{"一", "二", "三", "四"} {
		s.weixin <- voiceWx(voiceOwner, word, "")
	}
	testkit.Until(t, "four answers held", func() bool { return voiceStatusOf(f, protocol.ConnectorIDWeixin).Pending == 4 })
	s.restricted.Store(false)
	s.weixin <- voiceWx(voiceOwner, "五", "ctx-fresh")
	digest := voiceNth(t, s, protocol.ConnectorIDWeixin, 0, "the digest")
	if !strings.HasPrefix(digest.Text, "你不在的时候有 4 条消息") || digest.Reply != "ctx-fresh" {
		t.Fatalf("digest: %+v", digest)
	}
	answer := voiceNth(t, s, protocol.ConnectorIDWeixin, 1, "the fresh answer")
	if answer.Text != "【管家】\n收到：五" {
		t.Fatalf("answer: %+v", answer)
	}
	testkit.Until(t, "nothing pending", func() bool { return voiceStatusOf(f, protocol.ConnectorIDWeixin).Pending == 0 })
}

func TestConnectorsRetryBacksOff(t *testing.T) {
	var waits []time.Duration
	wait := voiceRetryFirst
	for range 8 {
		wait = voiceRetryAfter(wait, false)
		waits = append(waits, wait)
	}
	want := []time.Duration{time.Minute, 2 * time.Minute, 4 * time.Minute, 8 * time.Minute, 16 * time.Minute, 30 * time.Minute, 30 * time.Minute, 30 * time.Minute}
	if !reflect.DeepEqual(waits, want) {
		t.Fatalf("waits: %v", waits)
	}
	if got := voiceRetryAfter(30*time.Minute, true); got != voiceRetryFirst {
		t.Fatalf("after one went out: %v", got)
	}
}

func TestConnectorsWeixinHeldGoOutByThemselves(t *testing.T) {
	first, most := voiceRetryFirst, voiceRetryMost
	voiceRetryFirst, voiceRetryMost = 20*time.Millisecond, 80*time.Millisecond
	t.Cleanup(func() { voiceRetryFirst, voiceRetryMost = first, most })
	f, s := voiceConnectorsFarm(t)
	voiceWeixinConnected(t, f)
	s.restricted.Store(true)
	s.weixin <- voiceWx(voiceOwner, "一", "ctx-1")
	testkit.Until(t, "held", func() bool { return voiceStatusOf(f, protocol.ConnectorIDWeixin).Pending == 1 })
	testkit.Settle()
	s.restricted.Store(false)
	held := voiceNth(t, s, protocol.ConnectorIDWeixin, 0, "the held answer")
	if held.Text != "【管家】\n收到：一" || held.Reply != "ctx-1" {
		t.Fatalf("held: %+v", held)
	}
	testkit.Until(t, "nothing pending", func() bool { return voiceStatusOf(f, protocol.ConnectorIDWeixin).Pending == 0 })
}

func TestConnectorsWeixinLogoutForgets(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	voiceWeixinConnected(t, f)
	s.restricted.Store(true)
	s.weixin <- voiceWx(voiceOwner, "一", "")
	testkit.Until(t, "held", func() bool { return voiceStatusOf(f, protocol.ConnectorIDWeixin).Pending == 1 })
	after := f.Connector.Logout(protocol.ConnectorIDWeixin)
	if after.State != protocol.ConnectorStateOff || after.Pending != 0 || after.Owner != nil {
		t.Fatalf("after: %+v", after)
	}
}

func TestConnectorsQQPairing(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	f.Connector.Login(protocol.ConnectorIDQq, protocol.ConnectorLogin{AppID: ptr.To("102"), Secret: ptr.To("wrong")})
	refused := testkit.Await(t, "refused", func() (protocol.ConnectorStatus, bool) {
		st := voiceStatusOf(f, protocol.ConnectorIDQq)
		return st, st.State == protocol.ConnectorStateOff && st.Error != nil
	})
	if !strings.Contains(*refused.Error, "不对") {
		t.Fatalf("refused: %s", *refused.Error)
	}
	f.Connector.Login(protocol.ConnectorIDQq, protocol.ConnectorLogin{AppID: ptr.To("102"), Secret: ptr.To("right")})
	pairing := voiceReaches(t, f, protocol.ConnectorIDQq, protocol.ConnectorStatePairing)
	if pairing.PairCode == nil || !regexp.MustCompile(`^\d{6}$`).MatchString(*pairing.PairCode) {
		t.Fatalf("code: %+v", pairing)
	}
	s.qq <- voiceQQMsg("someone", "你好")
	s.qq <- voiceQQMsg("owner-openid", "配对 "+*pairing.PairCode)
	paired := voiceReaches(t, f, protocol.ConnectorIDQq, protocol.ConnectorStateConnected)
	if *paired.Owner != "owne…enid" {
		t.Fatalf("owner: %s", *paired.Owner)
	}
	if welcome := voiceNth(t, s, protocol.ConnectorIDQq, 0, "the welcome"); !strings.HasPrefix(welcome.Text, "配对好了") {
		t.Fatalf("welcome: %+v", welcome)
	}
	s.qq <- voiceQQMsg("someone", "我也想派活")
	last := voiceQQMsg("owner-openid", "跑一下测试")
	s.qq <- last
	answer := voiceNth(t, s, protocol.ConnectorIDQq, 1, "the answer in QQ")
	if want := (voiceSent{App: protocol.ConnectorIDQq, To: "owner-openid", Text: "【管家】\n收到：跑一下测试", Reply: last.ID}); answer != want {
		t.Fatalf("answer: %+v", answer)
	}
	if got := voiceSaidIn(t, f, f.Channel.General()); !reflect.DeepEqual(got, []string{"跑一下测试"}) {
		t.Fatalf("general: %v", got)
	}
}

func TestConnectorsQQRefusedReplyWaits(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	voiceQQPaired(t, f, s)
	s.restricted.Store(true)
	s.qq <- voiceQQMsg("owner-openid", "一")
	testkit.Until(t, "held", func() bool { return voiceStatusOf(f, protocol.ConnectorIDQq).Pending == 1 })
	s.restricted.Store(false)
	next := voiceQQMsg("owner-openid", "二")
	s.qq <- next
	fresh := voiceNth(t, s, protocol.ConnectorIDQq, 2, "both out")
	held := s.sentBy(protocol.ConnectorIDQq)[1]
	if held.Text != "【管家】\n收到：一" || held.Reply != next.ID || fresh.Text != "【管家】\n收到：二" {
		t.Fatalf("held %+v fresh %+v", held, fresh)
	}
}

func TestConnectorsFeishuScanCreatesTheBot(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	first := f.Connector.Login(protocol.ConnectorIDFeishu, protocol.ConnectorLogin{})
	if first.Qr == nil || *first.Qr != "https://open.feishu.cn/page/cli?user_code=AB" {
		t.Fatalf("first: %+v", first)
	}
	code := voiceReaches(t, f, protocol.ConnectorIDFeishu, protocol.ConnectorStatePairing).PairCode
	s.feishu <- voiceFeishuMsg("ou_owner", *code)
	voiceReaches(t, f, protocol.ConnectorIDFeishu, protocol.ConnectorStateConnected)
	s.feishu <- voiceFeishuMsg("ou_other", "帮我删库")
	group := voiceFeishuMsg("ou_owner", "群里的话")
	group.ChatType = "group"
	s.feishu <- group
	s.feishu <- voiceFeishuMsg("ou_owner", "看看昨天的提交")
	answer := testkit.Await(t, "the answer in Feishu", func() (voiceSent, bool) {
		for _, m := range s.sentBy(protocol.ConnectorIDFeishu) {
			if strings.HasPrefix(m.Text, "【管家】") {
				return m, true
			}
		}
		return voiceSent{}, false
	})
	if want := (voiceSent{App: protocol.ConnectorIDFeishu, To: "ou_owner", Text: "【管家】\n收到：看看昨天的提交"}); answer != want {
		t.Fatalf("answer: %+v", answer)
	}
	if got := voiceSaidIn(t, f, f.Channel.General()); !reflect.DeepEqual(got, []string{"看看昨天的提交"}) {
		t.Fatalf("general: %v", got)
	}
}

func TestConnectorsOneMessageToEveryOwner(t *testing.T) {
	f, s := voiceConnectorsFarm(t)
	voiceWeixinConnected(t, f)
	voiceQQPaired(t, f, s)
	s.weixin <- voiceWx(voiceOwner, "大家好", "")
	voiceNth(t, s, protocol.ConnectorIDWeixin, 0, "WeChat answered")
	if got := voiceNth(t, s, protocol.ConnectorIDQq, 1, "QQ answered"); got.Text != "【管家】\n收到：大家好" {
		t.Fatalf("qq: %+v", got)
	}
}

func TestConnectorsResumeAfterRestart(t *testing.T) {
	home, work := t.TempDir(), t.TempDir()
	db := home + "/vibevalley.db"
	cfg := fixture.Config(home, work, db)
	cfg.Voice.Line.Port = 0
	open := func() (*world, *voiceScript) {
		f, err := newWorld(cfg)
		if err != nil {
			t.Fatal(err)
		}
		s := &voiceScript{weixin: make(chan weixin.Message, 4), feishu: make(chan feishu.Message, 4), qq: make(chan qq.Message, 4)}
		s.qr = []weixin.QrStatus{{Status: "confirmed", BotToken: "tok", IlinkBotID: "bot1", IlinkUserID: voiceOwner}}
		f.Connector.ilink, f.Connector.feishu, f.Connector.qq = voiceScriptedIlink{s}, voiceScriptedFeishu{s}, voiceScriptedQQ{s}
		f.Connector.say = func(_ context.Context, text string, conversation *string) error {
			_, err := f.Channel.Say(text, conversation)
			return err
		}
		if err := f.Start(context.Background()); err != nil {
			t.Fatal(err)
		}
		return f, s
	}
	f, _ := open()
	voiceWeixinConnected(t, f)
	f.Close()
	f, s := open()
	defer f.Close()
	if st := voiceStatusOf(f, protocol.ConnectorIDWeixin); st.State != protocol.ConnectorStateConnected {
		t.Fatalf("kept: %+v", st)
	}
	s.weixin <- voiceWx(voiceOwner, "又见面了", "")
	testkit.Until(t, "heard after a restart", func() bool {
		got := voiceSaidIn(t, f, f.Channel.General())
		return len(got) == 1 && got[0] == "又见面了"
	})
}
