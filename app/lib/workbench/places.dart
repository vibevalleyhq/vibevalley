// The places the workbench can show, and where each lives.

enum Place {
  chat('聊天', '频道和串', 'icon-board', '/chat'),
  issues('工单', '每次种植的全过程', 'icon-tasks', '/issues'),
  map('地图', '每个项目一座岛', 'icon-map', '/map'),
  agents('帮工', 'Agent', 'raccoon-farmer-down', '/agents'),
  runtimes('农具', 'Runtime', 'machine-tractor', '/runtimes'),
  skills('技能书', '技能', 'icon-skillbook', '/skills'),
  connectors('连接器', '微信 飞书 QQ', 'icon-pigeon', '/connectors'),
  projects('项目', '代码库', 'icon-deed', '/projects'),
  voice('声音', 'Agora 语音', 'act-speaking_text', '/voice'),
  gate('院门', '手机和别的电脑', 'icon-shed', '/gate'),
  catalog('图鉴', '素材', 'icon-log', '/catalog');

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
