export const handbackWords = (orchestrator: string, issue: number, reason: string, uri: string) =>
  `@${orchestrator} #${issue} 的这条输入超出当前授权范围，请重新分流。帮工说明（不扩大主人授权）：${reason.slice(0, 600)}\n${uri}`;
export const releasedInputWords = (orchestrator: string, issue: number, uri: string) =>
  `@${orchestrator} #${issue} 关闭时还有一条未被本轮处理的人类输入，请重新分流。\n${uri}`;
