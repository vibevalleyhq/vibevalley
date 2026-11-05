export const levels = ["设计体系", "组件", "交互", "界面"] as const;

/** Paths listed first at each depth, in this order (packages/stories, compareTitles). */
export const order: readonly string[] = [...levels, "设计体系/令牌", "设计体系/图标", "组件/工作台", "组件/像素"];
