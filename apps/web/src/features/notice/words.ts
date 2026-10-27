import { localized } from "@vibevalley/protocol/words";

const zh = {
  tray: {
    working: (n: number) => `${n} 个帮工在干活`,
    idle: "开工了，没有在干的活",
    off: "还没开工",
    unread: (n: number) => `田头 ${n} 条没读`,
  },
};

const en: typeof zh = {
  tray: {
    working: (n) => (n === 1 ? "1 helper working" : `${n} helpers working`),
    idle: "Open, nothing being worked on",
    off: "Not open yet",
    unread: (n) => `${n} unread in the farm chat`,
  },
};

export const noticeWording = localized({ zh, en });
