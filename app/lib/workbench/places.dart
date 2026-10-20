// The places the workbench can show, and where each lives.

enum Place {
  chat('聊天', '频道和串', 'icon-board', '/chat'),
  issues('工单', '每次种植的全过程', 'icon-tasks', '/issues'),
  docs('文档', '主人和帮工一起写的文档', 'icon-deed', '/docs'),
  agents('帮工', '帮工档案', 'raccoon-farmer-down', '/agents'),
  runtimes('农具', '机器上的编码 agent', 'machine-tractor', '/runtimes'),
  projects('项目', '每个项目一座岛', 'icon-map', '/projects'),
  catalog('图鉴', '素材：农场用的每张图、每个指针、每个声音', 'icon-log', '/catalog'),
  // Last, and drawn at the bottom of the bar (workbench_shell) rather than with the others.
  settings('设置', '钥匙、记性、连接器、技能、声音、连接到本机', 'icon-wrench', '/settings');

  const Place(this.label, this.hint, this.icon, this.path);
  final String label;
  final String hint;
  final String icon;
  final String path;

  static Place? of(String location) {
    if (location.startsWith('/manager')) return Place.agents;
    for (final p in values) {
      if (location == p.path || location.startsWith('${p.path}/')) return p;
    }
    return null;
  }
}
