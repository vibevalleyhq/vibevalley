import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/desk/runtimes/quota_panel.dart';
import 'package:vibevalley/desk/runtimes/runtime_facts.dart';
import 'package:vibevalley/desk/runtimes/runtimes_page.dart';
import 'package:vibevalley/gen/vibevalley.dart';

import 'deskb_support.dart';
import 'package:vibevalley/rules/index.dart';
import 'package:vibevalley/rules/quota.dart';
import 'package:vibevalley/rules/seeds.dart';

FakeBackend backend() {
  Object? saved;
  final b = FakeBackend({
    'GET /api/runtimes': (_) => [
      runtimeJson(
        'claude',
        usage: {
          'status': 'ok',
          'plan': 'Max',
          'windows': [
            {'label': 'Current session', 'usedPercent': 30},
            {'label': 'Current week (all models)', 'usedPercent': 90, 'resetsAt': DateTime(2026, 10, 20).millisecondsSinceEpoch},
          ],
        },
        update: {'current': '1.2.3', 'latest': '1.3.0', 'available': true},
        models: [
          {
            'id': 'opus',
            'name': 'Opus',
            'effortLevels': ['low', 'high'],
            'isDefault': true,
          },
        ],
      )..addAll({'settings': ?saved}),
      runtimeJson('pi', spentToday: 1.5, dailyBudget: 5),
    ],
    'GET /api/agents': (_) => [agentJson('a1', '阿郑', 'claude')],
    'GET /api/skills': (_) => <Object>[],
    'POST /api/runtimes/claude/refresh': (_) => runtimeJson('claude', update: {'current': '1.2.3', 'latest': '1.3.0', 'available': true}),
    'PUT /api/runtimes/claude/settings': (c) => {...runtimeJson('claude'), 'settings': saved = c.body},
  });
  return b;
}

void main() {
  group('protocol rules', () {
    test('yuan', () {
      expect(yuan(0), '¥0.00');
      expect(yuan(0.004), '不到 ¥0.01');
      expect(yuan(12.345), '¥12.35');
    });

    test('moneyStop: a used-up window, an empty balance, a spent budget', () {
      final full = RuntimeInfo.fromJson(
        runtimeJson(
          'codex',
          usage: {
            'status': 'ok',
            'windows': [
              {'label': '5h', 'usedPercent': 100},
            ],
          },
        ),
      );
      expect(moneyStop(full), 'Codex 的额度用完了（5h），到时候再派');
      final broke = RuntimeInfo.fromJson(
        runtimeJson(
          'pi',
          usage: {
            'status': 'balance',
            'provider': 'DeepSeek',
            'available': false,
            'balances': [
              {'currency': 'CNY', 'amount': 0},
            ],
          },
        ),
      );
      expect(moneyStop(broke), 'DeepSeek 的余额用完了，充值以后再派');
      final spent = RuntimeInfo.fromJson(runtimeJson('pi', spentToday: 6, dailyBudget: 5));
      expect(moneyStop(spent), '今天已经花了 ¥6.00，到了每日预算 ¥5.00（在 Runtime 页面可以改）');
      expect(moneyStop(RuntimeInfo.fromJson(runtimeJson('pi'))), isNull);
    });

    test('capabilities and presets', () {
      expect(capabilitiesOf('claude'), Capability.values);
      expect(capabilitiesOf('pi'), [Capability.listModels, Capability.skills, Capability.tools]);
      expect(capabilitiesOf('nope'), isEmpty);
      expect(runtimeName('claude'), 'Claude Code');
      expect(runtimeName('mystery'), 'mystery');
    });

    test('resetText', () {
      final now = DateTime(2026, 10, 14, 12);
      expect(resetText(now.millisecondsSinceEpoch - 1.0, now: now), '马上重置');
      expect(resetText(now.add(const Duration(minutes: 20)).millisecondsSinceEpoch.toDouble(), now: now), '20 分钟后重置');
      expect(resetText(now.add(const Duration(hours: 3)).millisecondsSinceEpoch.toDouble(), now: now), '3 小时后重置');
      expect(resetText(DateTime(2026, 10, 16, 12).millisecondsSinceEpoch.toDouble(), now: now), '周五重置');
    });
  });

  testWidgets('lists every runtime and shows the selected one', (t) async {
    final b = backend();
    await pumpPage(t, const RuntimesPage(), b);
    expect(find.text('农具 Runtime', findRichText: true), findsOneWidget);
    for (final p in runtimePresets) {
      expect(find.text(p.label), findsWidgets);
    }
    expect(find.text('1.2.3 · 1 个 agent'), findsOneWidget);
    expect(find.text('没找到'), findsWidgets);
    expect(find.text('Anthropic 的命令行编码 agent。'), findsOneWidget);
    expect(find.text('套餐：Max'), findsOneWidget);
    expect(find.text('剩 70%'), findsOneWidget);
    expect(find.text('本周（全部模型）'), findsOneWidget);
    expect(find.text('opus'), findsOneWidget);
    expect(find.text('low · high'), findsOneWidget);
    expect(find.text('升级到 1.3.0'), findsOneWidget);
    // The detail scrolls on its own: drag from inside it.
    await t.drag(find.text('opus'), const Offset(0, -3000));
    await t.pump();
    expect(find.text('review'), findsOneWidget);
    expect(find.text('阿郑'), findsOneWidget);
  });

  testWidgets('重新检测 asks the server and the upgrade asks first', (t) async {
    final b = backend();
    await pumpPage(t, const RuntimesPage(id: 'claude'), b);
    await t.tap(find.text('重新检测'));
    await settle(t);
    expect(b.named('POST', '/api/runtimes/claude/refresh'), hasLength(1));
    await t.tap(find.text('升级到 1.3.0'));
    await t.pump();
    expect(find.text('会跑 Claude Code 自己的更新程序，改动这台机器。'), findsOneWidget);
    await t.tap(find.text('算了'));
    await t.pump();
    expect(find.text('升级到 1.3.0'), findsOneWidget);
  });

  testWidgets('settings: a change shows 保存, which sends the draft', (t) async {
    final b = backend();
    await pumpPage(t, const RuntimesPage(id: 'claude'), b);
    expect(find.text('保存'), findsNothing);
    await t.enterText(find.bySemanticsLabel('命令路径').last, '/opt/claude');
    await t.pump();
    expect(find.text('保存'), findsOneWidget);
    await t.tap(find.text('保存'));
    await settle(t);
    final put = b.named('PUT', '/api/runtimes/claude/settings');
    expect(put, hasLength(1));
    expect((put.single.body! as Map)['binPath'], '/opt/claude');
    expect(find.text('保存'), findsNothing);
  });

  testWidgets('a runtime pushed by the server replaces the one shown', (t) async {
    final events = StreamController<SiteEvent>();
    addTearDown(events.close);
    await pumpPage(t, const RuntimesPage(id: 'claude'), backend(), events: events.stream);
    expect(find.text('1.2.3 · 1 个 agent'), findsOneWidget);
    final next = runtimeJson('claude');
    (next['installation'] as Map)['version'] = '2.0.0';
    events.add(SiteEventRuntime(at: 0, info: RuntimeInfo.fromJson(next)));
    await settle(t);
    expect(find.text('2.0.0 · 1 个 agent'), findsOneWidget);
  });

  testWidgets('pi shows its daily budget and spending', (t) async {
    await pumpPage(t, const RuntimesPage(id: 'pi'), backend());
    expect(find.text('每日预算（元）'), findsOneWidget);
    expect(find.textContaining('今天已经花了 ¥1.50'), findsOneWidget);
  });

  testWidgets('the quota panel lists the usable runtimes', (t) async {
    await pumpPage(t, const Center(child: QuotaPanel()), backend());
    expect(find.text('剩余额度'), findsOneWidget);
    expect(find.text('Claude Code'), findsOneWidget);
    expect(find.text('Pi'), findsOneWidget);
    expect(find.text('今天花了约 ¥1.50 / 预算 ¥5.00'), findsOneWidget);
  });
}
