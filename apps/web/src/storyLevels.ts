// Foundation first; a story's title starts with its level (src/stories.test.ts): 设计体系 tokens and icons, 组件 one
// part, 交互 parts working together, 界面 a feature's view on made-up data.
export const levels = ["设计体系", "组件", "交互", "界面"] as const;

/** Paths listed first at each depth, in this order (packages/stories, compareTitles). */
export const order: readonly string[] = [...levels, "设计体系/令牌", "设计体系/图标", "组件/工作台", "组件/像素"];
