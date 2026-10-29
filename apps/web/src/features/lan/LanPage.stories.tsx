import type { LanDevice, LanStatus } from "@vibevalley/protocol";
import { stories, story, type Story } from "@vibevalley/stories";
import { answer } from "../../base/storyApi";
import { LanPage } from "./LanPage";

const now = Date.now();
const min = 60_000;

const devices: LanDevice[] = [
  { id: "d1", name: "主人的 iPhone", pairedAt: now - 9 * 24 * 60 * min, lastSeen: now - 3 * min },
  { id: "d2", name: "书房的 iPad", pairedAt: now - 30 * 24 * 60 * min },
];

const base: LanStatus = { open: false, hostName: "studio-mac", devices: [] };
const open: LanStatus = { ...base, open: true, url: "http://192.168.1.20:8790" };

const scene = (note: string, status: LanStatus): Story =>
  story({
    fill: true,
    note,
    render: () => {
      answer({ "lan/get": () => status });
      return <LanPage />;
    },
  });

export default stories({
  title: "界面/连接/连接到本机",
  stories: {
    关着: scene("默认关着：打开了，局域网里的设备才能扫码连进来。", base),
    开着: scene("开着，还没有设备：加一台出二维码。", open),
    出码: scene("二维码和链接，几分钟内有效，倒数着。", {
      ...open,
      pairing: { code: "4821", link: "http://192.168.1.20:8790/pair?c=4821", expiresAt: now + 4 * min },
    }),
    有人要进来: scene("有台设备扫了码：主人在这台电脑上点头才放进来。", {
      ...open,
      pairing: { code: "4821", link: "http://192.168.1.20:8790/pair?c=4821", expiresAt: now + 3 * min, asking: "主人的 iPhone" },
    }),
    已连的设备: scene("连过的设备，各自什么时候连的、最近一次见到；可以踢掉。", { ...open, devices }),
    出了问题: scene("开不起来时原因写在页面上。", { ...base, problem: "8790 端口被占用了：换一个端口再开" }),
  },
});
