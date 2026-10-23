// The demo: up to three helpers write one article at once, from a script, through the real
// op pipeline as their profiles, so the owner can watch several writers without paying for a model. Nothing of it is a
// helper's own output; every heading says 演示. The writing itself is in doc.ts.

/** One section of the script: its heading and the paragraphs its helper grows, a piece a tick. */
export interface DemoSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
}

export const demoScript: readonly DemoSection[] = [
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
];

/** The pacing of one writer: about a tick per piece, a bit more or less so the writers interleave. */
export const demoPieces = 6;
export const demoJitter = 0.3;
