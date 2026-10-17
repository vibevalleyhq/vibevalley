import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/workbench/agents/agent_creator_page.dart';
import 'package:vibevalley/workbench/agents/agents_page.dart';
import 'package:vibevalley/workbench/runtimes/runtimes_page.dart';
import 'package:vibevalley/workbench/skills/skills_page.dart';

import '../support/workbench.dart';

void main() {
  final pages = <String, Widget>{
    'agents': const AgentsPage(),
    'agent editor': const AgentCreatorPage(id: 'helper'),
    'skills': const SkillsPage(),
    'runtimes': const RuntimesPage(id: 'claude'),
  };
  for (final entry in pages.entries) {
    testWidgets('${entry.key}: failed configuration can be retried on the page', (t) async {
      var failing = true;
      final backend = WorkbenchBackend(
        agents: [agent('helper', '恢复后的帮工')],
        runtimes: [runtime('claude')],
        skills: const [Skill(id: 'test', name: '恢复后的技能书', description: '', body: '')],
      );
      await pumpPage(t, entry.value, (request) async {
        if (failing && request.url.path == '/api/v1/agents') return jsonResponse({'reason': '连接暂时中断'}, 503);
        return backend.handle(request);
      });
      expect(find.text('配置没读到：连接暂时中断'), findsOneWidget);
      expect(find.text('读取配置…'), findsNothing);
      failing = false;
      await t.tap(find.text('重新读取配置'));
      await settle(t);
      expect(find.textContaining('配置没读到'), findsNothing);
      expect(find.text('重新读取配置'), findsNothing);
      expect(find.text('读取配置…'), findsNothing);
      switch (entry.key) {
        case 'agents':
        case 'agent editor':
          expect(find.text('恢复后的帮工'), findsWidgets);
        case 'skills':
          expect(find.text('恢复后的技能书'), findsWidgets);
        case 'runtimes':
          expect(find.text('Claude Code'), findsWidgets);
      }
    });
  }
}
