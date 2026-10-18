import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/workbench/skills/skills_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import '../support/workbench.dart';

WorkbenchBackend _server() => WorkbenchBackend(
  agents: [
    agent('backend', '后端老周', skills: ['tests-first']),
  ],
  skills: const [
    Skill(id: 'tests-first', name: '先写测试', description: '改行为之前，先补一个会失败的测试。', body: '先写一个能复现问题的测试。'),
    Skill(id: 'small-diffs', name: '小步提交', description: '一次只改一件事。', body: '拆成小步。'),
  ],
  runtimes: [
    runtime(
      'claude',
      skills: const [InventoryEntry(name: 'pdf', description: '读写 PDF', source: '~/.claude/skills/pdf')],
    ),
    runtime(
      'pi',
      skills: const [InventoryEntry(name: 'pdf', source: '~/.pi/skills/pdf')],
    ),
  ],
);

void main() {
  testWidgets('opens on the first installed skill, read-only, with the runtimes that load it', (t) async {
    await pumpPage(t, const SkillsPage(), _server().handle);
    expect(find.text('这台电脑上装的 · 1'), findsOneWidget);
    expect(find.text('VibeValley 自己的 · 2'), findsOneWidget);
    expect(find.text('pdf'), findsWidgets);
    expect(find.text('Claude Code、Pi'), findsOneWidget);
    expect(find.text('读写 PDF'), findsWidgets);
    expect(find.text('~/.pi/skills/pdf'), findsOneWidget);
    expect(find.text('保存'), findsNothing);
  });

  testWidgets('the search narrows both lists', (t) async {
    await pumpPage(t, const SkillsPage(), _server().handle);
    await typeInto(t, '搜索技能', '小步');
    expect(find.text('这台电脑上装的 · 0 / 1'), findsOneWidget);
    expect(find.text('VibeValley 自己的 · 1 / 2'), findsOneWidget);
    expect(find.text('没有对得上的。'), findsOneWidget);
  });

  testWidgets('a library skill is edited and saved under its id; who uses it is listed', (t) async {
    final server = _server();
    await pumpPage(t, const SkillsPage(id: 'tests-first'), server.handle);
    expect(find.text('后端老周'), findsOneWidget);
    await typeInto(t, '正文', '先写测试，再改代码。');
    await t.tap(find.text('保存'));
    await settle(t);
    final put = server.writes.single;
    expect(put.method, 'PUT');
    expect(put.path, '/api/v1/skills/tests-first');
    expect(put.body, {'id': 'tests-first', 'name': '先写测试', 'description': '改行为之前，先补一个会失败的测试。', 'body': '先写测试，再改代码。'});
  });

  testWidgets('a new skill gets its identity from the server', (t) async {
    final server = _server();
    await pumpPage(t, const SkillsPage(id: 'new'), server.handle);
    expect(find.text('新技能'), findsWidgets);
    await typeInto(t, '技能名字', 'Go Style');
    await typeInto(t, '正文', '表驱动测试。');
    await t.tap(find.text('保存'));
    await settle(t);
    expect(server.writes.single.method, 'POST');
    expect(server.writes.single.path, '/api/v1/skills');
    expect((server.writes.single.body! as Map)['id'], '');
    expect((server.writes.single.body! as Map)['name'], 'Go Style');
  });

  testWidgets('删除 says who uses it, then deletes', (t) async {
    final server = _server();
    await pumpPage(t, const SkillsPage(id: 'tests-first'), server.handle);
    await t.tap(find.text('删除'));
    await t.pump();
    expect(find.text('1 个 agent 在用，删掉会从它们身上去掉。'), findsOneWidget);
    await t.tap(find.text('删除'));
    await settle(t);
    expect(server.writes.single.method, 'DELETE');
    expect(server.writes.single.path, '/api/v1/skills/tests-first');
  });
}
