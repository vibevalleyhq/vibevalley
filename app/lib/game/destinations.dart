import '../data/ui_state.dart' show FarmPanel;

// IDs match the LDtk resources; labels and navigation belong to the destination, not the renderer.
enum YardPlace {
  shop('shop', '商店', '种子、装饰、开垦新地', panel: FarmPanel.shop),
  warehouse('warehouse', '仓库', '收进来的成果', panel: FarmPanel.warehouse),
  graphs('tasks', '任务与成就', '新手任务、开垦、成就墙', panel: FarmPanel.graphs),
  log('log', '农场日志', '说过的话和收成，按时间倒着排', panel: FarmPanel.log),
  taskBoard('taskBoard', '种植计划', '一件长活拆成几步，交给几个帮工', panel: FarmPanel.taskBoard),
  agents('agents', '帮工名册', '每个帮工用哪台农机、带什么人设和技能、长什么样', route: '/agents'),
  manager('manager', '管家', '换管家的样子', panel: FarmPanel.manager),
  runtimes('runtimes', '工坊 · 农具', '每台农机是一种 runtime：装没装、用量', route: '/runtimes'),
  skills('skills', '书屋 · 技能书', '帮工能带的技能', route: '/skills');

  const YardPlace(this.id, this.label, this.hint, {this.panel, this.route});
  final String id;
  final String label;
  final String hint;
  final FarmPanel? panel;
  final String? route;
}
