// What connecting to this machine (连接到本机) says to the owner and to the devices that connect: pairing, refusals, and
// what forgetting a device does.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  aDevice: "一台设备",
  noDevice: (id: string) => `没有 ${id} 这台设备`,
  notUp: "VibeValley 还没起来",
  unpaired: "这台设备没配对，或者已经被主人移除了：回那台电脑上扫码配对",
  notRemote: "连进来的设备不能做这个：只能在跑着 VibeValley 的那台电脑上做",
  badGateway: "转不过去",
  cannotOpen: (why: string) => "连接开不起来：" + why,
  noAddress: "找不到这台电脑在局域网里的地址：连上 Wi-Fi 或网线再试",
  notOpen: "还没允许连接：先打开它",
  noneAsking: "没有设备在等你点头",
  closedThere: "那台电脑没允许连接：回那台电脑的「连接到本机」打开它",
  codeExpired: "配对码过期了：回那台电脑上换一个码",
  wrongCode: "配对码不对",
  anotherAsking: "另一台设备正在等主人点头：等一会儿再试",
  ownerLate: "主人没来得及点头，配对码过期了：回那台电脑上换一个码",
  denied: "主人没让这台设备进来",
  noCode: "没有在配对的码：什么都不会动",
  dropCode: (code: string) => `收起配对码 ${code}`,
  dropAsking: (name: string) => `正在等你点头的「${name}」连不进来`,
  forget: (name: string) => `忘掉设备「${name}」：它的钥匙作废，要再连得重新配对`,
  cut: (n: number) => `断开它连着的 ${n} 条连接`,
  local: "这里就是跑着 VibeValley 的本机，不是连进来的设备",
};

const en: typeof zh = {
  aDevice: "A device",
  noDevice: (id) => `There is no device ${id}`,
  notUp: "VibeValley is not up yet",
  unpaired: "This device is not paired, or the owner removed it: pair it again by scanning on that computer",
  notRemote: "A connected device cannot do this: only the computer running VibeValley can",
  badGateway: "Could not pass it on",
  cannotOpen: (why) => "The connection cannot open: " + why,
  noAddress: "Cannot find this computer's address on the local network: connect to Wi-Fi or a cable and try again",
  notOpen: "Connections are not allowed yet: turn them on first",
  noneAsking: "No device is waiting for your approval",
  closedThere: "That computer does not allow connections: turn on Connect to this machine there",
  codeExpired: "The pairing code expired: get a new one on that computer",
  wrongCode: "Wrong pairing code",
  anotherAsking: "Another device is waiting for the owner's approval: try again in a moment",
  ownerLate: "The owner did not approve in time and the pairing code expired: get a new one on that computer",
  denied: "The owner did not let this device in",
  noCode: "No pairing code is out: nothing changes",
  dropCode: (code) => `Withdraw the pairing code ${code}`,
  dropAsking: (name) => `"${name}", waiting for your approval, cannot get in`,
  forget: (name) => `Forget the device "${name}": its key stops working, and it must pair again to connect`,
  cut: (n) => `Cut its ${n} open connections`,
  local: "This is the machine running VibeValley, not a connected device",
};

export const lanWording = localized({ zh, en });
