// The page's words in English (at /en/), the same shape as zh.ts.

import type { Copy } from './zh'

export const en: Copy = {
  lang: 'en',
  home: '/en/',
  other: { label: '中文', href: '/', name: '中文' },
  title: 'VibeValley · 码农场物语',
  description:
    'A team of coding agents you direct by voice or chat, drawn as a pixel farm. The manager hands out the work, the helpers write and test the code in your projects, and you harvest what they grew. Runs on your own machine. Open source.',
  nav: { how: 'How it plays', features: 'What it does', screens: 'The farm', start: 'Get started', github: 'GitHub' },
  hero: {
    name: 'VibeValley',
    aka: '码农场物语',
    tagline: 'Coding, like harvest time.',
    lead: 'A crew of coding agents on a pixel farm, writing your code and running your tests.',
    // A day on the farm, a line for each hour as the page goes down, rhyming in pairs.
    verses: {
      morning: ['Say one line', 'at break of day;'],
      day: ['the helpers sow', 'and weed away.'],
      evening: ['At dusk, reports', 'come in by rows;'],
      night: ['you sleep, and still', 'the garden grows.'],
    },
    primary: 'See it on GitHub',
    secondary: 'How it plays',
    hours: 'Time of day',
    hour: { morning: 'Dawn', day: 'Day', evening: 'Dusk', night: 'Night' },
    scroll: 'Scroll down',
  },
  parade: {
    title: 'The helpers are off to work',
    text: 'Seven little animals in four outfits. Every helper is a real coding agent on your machine: pi, Claude Code, Codex, or the one VibeValley brings along.',
  },
  harvest: {
    title: ['Wake to a harvest,', 'ripe and bright.'],
    text: 'Look over the commits, the diff, any clash in sight; bring it into main once it looks right.',
    card: { title: 'Harvest', job: 'clock-in: an endpoint listing check-ins', commits: 'commits', files: 'files', lines: 'lines', clean: 'no conflicts', take: 'Bring it in' },
  },
  how: {
    title: 'How a job grows',
    git: { branch: 'vibevalley/w3-mgr2k', worktree: 'its own worktree', commits: 'commits', tests: 'tests', merged: 'into main' },
    steps: [
      { icon: 'act-speaking_text', title: 'Say it', text: 'Tell the manager: "Add an endpoint to clock-in that lists check-ins, with tests." Type it, or hold the button and say it.' },
      { icon: 'icon-seeds', title: 'Sow it', text: 'The manager picks a helper that fits and gives it a branch and a worktree of its own in the project: seeds in an empty plot.' },
      { icon: 'act-run_command', title: 'Grow it', text: 'The helper reads the code, edits files, runs the tests and commits. Its crop grows with its real progress: a sprout while it reads, leaves while it edits, wheat when it is done.' },
      { icon: 'icon-harvest', title: 'Harvest it', text: 'You look over the harvest: the commits, the diff, whether it would conflict. Only then does it merge into main; if it conflicts, the helper sorts it out.' },
    ],
  },
  features: {
    title: 'What it does',
    tally: {
      machines: "machines: VibeValley's own, pi, Claude Code, Codex",
      looks: 'helpers: 7 animals × 4 outfits',
      plots: 'plots at work at once',
      achievements: 'achievements',
      games: 'games on the farm phone',
      connectors: 'chat apps to work from: WeChat, Feishu, QQ',
    },
    items: [
      { icon: 'icon-board', title: 'One chat for the farm', text: 'You, the manager and the helpers talk in one chat. Every job gets its own thread, where the helper confirms, asks and reports, and you can step in any time. Channels keep projects apart.' },
      { icon: 'icon-plan', title: 'Planting plans', text: 'A long job is first split into a graph of steps, and you look over the draft before work starts. A bug fix starts with an acceptance test that fails, and no later step may touch it.' },
      { icon: 'button-mic', title: 'Talk, and it is done', text: 'Hold the button and talk: the voice manager hears you out and hands your words to the same manager, who sends the work off.' },
      { icon: 'icon-tasks', title: 'A ticket board', text: 'Every planting is a ticket: to do, in progress, waiting for you, closed. When every plot is busy, tickets queue and start as soon as one frees up.' },
      { icon: 'icon-clock', title: 'Schedules and rounds', text: '"Run the tests every day at nine." A round that calls no model reminds you of questions left unanswered, helpers gone quiet and harvests left in the field.' },
      { icon: 'icon-pigeon', title: 'Work from anywhere', text: 'Connect the farm chat to WeChat, Feishu or QQ; only your own account gets in. A phone or another computer can come in through the yard gate.' },
      { icon: 'icon-coin', title: 'Spending in sight', text: 'Every machine’s quota, what today cost, a daily budget. You are warned before a quota runs out, and nothing is sent once it has.' },
      { icon: 'icon-trophy', title: 'And a farm', text: 'Day and night with real light, a dog, helpers walking the paths, achievements and titles, and a phone with little games on it.' },
    ],
  },
  runtimes: {
    title: 'Your machines',
    text: 'Helpers drive the coding agents installed and signed in on your machine, with every quota and cost in sight. VibeValley brings one of its own too; all it needs is a DeepSeek key.',
    own: "VibeValley's own",
  },
  devices: {
    title: 'Your farm on every screen',
    text: 'The app is written in Flutter, so the Mac, the iPhone and Android get the same one. The farm runs on your Mac; VibeValley on your phone scans the yard gate\u2019s QR code and joins the same farm: hand out work in the farm chat, follow the tickets, read the helpers\u2019 reports. Another Mac joins with a pairing link. Away from home, connect the farm chat to WeChat, Feishu or QQ.',
    platforms: ['macOS', 'iPhone', 'Android'],
    note: 'For now you build the phone app yourself, from the same source. Open the yard gate only on a network you trust.',
    shots: { mac: 'The farm on a Mac', chat: 'The farm chat on a phone', tickets: 'The tickets on a phone' },
  },
  screens: {
    title: 'The farm',
    items: [
      { image: 'farm', caption: 'The farm: the plots, the manager, and the farm chat at the bottom right' },
      { image: 'title', caption: 'The title screen: day and night follow your clock' },
      { image: 'chat', caption: 'The chat page: channels, helpers, and a job\u2019s thread open on the right' },
    ],
    open: 'Open it large',
    close: 'Close',
  },
  safety: {
    title: 'Before you start',
    text: 'Helpers run with no permission prompts and no sandbox: they can run any command on this machine. The server listens on 127.0.0.1 only; never expose it to a network. Put in the work folder only projects you are willing to hand to a coding agent.',
  },
  start: {
    title: 'Get started',
    needs: 'You need',
    list: [
      'macOS on Apple silicon',
      'At least one coding agent installed and signed in: pi, Claude Code or Codex',
      'A DeepSeek API key, for the manager',
      'To build it yourself: Go 1.27, Flutter 3.47 and Xcode',
    ],
    build: 'Build the macOS app',
    more: 'More in the README and docs/ in the repository.',
    readme: 'Read the README',
    copy: 'Copy',
    copied: 'Copied',
  },
  footer: {
    license: 'Open source, Apache 2.0',
    font: 'Pixel type: Fusion Pixel (SIL OFL)',
    top: 'Back to top',
  },
  lost: {
    title: 'Nothing grows here',
    text: 'The page you were after is not on the farm: it may have moved, or it never was.',
    home: 'Back to the farm',
  },
}
