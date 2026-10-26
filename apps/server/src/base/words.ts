// What the server says to the owner when it cannot start: its configuration, and its home taken by another server.

import { localized } from "@vibevalley/protocol/words";

const zh = {
  noFile: (path: string) => `${path}: 没有这个文件`,
  notPort: (path: string, name: string, port: number) => `${path}: ${name} 不是端口：${port}`,
  prPoll: "github.pr_poll_seconds 必须大于 0",
  homeTaken: (home: string) => `家目录 ${home} 正被另一个服务端使用；请连接现有的服务端，或先停掉它`,
  homeUnlocked: (home: string) => `锁不住家目录 ${home}`,
};

const en: typeof zh = {
  noFile: (path) => `${path}: no such file`,
  notPort: (path, name, port) => `${path}: ${name} is not a port: ${port}`,
  prPoll: "github.pr_poll_seconds must be above 0",
  homeTaken: (home) => `The home ${home} is used by another server: connect to that one, or stop it first`,
  homeUnlocked: (home) => `Could not lock the home ${home}`,
};

export const baseWording = localized({ zh, en });
