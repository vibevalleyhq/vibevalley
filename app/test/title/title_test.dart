import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/data/providers.dart';
import 'package:vibevalley/data/server.dart';
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/workbench/settings/settings_form.dart';
import 'package:vibevalley/shell/app_frame.dart';
import 'package:vibevalley/title/startup.dart';
import 'package:vibevalley/data/ui_state.dart';
import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

import '../support/shell.dart';

void main() {
  late FakeServer server;
  late ProviderContainer container;
  Map<String, dynamic> settings = settingsJson();

  setUp(() {
    settings = settingsJson();
    server = FakeServer((r) async {
      if (r.url.path == '/api/v1/settings' && r.method == 'GET') return jsonResponse(settings);
      if (r.url.path == '/api/v1/settings' && r.method == 'PUT') return jsonResponse(settings);
      return http.Response('', 204);
    });
    container = ProviderContainer(overrides: shellOverrides(server));
  });
  tearDown(() => container.dispose());

  Future<void> open(WidgetTester tester, {bool onFarm = true}) async {
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          home: AppFrame(onFarm: () => onFarm, startup: false, child: const Text('农场')),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 600));
  }

  /// The settings form by itself, as the workbench's 设置 shows it (every part).
  Future<void> openForm(WidgetTester tester) async {
    tester.view.physicalSize = const Size(1280, 1600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: const MaterialApp(
          home: Scaffold(body: SingleChildScrollView(child: SettingsForm())),
        ),
      ),
    );
  }

  Future<void> loadSettings(WidgetTester tester) async {
    await tester.runAsync(() => container.read(settingsProvider.notifier).load());
    await tester.pump();
  }

  void farmWith({double coins = 0}) {
    server.frameFeed.add(
      ReceivedFrame(
        StateFrame(
          state: farmState(coins: coins),
          inbox: const [],
          graphs: const [],
          view: const FarmView(level: FarmLevel(level: 1, xp: 0, need: 10), plots: {}, achievements: []),
          effects: const [],
        ),
        bytes: 0,
        decodeMicros: 0,
      ),
    );
  }

  testWidgets('the title screen comes over the farm with its menu; 继续游戏 waits for a farm', (tester) async {
    await open(tester);
    expect(find.text('码农场物语'), findsOneWidget);
    expect(find.text('一群写代码的小动物，等你来派活'), findsOneWidget);
    expect(find.text('开始游戏'), findsOneWidget);
    expect(find.text('继续游戏'), findsOneWidget);
    expect(find.text('设置'), findsOneWidget);
    expect(find.text('还没有农场可以继续：先开始游戏。'), findsOneWidget);
    await tester.tap(find.text('继续游戏'));
    await tester.pump();
    expect(container.read(titleOpenProvider), isTrue);
    await unmount(tester);
  });

  testWidgets('开始游戏 without DeepSeek\'s key goes to 设置 for it; with one it goes in and starts the day', (tester) async {
    await open(tester);
    await loadSettings(tester);
    await tester.tap(find.text('开始游戏'));
    await tester.pump();
    expect(container.read(leaveForProvider), '/settings/deepseek');
    expect(container.read(titleOpenProvider), isFalse);
    expect(server.requests.where((r) => r.url.path == '/api/v1/manager/open'), isEmpty);

    container.read(leaveForProvider.notifier).set(null);
    container.read(titleOpenProvider.notifier).show();
    await tester.pump(const Duration(milliseconds: 600));
    settings = settingsJson(deepseek: 'config');
    await loadSettings(tester);
    await tester.tap(find.text('开始游戏'));
    await tester.pump();
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    expect(container.read(titleOpenProvider), isFalse);
    expect(find.text('开始游戏'), findsNothing);
    expect(server.requests.map((r) => '${r.method} ${r.url.path}'), contains('POST /api/v1/manager/open'));
    // The 先填钥匙 toast goes away on its own timer.
    await tester.pump(const Duration(seconds: 10));
    await unmount(tester);
  });

  testWidgets('继续游戏 is picked when there is a farm; Enter goes back to it without starting the day', (tester) async {
    await open(tester);
    farmWith(coins: 30);
    await tester.pump();
    expect(find.text('还没有农场可以继续：先开始游戏。'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(container.read(titleOpenProvider), isFalse);
    expect(server.requests.where((r) => r.url.path == '/api/v1/manager/open'), isEmpty);
    await unmount(tester);
  });

  testWidgets('the arrow keys move between what can be chosen; 设置 goes to the workbench\'s 设置', (tester) async {
    await open(tester);
    await loadSettings(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(container.read(leaveForProvider), '/settings');
    expect(container.read(titleOpenProvider), isFalse);
    await unmount(tester);
  });

  testWidgets('the settings form saves a typed key and says so', (tester) async {
    settings = settingsJson(deepseek: 'settings');
    await openForm(tester);
    await loadSettings(tester);
    expect(find.text('在用 sk-…abcd（存在设置里）'), findsOneWidget);
    expect(find.text('清掉'), findsOneWidget);
    await tester.enterText(find.byType(TextField).first, 'sk-new');
    await tester.tap(find.text('保存'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
    final put = server.requests.lastWhere((r) => r.method == 'PUT');
    expect(jsonDecode(put.body), {'deepseekApiKey': 'sk-new'});
    expect(find.text('存好了，马上就用上。'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('a key kept in settings can be cleared: it goes as nothing', (tester) async {
    settings = settingsJson(deepseek: 'settings');
    await openForm(tester);
    await loadSettings(tester);
    await tester.tap(find.text('清掉'));
    await tester.pump();
    expect(find.text('存的时候清掉'), findsOneWidget);
    await tester.tap(find.text('保存'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
    expect(jsonDecode(server.requests.lastWhere((r) => r.method == 'PUT').body), {'deepseekApiKey': ''});
    await unmount(tester);
  });

  testWidgets('the settings form connects Nowledge Mem as a memory source', (tester) async {
    await openForm(tester);
    await loadSettings(tester);
    expect(find.text('记性的来源：Nowledge Mem（没接）'), findsOneWidget);
    await tester.tap(find.text('改').first);
    await tester.pump();
    await tester.enterText(find.bySemanticsLabel('Nowledge Mem 的地址'), 'http://127.0.0.1:14242/mcp/');
    await tester.tap(find.text('接上'));
    await tester.pump();
    await tester.ensureVisible(find.text('保存'));
    await tester.pump();
    await tester.tap(find.text('保存'));
    await tester.runAsync(() => Future<void>.delayed(const Duration(milliseconds: 10)));
    await tester.pump();
    expect(jsonDecode(server.requests.lastWhere((r) => r.method == 'PUT').body), {
      'memorySources': [
        {'kind': 'nowledge', 'url': 'http://127.0.0.1:14242/mcp/', 'enabled': true, 'read': true, 'write': true},
      ],
    });
    await unmount(tester);
  });

  test('the title screen is for the first opening: once the farm was entered, later openings go straight to it', () async {
    SharedPreferences.setMockInitialValues({});
    final first = ProviderContainer(overrides: [serverProvider.overrideWithValue(VibeValleyServer(Uri.parse('http://farm.test')))]);
    addTearDown(first.dispose);
    expect(first.read(titleOpenProvider), isTrue);
    await Future<void>.delayed(Duration.zero);
    expect(first.read(titleOpenProvider), isTrue);
    first.read(titleOpenProvider.notifier).enterFarm(start: false);
    await Future<void>.delayed(Duration.zero);
    final later = ProviderContainer(overrides: [serverProvider.overrideWithValue(VibeValleyServer(Uri.parse('http://farm.test')))]);
    addTearDown(later.dispose);
    later.read(titleOpenProvider);
    await Future<void>.delayed(Duration.zero);
    expect(later.read(titleOpenProvider), isFalse);
  });

  testWidgets('the workbench goes without the title screen', (tester) async {
    await open(tester, onFarm: false);
    expect(find.text('开始游戏'), findsNothing);
    expect(find.text('农场'), findsOneWidget);
    await unmount(tester);
  });

  testWidgets('` opens and closes the debug console', (tester) async {
    await open(tester, onFarm: false);
    expect(find.text('调试台'), findsNothing);
    await tester.sendKeyEvent(LogicalKeyboardKey.backquote);
    await tester.pump();
    expect(find.text('调试台'), findsOneWidget);
    expect(find.text('开工'), findsOneWidget);
    await tester.sendKeyEvent(LogicalKeyboardKey.backquote);
    await tester.pump();
    expect(find.text('调试台'), findsNothing);
    await unmount(tester);
  });

  testWidgets('the loading bar: the step under way, how far, each step ticked or not', (tester) async {
    const loading = Loading([
      (label: '连上农场（服务端没答应，在重试）', done: false),
      (label: '读钥匙', done: true),
      (label: '字体', done: true),
      (label: '画首页', done: true),
      (label: '像素村', done: false),
    ], gaveUp: false);
    expect(loading.fraction, 0.6);
    expect(loading.finished, isFalse);
    expect(const Loading([(label: 'a', done: false)], gaveUp: true).finished, isTrue);
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: Center(child: LoadingBar(loading: loading)),
        ),
      ),
    );
    expect(find.text('连上农场（服务端没答应，在重试）…'), findsOneWidget);
    expect(find.text('60%'), findsOneWidget);
    expect(find.text('连上农场'), findsOneWidget);
    expect(find.text('像素村'), findsOneWidget);
  });
}
