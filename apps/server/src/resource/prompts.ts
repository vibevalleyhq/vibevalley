export const resourceWords = {
  description:
    "按 URI 分页读取完整资源。输入里只有摘要和 vv:// 指针时用；offset 是 UTF-16 字符偏移，第一页从 0 开始，后续照回答的 nextOffset 继续。同一会话从 offset 0 读到的动态内容会固定成快照。",
  uri: "要读取的 vv:// URI。",
  offset: "UTF-16 字符偏移；默认 0。",
  limit: "这一页最多返回多少字符；默认 4000，上限 16000。",
  invalidUri: (uri: string) => `不认识资源 URI：${uri}`,
  forbidden: (uri: string) => `这次会话没有权限读 ${uri}`,
  missing: (uri: string) => `没有找到资源：${uri}`,
  badOffset: "offset 不能小于 0。",
  snapshotMissing: "这一页的快照已经不在了；从 offset 0 重新读。",
  snapshotTooLarge: "这个资源超过单个会话快照的上限，不能稳定分页。",
} as const;
