import type { LanStatus, UserDevice, UserStatus } from "@vibevalley/protocol";
import { stories, story, type Story } from "@vibevalley/stories";

import { Account, Devices } from "#/features/user/index.ts";
import { answer } from "#/infra/storyApi.ts";

import { LanPage } from "./LanPage";

const now = Date.now();
const min = 60_000;

const base: LanStatus = { open: false, hostName: "studio-mac", problem: "" };
const open: LanStatus = { ...base, open: true, url: "http://192.168.1.20:8790" };

const devices: UserDevice[] = [
  { id: "d1", name: "iPhone", came: "paired", addedAt: now - 9 * 24 * 60 * min, lastSeen: now - 3 * min },
  { id: "d2", name: "公司的笔记本", came: "login", addedAt: now - 2 * 24 * 60 * min, lastSeen: now - 40 * min },
  { id: "d3", name: "书房的 iPad", came: "paired", addedAt: now - 30 * 24 * 60 * min },
];

/** The whole devices page as settings shows it: the user's name and password, the gate, and every device with a key. */
const page = (note: string, user: UserStatus): Story =>
  story({
    fill: true,
    note,
    render: () => {
      answer({ "lan/get": () => open, "user/get": () => user, "user/device/list": () => devices });
      return (
        <>
          <Account />
          <LanPage />
          <Devices />
        </>
      );
    },
  });

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
    本机的整页: page("在跑着 VibeValley 的电脑上：改名字、设密码，下面列出配对来的和登录来的设备，都能收回。", { name: "小明", password: true, here: true }),
    登录来的设备: page("从别的设备登录进来：密码只能在那台电脑上设；这台能退出，列表里标着「这台」。", {
      name: "小明",
      password: true,
      here: false,
      device: devices[1]!,
    }),
    出了问题: scene("开不起来时原因写在页面上。", { ...base, problem: "8790 端口被占用了：换一个端口再开" }),
  },
});
