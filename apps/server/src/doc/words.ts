// What the documents say to the owner: why a document or an op is refused, and the demo's script: up to three helpers
// write one article at once from it, so the owner can watch several writers without paying for a model. Every heading
// says it is a demo.

import { localized } from "@vibevalley/protocol/words";

/** One section of the demo's script: its heading and the paragraphs its helper grows, a piece a tick. */
export interface DemoSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

const zh = {
  doc: (id: string) => "文档 " + id,
  untitled: "没起名的文档",
  otherDoc: (batch: string) => "这批改动（" + batch + "）是另一篇文档的",
  noBatch: "这批改动没有 batchId",
  demoNotInserted: (status: string) => "演示的块没插进去：" + status,
  noWriter: "没有能写的帮工：先在档案里打开一个",
  demoRunning: "演示正在写，写完再点",
  op: {
    deleted: "这一块已经删掉了",
    noAttr: (name: string) => `没有属性 ${name}`,
    noBlock: (id: string) => `没有块 ${id}`,
    noId: "新块没有 id",
    taken: (id: string) => "块 " + id + " 已经有了",
    unknownType: (type: string) => "不认识的块类型 " + type,
    badKey: (key: string) => "不是有效的顺序键：" + key,
    missing: "没有这一块",
    unknownOp: (op: string) => `不认识的改动 ${op}`,
    noText: "这一块没有字",
    noRev: (rev: number) => `没有第 ${rev} 版`,
    changed: "这一块刚被别人改过",
    underSelf: "不能挪到自己下面",
    splitAtEnd: "这一块刚被别人改过，从末尾拆开了",
    splitOutside: (at: number, length: number) => `拆分位置 ${at} 不在字里（${length} 个字）`,
    intoSelf: "不能并进自己",
  },
  demo: ([] = [
    {
      heading: "背景 · 演示",
      paragraphs: [
        "（演示）这一节是脚本写的，不是帮工真的想出来的。我们这里有好几个帮工，以前一篇文章只能一个人从头写到尾，别人只能等着。",
        "现在文档按块存，每一块有自己的版本号。几个帮工各写各的一节，互不抢同一块，谁写的哪一块，左边的归属条一眼就能看出来。",
        "这篇演示就是想让主人亲眼看一下：三个帮工同时动笔，字一段一段长出来，最后拼成一篇完整的文章。",
      ],
    },
    {
      heading: "做法 · 演示",
      paragraphs: [
        "（演示）每个帮工先在自己那一节的末尾插一个空段落，然后每隔一秒左右把这一段整段换新，看起来就是一段话在慢慢长长。",
        "所有改动都走和主人一样的 op 管线：插入是 insert_block，长字是 update_text，带着上一版的版本号，服务端按顺序一批一批收下。",
        "如果主人在帮工正写着的那一段里改了字，帮工那一下就会冲突、写不进去；它不抢这一段，接着去写下一段。",
      ],
    },
    {
      heading: "下一步 · 演示",
      paragraphs: [
        "（演示）等广播做好以后，页面不用再一秒问一次服务端，帮工写一下，主人这边马上就能看到。",
        "再往后，帮工想改别人那一节的字，不直接改，而是挂一条建议，等主人点头；写完的一节在大纲里标成写完待看。",
        "演示到这里就结束了。这篇文档留着也行，删掉也行，它不会影响任何工单和记性。",
      ],
    },
  ] as readonly DemoSection[]),
};

const en: typeof zh = {
  doc: (id) => "document " + id,
  untitled: "Untitled document",
  otherDoc: (batch) => "This batch of changes (" + batch + ") belongs to another document",
  noBatch: "This batch of changes has no batchId",
  demoNotInserted: (status) => "The demo's block was not inserted: " + status,
  noWriter: "No helper can write: turn one on in the profiles first",
  demoRunning: "The demo is writing: try again when it is done",
  op: {
    deleted: "This block was deleted",
    noAttr: (name) => `There is no attribute ${name}`,
    noBlock: (id) => `There is no block ${id}`,
    noId: "The new block has no id",
    taken: (id) => "Block " + id + " already exists",
    unknownType: (type) => "Unknown block type " + type,
    badKey: (key) => "Not a valid order key: " + key,
    missing: "There is no such block",
    unknownOp: (op) => `Unknown change ${op}`,
    noText: "This block has no text",
    noRev: (rev) => `There is no version ${rev}`,
    changed: "Someone else just changed this block",
    underSelf: "A block cannot move under itself",
    splitAtEnd: "Someone else just changed this block, so it was split at its end",
    splitOutside: (at, length) => `The split position ${at} is outside the text (${length} characters)`,
    intoSelf: "A block cannot merge into itself",
  },
  demo: [
    {
      heading: "Background · demo",
      paragraphs: [
        "(Demo) A script wrote this section; no helper really thought of it. We have several helpers here, and an article used to be written by one of them from start to end while the others waited.",
        "Now a document is stored in blocks, each with its own version. Each helper writes its own section without fighting over a block, and the bar on the left shows at a glance who wrote which.",
        "This demo lets you see it for yourself: three helpers write at once, the words grow paragraph by paragraph, and in the end they make one whole article.",
      ],
    },
    {
      heading: "How · demo",
      paragraphs: [
        "(Demo) Each helper first inserts an empty paragraph at the end of its section, then replaces that paragraph about once a second, so it looks like a paragraph slowly growing.",
        "Every change goes through the same op pipeline as yours: inserting is insert_block, growing is update_text with the last version's number, and the server takes them in order, batch by batch.",
        "If you change the words in a paragraph a helper is writing, the helper's next write conflicts and does not go in; it leaves that paragraph to you and goes on to the next.",
      ],
    },
    {
      heading: "Next · demo",
      paragraphs: [
        "(Demo) Once broadcasting is done, the page will no longer ask the server every second: when a helper writes, you see it at once.",
        "Later, a helper that wants to change another section's words will not change them directly but leave a suggestion for you to approve; a finished section is marked in the outline as done and waiting for you.",
        "That is the end of the demo. Keep this document or delete it: it touches no ticket and no memory.",
      ],
    },
  ],
};

export const docWording = localized({ zh, en });
