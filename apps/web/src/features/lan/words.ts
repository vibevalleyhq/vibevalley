// What connecting to this machine says: the pane that lets a phone or another computer in, the devices by kind, and
// the page it pairs on.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  lan: {
    section: { label: "连接到本机", line: "手机和别的电脑" },
    notes: [
      "帮工能在这台电脑上跑命令，所以只让配对过的设备连进来；配对要你在这里点头。",
      "配对过的设备和你一样用这台电脑上的 VibeValley。开关和设备只能在这台电脑上管。",
      "连接走的是不加密的 HTTP：同一个网络里的人可能看到传的内容。只在信得过的网络里开，比如家里的 Wi-Fi、自己的热点。",
      "电脑换了地址（换了网络）以后，设备连不上了，在这里添加设备再扫一次就好，不用重新点头。",
    ],
    title: "连接到本机",
    open: "开着",
    closed: "关着",
    intro: "打开以后，同一个局域网里的手机或另一台电脑扫码配对以后，就能用这台电脑上的 VibeValley：看帮工、派活、在田头说话。",
    allow: "允许连接",
    address: "地址",
    add: "添加设备",
    close: "关掉连接",
    devices: "配对过的设备",
    deviceCount: (n: number) => `${n} 台`,
    paired: (at: string, seen: string | undefined) => `配对于 ${at} · ${seen ? `上次来 ${seen}` : "还没来过"}`,
    removeWhich: (name: string) => `移除 ${name}`,
    remove: "移除",
    copied: "复制好了：在另一台电脑的浏览器里打开它。",
    notCopied: "复制不了：选中链接自己复制吧。",
    qr: "配对二维码",
    scan: "手机用相机扫这个码；另一台电脑在浏览器里打开这个链接：",
    left: (s: number) => `还有 ${s} 秒有效，只能用一次。`,
    copy: "复制链接",
    newCode: "换一个码",
    stop: "不加了",
    asking: (name: string) => `「${name}」想连接到这台电脑。让它进来以后，它能和你一样用这台电脑上的 VibeValley。`,
    letIn: "让它进来",
    refuse: "不让",
  },
  devices: { android: "安卓手机", windows: "Windows 电脑", device: "一台设备" },
  pair: {
    title: "连进那台电脑",
    intro: "这台设备连进那台电脑上的 VibeValley，和主人一样看帮工、派活、在田头说话。配对要那台电脑上的主人点头。",
    code: "配对码",
    codeHint: "在那台电脑的「连接到本机」里点「添加设备」",
    name: "这台设备叫",
    nameHint: "主人在设备列表里看到的名字",
    ask: "请主人放行",
    waiting: "等那台电脑上的主人点头……",
  },
};

const en: typeof zh = {
  lan: {
    section: { label: "Connect to this machine", line: "Phones and other computers" },
    notes: [
      "Helpers can run commands on this computer, so only paired devices may connect; pairing needs your approval here.",
      "A paired device uses VibeValley on this computer as you do. The switch and the devices are managed only on this computer.",
      "The connection is plain HTTP: people on the same network may see what goes over it. Turn it on only on networks you trust, such as your home Wi-Fi or your own hotspot.",
      "When the computer's address changes (another network), devices cannot connect; add the device here and scan again, without approving again.",
    ],
    title: "Connect to this machine",
    open: "On",
    closed: "Off",
    intro:
      "Once on, a phone or another computer on the same local network can scan to pair, then use VibeValley on this computer: see helpers, send work, talk in the farm chat.",
    allow: "Allow connections",
    address: "Address",
    add: "Add a device",
    close: "Turn off",
    devices: "Paired devices",
    deviceCount: (n) => `${n}`,
    paired: (at, seen) => `Paired ${at} · ${seen ? `last seen ${seen}` : "never seen"}`,
    removeWhich: (name) => `Remove ${name}`,
    remove: "Remove",
    copied: "Copied: open it in the other computer's browser.",
    notCopied: "Cannot copy: select the link and copy it yourself.",
    qr: "Pairing QR code",
    scan: "Scan this code with the phone's camera; on another computer, open this link in the browser:",
    left: (s) => `Valid for ${s} more seconds, once.`,
    copy: "Copy the link",
    newCode: "Another code",
    stop: "Stop adding",
    asking: (name) => `"${name}" wants to connect to this computer. Let in, it can use VibeValley on this computer as you do.`,
    letIn: "Let it in",
    refuse: "Refuse",
  },
  devices: { android: "Android phone", windows: "Windows PC", device: "A device" },
  pair: {
    title: "Connect to that computer",
    intro:
      "This device connects to VibeValley on that computer and, like the owner, sees helpers, sends work and talks in the farm chat. Pairing needs the owner's approval on that computer.",
    code: "Pairing code",
    codeHint: "On that computer, press Add a device under Connect to this machine",
    name: "This device is called",
    nameHint: "The name the owner sees in the list of devices",
    ask: "Ask the owner to let it in",
    waiting: "Waiting for the owner on that computer to approve…",
  },
};

export const lanWording = localized({ zh, en });
