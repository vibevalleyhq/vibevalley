import type { Copy } from "./zh";

export const en: Copy = {
  lang: "en",
  home: "/en/",
  other: { label: "中文", href: "/", name: "中文" },
  title: "VibeValley · 码农场物语",
  description:
    "Assign tickets to Claude Code, Codex and other coding agents on your Mac. Follow their progress on a pixel farm, review changes in the native workbench and merge into main.",
  nav: { how: "How it plays", features: "What it does", screens: "The farm", start: "Get started", github: "GitHub" },
  hero: {
    name: "VibeValley",
    aka: "码农场物语",
    tagline: "Coding, like harvest time.",
    lead: "A crew of coding agents on a pixel farm, writing your code and running your tests.",
    // A day on the farm, a line for each hour as the page goes down, rhyming in pairs.
    verses: {
      morning: ["Say one line", "at break of day;"],
      day: ["the helpers sow", "and weed away."],
      evening: ["At dusk, reports", "come in by rows;"],
      night: ["you sleep, and still", "the garden grows."],
    },
    primary: "View the Mac source",
    secondary: "How it plays",
    hours: "Time of day",
    hour: { morning: "Dawn", day: "Day", evening: "Dusk", night: "Night" },
    scroll: "Scroll down",
  },
  parade: {
    title: "The helpers are off to work",
    text: "Seven little animals in four outfits. Every helper is a real coding agent on your machine: Claude Code, Codex, OpenCode, or the one VibeValley brings along.",
  },
  harvest: {
    title: ["Wake to a harvest,", "ripe and bright."],
    text: "Look over the commits, the diff, any clash in sight; bring it into main once it looks right.",
    card: {
      title: "Harvest",
      job: "clock-in: an endpoint listing check-ins",
      commits: "commits",
      files: "files",
      lines: "lines",
      clean: "no conflicts",
      take: "Bring it in",
    },
  },
  how: {
    title: "How a job grows",
    git: { branch: "vibevalley/issue-3", worktree: "its own worktree", commits: "commits", tests: "tests", merged: "into main" },
    steps: [
      {
        icon: "act-speaking_text",
        title: "Say it",
        text: 'Tell the assistant: "Add an endpoint to clock-in that lists check-ins, with tests." Type it, or hold the button and say it.',
      },
      {
        icon: "icon-seeds",
        title: "Sow it",
        text: "The assistant turns it into a ticket, picks a helper by its profile and gives it a branch and a worktree of its own in the project: seeds in an empty plot.",
      },
      {
        icon: "act-run_command",
        title: "Grow it",
        text: "The helper reads the code, edits files, runs the tests and commits. Its crop grows with its real progress: a sprout while it reads, leaves while it edits, wheat when it is done.",
      },
      {
        icon: "icon-harvest",
        title: "Harvest it",
        text: "You look over the harvest: the commits, the diff, whether it would conflict. It merges into main only when you say done; if it conflicts, the helper sorts it out.",
      },
    ],
  },
  features: {
    title: "What it does",
    tally: {
      views: "views: the workbench and the pixel farm",
      looks: "helpers: 7 animals × 4 outfits",
      plots: "plots at work at once, 3 per project by default",
      achievements: "achievements",
      games: "games on the farm phone",
      connectors: "chat apps to work from: WeChat, Feishu, QQ",
    },
    items: [
      {
        icon: "icon-board",
        title: "One line sends out a crew",
        text: "You only talk to the assistant, by typing or holding the button and speaking. It splits what you said into tickets, picks helpers by their profiles, opens branches and sends them off; each helper confirms, asks and reports in its job\u2019s thread in the farm chat, and you can step in any time.",
      },
      {
        icon: "icon-branch",
        title: "Several plots at once",
        text: "Up to 6 helpers work at once (3 per project by default), each on its own ticket\u2019s worktree and branch, out of each other\u2019s way. What cannot start yet queues, and starts as soon as a plot frees up.",
      },
      {
        icon: "icon-task-board",
        title: "You decide the harvest",
        text: "Finished work shows you its commits, its diff and whether it would conflict; it merges into main only when you say done. A long job is split into ordered sub-tickets; a bug fix starts with an acceptance test that fails, no later sub-ticket may touch it, and the last one has to make it pass.",
      },
      {
        icon: "icon-log",
        title: "Pick up where you left off",
        text: "Tickets keep a record of each work round. Reopen the workbench to read the last report, answer an outstanding question or inspect changes in the working directory.",
      },
      {
        icon: "icon-tasks",
        title: "A workbench and a farm",
        text: "The workbench works like Linear: a board, ticket details, and every step\u2019s trace, where you can comment on the very step that went wrong. The farm draws the same state: every project is an island, and every ticket in progress is a plot.",
      },
      {
        icon: "icon-pigeon",
        title: "Assign work in chat",
        text: "Give the assistant a ticket in farm chat and answer helpers in the ticket thread. Connect WeChat, Feishu or QQ to message the assistant from that chat service.",
      },
      {
        icon: "icon-clock",
        title: "Less to watch",
        text: '"Run the tests every day at nine." A round that calls no model reminds you of questions left unanswered, helpers gone quiet and harvests left in the field. Every machine has a quota and a daily budget; once it runs out, nothing more is sent.',
      },
      {
        icon: "icon-shed",
        title: "All on your machine",
        text: "The server listens on 127.0.0.1 only, and the data lives in your home folder (~/.vibevalley); the helpers\u2019 memory, profiles, notes and Artifacts stay on this machine.",
      },
    ],
  },
  runtimes: {
    title: "Your machines",
    text: "Helpers drive the coding agents installed and signed in on your machine, all through oar, with every quota and cost in sight. VibeValley brings one of its own too; all it needs is a DeepSeek key.",
    own: "VibeValley's own",
  },
  devices: {
    title: "Tend your farm on a Mac",
    text: "Each plot belongs to a ticket. Open a plot to read the helper's report, then switch to the workbench to review the files it changed.",
    note: "The workbench includes a terminal. Open the ticket's working directory to inspect the Git diff or run project checks in the same window.",
    shot: "The pixel farm and workbench navigation in the native Mac app",
  },
  screens: {
    title: "The farm",
    items: [
      { image: "native-farm", caption: "The farm on Mac: plots, helpers and the toolbar" },
      { image: "native-workbench", caption: "The workbench: tickets waiting, in progress, in review and done" },
      { image: "native-chat", caption: "Channels and farm chat in the Mac workbench" },
    ],
    open: "Open it large",
    close: "Close",
  },
  safety: {
    title: "Before you start",
    text: "Helpers run with no permission prompts and no sandbox: they can run any command on this machine. The server listens on 127.0.0.1 only; never expose it to a network. Put in the work folder only projects you are willing to hand to a coding agent.",
    wip: "The code is changing fast: its concepts, interfaces and saved data will all still move, and there will be bugs. Back up the farm\u2019s data before you upgrade, and tell us on GitHub when something breaks.",
  },
  start: {
    title: "Get started",
    needs: "You need",
    list: [
      "An Apple silicon Mac running macOS 14 or later",
      "To build: Xcode with Swift 6, Rust, Zig and Vite+ (vp)",
      "To use helpers: install and sign in to a coding agent such as Claude Code or Codex",
      "To use the built-in assistant: a DeepSeek API key",
    ],
    build: "Build the Mac app from source",
    more: "The app, DMG, update ZIP and release.json are written to apps/mac/dist.",
    readme: "Read the native README",
    copy: "Copy",
    copied: "Copied",
  },
  footer: {
    license: "Open source, Apache 2.0",
    font: "Pixel type: Fusion Pixel (SIL OFL)",
    top: "Back to top",
  },
  lost: {
    title: "Nothing grows here",
    text: "The page you were after is not on the farm: it may have moved, or it never was.",
    home: "Back to the farm",
  },
};
