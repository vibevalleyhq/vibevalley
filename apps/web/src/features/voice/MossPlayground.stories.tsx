import { stories, story, type Story } from "@vibevalley/stories";
import type { MossQos } from "./mossLine";
import { MossLineView, type MossLineState } from "./MossPlayground";

const quiet: MossQos = { upKbps: 0, downKbps: 0, framesPerSecond: 0, backlog: 0, aheadMs: 0, gaps: 0, replies: 0, stops: {} };
const good: MossQos = {
  upKbps: 34,
  downKbps: 96,
  framesPerSecond: 50,
  backlog: 0,
  aheadMs: 420,
  gaps: 0,
  replyMs: 820,
  replyMeanMs: 910,
  replies: 4,
  stops: {},
};
const poor: MossQos = {
  upKbps: 12,
  downKbps: 40,
  framesPerSecond: 31,
  backlog: 24_000,
  aheadMs: 0,
  gaps: 3,
  replyMs: 3900,
  replyMeanMs: 2700,
  replies: 5,
  stops: { interrupted: 2 },
};

const turns: MossLineState["turns"] = [
  { who: "owner", key: "t1", text: "今天地里有什么要我看的？", done: true },
  { who: "moss", key: "t1", text: "两块地熟了：修好登录、补齐看板的测试。要先看哪个？", done: true },
  { who: "owner", key: "t2", text: "先看登录那个", done: false },
];

const events: MossLineState["events"] = [
  { up: true, text: '{"type":"session.update","persona":"农场的管家"}' },
  { up: false, text: '{"type":"session.created"}' },
  { up: false, text: '{"type":"input.speech.started"}' },
  { up: false, text: '{"type":"input.speech.stopped"}' },
  { up: false, text: '{"type":"response.audio.done"}' },
];

const line = (more: Partial<MossLineState>): MossLineState => ({
  phase: "idle",
  muted: false,
  micLevel: 0,
  mossLevel: 0,
  turns: [],
  events: [],
  qos: quiet,
  ...more,
});

const scene = (note: string, l: MossLineState): Story =>
  story({ fill: true, note, render: () => <MossLineView line={l} onTalk={() => undefined} onEnd={() => undefined} onMute={() => undefined} /> });

export default stories({
  title: "界面/语音/MOSS 通话",
  stories: {
    没开始: scene("还没打：人设和说明能改，按「说话」开始。", line({})),
    连接中: scene("在接通：按钮变成挂断，人设锁住。", line({ phase: "connecting", events: events.slice(0, 1) })),
    通话中: scene(
      "接通了：两边的音量、说过的话、线上来往的事件；数字都在正常范围里。",
      line({ phase: "live", micLevel: 46, mossLevel: 72, turns, events, qos: good }),
    ),
    静音: scene("自己静了音：麦克风的音量是零，键按着。", line({ phase: "live", muted: true, mossLevel: 30, turns, events, qos: good })),
    线路不好: scene(
      "回得慢、发不出去、断了几次：变红的就是超过了界限的（回话 2.5 秒、每秒 45 帧、积压 16 KB、断档）。",
      line({ phase: "live", micLevel: 20, mossLevel: 10, turns, events, qos: poor }),
    ),
    断了: scene("线断了：原因写在下面，记录还在。", line({ phase: "idle", problem: "MOSS 断开了：1006 连接意外关闭", turns, events })),
  },
});
