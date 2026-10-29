import type { ConnectorID, ConnectorState, ConnectorStatus } from "@vibevalley/protocol";
import { stories, story } from "@vibevalley/stories";
import { ConnectorCard } from "./ConnectorsPage";

const now = Date.now();
const min = 60_000;

const qr = "https://login.weixin.qq.com/l/story-sample";

const statusOf = (id: ConnectorID, state: ConnectorState, more: Partial<ConnectorStatus> = {}): ConnectorStatus => {
  const base: ConnectorStatus = { id, state, pending: 0, error: "", qr: "", pairCode: "" };
  switch (state) {
    case "off":
      return { ...base, ...more };
    case "waiting":
    case "scanned":
    case "verify":
      return { ...base, qr, ...more };
    case "pairing":
      return { ...base, pairCode: "4821", ...more };
    case "connected":
      return { ...base, owner: "主人", channel: "general", since: now - 3 * 24 * 60 * min, lastInbound: now - 12 * min, pending: 2, ...more };
    case "paused":
      return { ...base, owner: "主人", channel: "general", since: now - 3 * 24 * 60 * min, lastInbound: now - 90 * min, pausedUntil: now + 45 * min, ...more };
  }
};

export default stories({
  title: "界面/连接/连接器",
  stories: {
    States: story({
      note: "微信从没连到连上、暂停的每一步：扫码、扫了、要验证码、配对、连上（转到哪个群、多久没消息、积着几条）、暂停到几点。",
      args: { id: "weixin", state: "off" },
      grid: { rows: ["state", ["off", "waiting", "scanned", "verify", "pairing", "connected", "paused"]] },
      render: (a) => (
        <div class="w-[30rem]">
          <ConnectorCard id={a.id as ConnectorID} status={statusOf(a.id as ConnectorID, a.state as ConnectorState)} />
        </div>
      ),
    }),
    Apps: story({
      note: "没连时三家各自的开头：微信、飞书扫码，QQ 要填机器人的 AppID 和密钥。",
      args: { id: "weixin" },
      grid: { cols: ["id", ["weixin", "feishu", "qq"]] },
      render: (a) => (
        <div class="w-80">
          <ConnectorCard id={a.id as ConnectorID} status={statusOf(a.id as ConnectorID, "off")} />
        </div>
      ),
    }),
    Error: story({
      note: "出错时原因写在卡片底下，状态照旧。",
      args: { error: "二维码过期了，点刷新再扫一次" },
      render: (a) => (
        <div class="w-[30rem]">
          <ConnectorCard id="weixin" status={statusOf("weixin", "waiting", { error: a.error })} />
        </div>
      ),
    }),
  },
});
