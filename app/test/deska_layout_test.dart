// The deskA pages laid out narrow (a phone-wide window) and wide, with every tab open: nothing overflows.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/agents/agent_creator_page.dart';
import 'package:vibevalley/desk/agents/agents_page.dart';
import 'package:vibevalley/desk/manager/manager_page.dart';
import 'package:vibevalley/desk/skills/skills_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'deska_fakes.dart';

FakeServer _server() => FakeServer(
  agents: [
    agent('backend', '后端老周', role: '写接口、改 server、跑 Go 测试，名字和职责都很长很长很长', skills: ['s'], tags: ['后端', '接口', 'server', 'go', 'token']),
  ],
  skills: const [Skill(id: 's', name: '先写测试', description: '改行为之前，先补一个会失败的测试。', body: 'x')],
  runtimes: [
    runtime(
      'claude',
      models: const [
        ModelEntry(id: 'opus', name: 'Opus', effortLevels: ['low', 'medium', 'high'], isDefault: true),
      ],
      skills: const [InventoryEntry(name: 'pdf', description: '读写 PDF 文件的技能，说明很长很长很长很长很长很长', source: '~/.claude/skills/pdf')],
      tools: const [
        InventoryEntry(name: 'WebSearch'),
        InventoryEntry(name: 'Bash'),
      ],
    ),
  ],
  managerMemory: const ManagerMemory(runtime: Runtime.pi, file: '/m.md', memories: [], carried: 0),
);

void main() {
  for (final size in const [Size(420, 900), Size(800, 1000), Size(1280, 800)]) {
    testWidgets('at ${size.width.round()} wide the roster, every creator tab, the manager and the skills lay out', (t) async {
      final server = _server();
      await pumpPage(t, server, const AgentsPage(), size: size);
      expect(find.text('后端老周'), findsOneWidget);

      await pumpPage(t, server, const AgentCreatorPage(id: 'backend'), size: size);
      for (final tab in ['能力', '人设', '技能', '工具', '环境', '记性', '轨迹', '身份']) {
        await t.ensureVisible(find.text(tab).last);
        await t.tap(find.text(tab).last);
        await settle(t);
      }
      await pumpPage(t, server, const ManagerPage(), size: size);
      expect(find.textContaining('管家现在跑在 pi 上'), findsOneWidget);
      await pumpPage(t, server, const SkillsPage(id: 's'), size: size);
      expect(find.text('先写测试'), findsWidgets);
      await t.pumpWidget(const SizedBox());
    });
  }
}
