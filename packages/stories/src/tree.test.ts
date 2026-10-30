import { expect, test } from "vite-plus/test";
import type { Stories } from "./format";
import { ancestors, compareTitles, entries, isOpen, treeOf, type Node } from "./tree";

const file = (title: string, ...names: string[]): Stories => ({
  title,
  stories: Object.fromEntries(names.map((n) => [n, { render: () => null }])),
});

const order = ["设计体系", "组件", "交互", "界面", "组件/工作台", "组件/像素"];

test("titles go level by level, as ordered, the rest by name", () => {
  const titles = ["界面/工单/看板", "组件/像素/PxButton", "设计体系/令牌", "组件/工作台/Tag", "组件/工单/StatusMark", "组件/工作台/Button", "其他"];
  expect([...titles].toSorted(compareTitles(order))).toEqual([
    "设计体系/令牌",
    "组件/工作台/Button",
    "组件/工作台/Tag",
    "组件/像素/PxButton",
    "组件/工单/StatusMark",
    "界面/工单/看板",
    "其他",
  ]);
});

test("a file of one story is the story; a file of several is a folder of them", () => {
  const list = entries([file("组件/工作台/Button", "Playground", "Tones"), file("设计体系/图标", "All")], order);
  const shape = (nodes: Node[]): unknown[] => nodes.map((n) => (n.kind === "folder" ? { [n.name]: shape(n.children) } : `${n.name} (${n.entry.key})`));
  expect(shape(treeOf(list))).toEqual([
    { 设计体系: ["图标 (设计体系/图标:All)"] },
    { 组件: [{ 工作台: [{ Button: ["Playground (组件/工作台/Button:Playground)", "Tones (组件/工作台/Button:Tones)"] }] }] },
  ]);
});

test("two files with one title is a mistake", () => {
  expect(() => entries([file("组件/A", "x"), file("组件/A", "y")])).toThrow();
});

test("the levels and the open story's folders are open, unless toggled by hand", () => {
  expect(ancestors("组件/工作台/Button")).toEqual(["组件", "组件/工作台", "组件/工作台/Button"]);
  const none = new Map<string, boolean>();
  expect(isOpen("组件", 0, undefined, none)).toBe(true);
  expect(isOpen("组件/像素", 1, "组件/工作台/Button", none)).toBe(false);
  expect(isOpen("组件/工作台", 1, "组件/工作台/Button", none)).toBe(true);
  expect(isOpen("组件", 0, undefined, new Map([["组件", false]]))).toBe(false);
});
