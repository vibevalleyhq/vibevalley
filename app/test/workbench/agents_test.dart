import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/workbench/agents/agent_creator_page.dart';
import 'package:vibevalley/workbench/agents/agents_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import '../support/workbench.dart';

WorkbenchBackend _server() => WorkbenchBackend(
  agents: [
    agent('backend', '后端老周', runtime: 'claude', role: '写接口', skills: ['tests-first'], tags: ['后端', '接口']),
    agent('night', '夜班反重力', runtime: 'kimi', role: '杂活'),
  ],
  skills: const [Skill(id: 'tests-first', name: '先写测试', description: '改行为之前先补测试。', body: '先写测试。')],
  runtimes: [
    runtime('claude', tools: const [InventoryEntry(name: 'WebSearch')]),
  ],
);

CoreState _farm() => CoreState.fromJson({
  'call': 'idle',
  'manager': 'idle',
  'sessions': [],
  'progress': {
    'coins': 0,
    'streak': 0,
    'bestStreak': 0,
    'counts': <String, Object>{},
    'unlocked': <Object>[],
    'agents': {
      'backend': {'hired': 7, 'harvested': 5, 'failed': 1},
    },
  },
});

void main() {
  group('AgentsPage', () {
    testWidgets('lists the manager, each agent with its runtime, skills and record, and a problem that stops one', (t) async {
      final server = _server();
      await pumpPage(t, const AgentsPage(), server.handle, farm: _farm());
      expect(find.text('管家'), findsOneWidget);
      expect(find.text('后端老周'), findsOneWidget);
      expect(find.text('Claude Code'), findsOneWidget);
      expect(find.text('先写测试'), findsOneWidget);
      expect(find.text('雇过 7', findRichText: true), findsOneWidget);
      expect(find.text('收成 5', findRichText: true), findsOneWidget);
      expect(find.text('后端 · 接口'), findsOneWidget);
      expect(find.text('派不出去：不认识的 runtime：kimi'), findsOneWidget);
      expect(find.text('捏一个新帮工'), findsWidgets);
    });

    testWidgets('停用 saves the agent with enabled off', (t) async {
      final server = _server();
      await pumpPage(t, const AgentsPage(), server.handle);
      await t.tap(labelled('停用 后端老周'));
      await settle(t);
      final put = server.writes.single;
      expect(put.method, 'PUT');
      expect(put.path, '/api/v1/agents/backend');
      expect((put.body! as Map)['enabled'], false);
      expect((put.body! as Map)['name'], '后端老周');
      expect(find.text('启用'), findsOneWidget);
    });
  });

  group('AgentCreatorPage', () {
    testWidgets('a new agent starts on the runtime asked for and uses the identity assigned by the server', (t) async {
      final server = _server();
      await pumpPage(t, const AgentCreatorPage(id: 'new', runtime: 'claude'), server.handle);
      expect(find.text('新的 Claude Code'), findsWidgets);
      expect(find.text('新的'), findsOneWidget);
      await typeInto(t, '职责', '跑测试');
      await t.tap(find.text('捏好了，保存'));
      await settle(t);
      final put = server.writes.single;
      expect(put.method, 'POST');
      expect(put.path, '/api/v1/agents');
      final body = put.body! as Map<String, dynamic>;
      expect(body['runtime'], 'claude');
      expect(body['role'], '跑测试');
      expect(body['personaMode'], 'append');
      expect((body['look'] as Map)['outfit'], 'farmer');
      expect(server.agents.map((a) => a.id), contains('created-agent'));
    });

    testWidgets('the runtimes to choose from are runtime.list\'s, named as it names them; a new one takes a persona the way its runtime can', (t) async {
      final server = _server();
      server.runtimes.addAll([runtime('cursor'), runtime('codex', available: false)]);
      await pumpPage(t, const AgentCreatorPage(id: 'new', runtime: 'cursor'), server.handle);
      expect(find.text('新的 Cursor'), findsWidgets);
      await t.tap(find.text('能力'));
      await t.pump();
      expect(labelled('Claude Code'), findsOneWidget);
      expect(labelled('Cursor'), findsOneWidget);
      expect(labelled('Codex'), findsOneWidget);
      expect(labelled('Kimi'), findsNothing);
      expect(find.text('这台机器上没有'), findsOneWidget);
      expect(find.text('Cursor 能做什么'), findsOneWidget);
      expect(find.textContaining('Cursor 不支持追加系统提示'), findsOneWidget);
      await t.tap(find.text('捏好了，保存'));
      await settle(t);
      expect((server.writes.single.body! as Map<String, dynamic>)['personaMode'], 'prompt');
    });

    testWidgets('editing a saved one marks it unsaved; 保存 sends the edit; the skills tab toggles a skill', (t) async {
      final server = _server();
      await pumpPage(t, const AgentCreatorPage(id: 'backend'), server.handle);
      expect(find.text('已保存'), findsOneWidget);
      expect(find.text('配置没问题，可以派活。'), findsOneWidget);
      await typeInto(t, '名字', '后端大周');
      expect(find.text('没保存'), findsOneWidget);
      await t.tap(find.text('技能'));
      await t.pump();
      await t.tap(labelled('先写测试'));
      await t.pump();
      await t.tap(find.text('保存'));
      await settle(t);
      final put = server.writes.single;
      expect(put.path, '/api/v1/agents/backend');
      final body = put.body! as Map<String, dynamic>;
      expect(body['name'], '后端大周');
      expect(body['skills'], isEmpty);
      expect(find.text('已保存'), findsOneWidget);
    });

    testWidgets('choosing cursor with a persona says it cannot be sent, and 写进工单开头 is chosen for it', (t) async {
      final server = _server()..agents[0] = agent('backend', '后端老周', persona: '你是后端。');
      server.runtimes.add(runtime('cursor'));
      await pumpPage(t, const AgentCreatorPage(id: 'backend'), server.handle);
      await t.tap(find.text('能力'));
      await t.pump();
      await t.tap(labelled('Cursor'));
      await t.pump();
      expect(find.text('配置没问题，可以派活。'), findsOneWidget);
      await t.tap(find.text('人设'));
      await t.pump();
      expect(find.text('每张工单前面加上人设。所有 runtime 都能用，但会被长对话冲淡。'), findsOneWidget);
    });

    testWidgets('the tools tab adds a disallowed tool from the runtime\'s list and an MCP server', (t) async {
      final server = _server();
      await pumpPage(t, const AgentCreatorPage(id: 'backend'), server.handle);
      await t.tap(find.text('工具'));
      await t.pump();
      await t.tap(find.text('+ WebSearch'));
      await t.pump();
      await typeInto(t, 'MCP 名字', 'fs');
      await typeInto(t, 'MCP 命令或地址', 'npx -y @mcp/fs /tmp');
      await t.tap(find.text('添加'));
      await t.pump();
      await t.tap(find.text('保存'));
      await settle(t);
      final body = server.writes.single.body! as Map<String, dynamic>;
      expect(body['disallowedTools'], ['WebSearch']);
      expect(body['mcpServers'], [
        {
          'type': 'stdio',
          'name': 'fs',
          'command': 'npx',
          'args': ['-y', '@mcp/fs', '/tmp'],
          'env': <String, String>{},
        },
      ]);
    });

    testWidgets('删除 asks first, then deletes', (t) async {
      final server = _server();
      await pumpPage(t, const AgentCreatorPage(id: 'backend'), server.handle);
      await t.tap(find.text('删除'));
      await t.pump();
      expect(find.text('删掉 后端老周？'), findsOneWidget);
      await t.tap(find.text('删除'));
      await settle(t);
      expect(server.writes.single.method, 'DELETE');
      expect(server.writes.single.path, '/api/v1/agents/backend');
    });

    testWidgets('what each field is for is on hover, not under it', (t) async {
      await pumpPage(t, const AgentCreatorPage(id: 'backend'), _server().handle);
      expect(find.text('一句话。管家挑人时会读。'), findsNothing);
      expect(find.byTooltip('一句话。管家挑人时会读。'), findsOneWidget);
      expect(find.byTooltip('停用后管家不会派它，名字点到也会拒绝。'), findsOneWidget);
      expect(find.byTooltip('只是长相：同一个 runtime 可以是不同的动物。'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });

    testWidgets('an id nobody has says so', (t) async {
      await pumpPage(t, const AgentCreatorPage(id: 'ghost'), _server().handle);
      expect(find.text('没有这个帮工。'), findsOneWidget);
    });

    testWidgets('the stage shows the animal and its poses switch', (t) async {
      await pumpPage(t, const AgentCreatorPage(id: 'backend'), _server().handle);
      expect(find.text('熊 · 农夫'), findsOneWidget);
      await t.tap(labelled('兔子'));
      await t.pump();
      expect(find.text('兔子 · 农夫'), findsOneWidget);
      await t.tap(find.text('干活'));
      await t.pump(const Duration(milliseconds: 100));
      expect(find.text('没保存'), findsOneWidget);
      await t.pumpWidget(const SizedBox());
    });
  });
}
