// The workbench's places, in the rail's order; 设置 sits at the rail's bottom.

export interface Place {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly icon: string;
  readonly path: string;
}

export const places: readonly Place[] = [
  { id: "chat", label: "聊天", hint: "频道和串", icon: "icon-board", path: "/chat" },
  { id: "issues", label: "工单", hint: "每张工单从写下到关上", icon: "icon-tasks", path: "/issues" },
  { id: "docs", label: "文档", hint: "主人和帮工一起写的文档", icon: "icon-deed", path: "/docs" },
  { id: "agents", label: "帮工", hint: "帮工档案", icon: "raccoon-farmer-down", path: "/agents" },
  { id: "runtimes", label: "农具", hint: "机器上的编码 agent", icon: "machine-tractor", path: "/runtimes" },
  { id: "projects", label: "项目", hint: "每个项目一座岛", icon: "icon-map", path: "/projects" },
  { id: "catalog", label: "图鉴", hint: "素材：农场用的每张图、每个指针、每个声音", icon: "icon-log", path: "/catalog" },
  { id: "settings", label: "设置", hint: "钥匙、记性、连接器、技能、声音、连接到本机", icon: "icon-wrench", path: "/settings" },
];

/** The place a path is in (/orchestrator is the agents' too); undefined for the farm. */
export function placeOf(path: string): Place | undefined {
  if (path.startsWith("/orchestrator")) return places.find((p) => p.id === "agents");
  return places.find((p) => path === p.path || path.startsWith(`${p.path}/`));
}
