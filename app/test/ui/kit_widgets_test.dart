import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/server.dart' show atlas;
import 'package:vibevalley/gen/vibevalley.dart';
import 'package:vibevalley/sprites/atlas.dart';
import 'package:vibevalley/ui/pixel/pixel.dart';

Widget host(Widget child) => MaterialApp(
  theme: farmTheme(),
  home: Scaffold(
    body: Center(child: SizedBox(width: 400, child: child)),
  ),
);

class Live extends StatefulWidget {
  const Live(this.build, {super.key});
  final Widget Function(StateSetter set) build;

  @override
  State<Live> createState() => _LiveState();
}

class _LiveState extends State<Live> {
  @override
  Widget build(BuildContext context) => widget.build(setState);
}

void main() {
  group('PxButton', () {
    testWidgets('renders its label and calls back on tap', (t) async {
      var taps = 0;
      await t.pumpWidget(host(PxButton.text('派活', tone: PxTone.primary, onPressed: () => taps++)));
      expect(find.text('派活'), findsOneWidget);
      await t.tap(find.text('派活'));
      expect(taps, 1);
    });

    testWidgets('sizes: md 36 tall, sm 28, icon a 36 square', (t) async {
      await t.pumpWidget(
        host(
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              PxButton.text('a', key: const Key('md'), onPressed: () {}),
              PxButton.text('b', key: const Key('sm'), size: PxSize.sm, onPressed: () {}),
              PxButton(key: const Key('icon'), size: PxSize.icon, onPressed: () {}, child: const SpriteIcon('button-add', size: 18)),
            ],
          ),
        ),
      );
      expect(t.getSize(find.byKey(const Key('md'))).height, 36);
      expect(t.getSize(find.byKey(const Key('sm'))).height, 28);
      expect(t.getSize(find.byKey(const Key('icon'))), const Size(36, 36));
    });

    testWidgets('sinks 2 px while pressed', (t) async {
      await t.pumpWidget(host(PxButton.text('按', onPressed: () {})));
      final before = t.getTopLeft(find.text('按'));
      final g = await t.startGesture(t.getCenter(find.text('按')));
      await t.pump();
      expect(t.getTopLeft(find.text('按')) - before, const Offset(2, 2));
      await g.up();
      await t.pump();
      expect(t.getTopLeft(find.text('按')), before);
    });

    testWidgets('disabled: faded and deaf', (t) async {
      await t.pumpWidget(host(PxButton.text('不行', onPressed: null)));
      await t.tap(find.text('不行'), warnIfMissed: false);
      final opacity = t.widget<Opacity>(find.ancestor(of: find.text('不行'), matching: find.byType(Opacity)).first);
      expect(opacity.opacity, .45);
    });

    testWidgets('Enter on the focused button presses it', (t) async {
      var taps = 0;
      final focus = FocusNode();
      addTearDown(focus.dispose);
      await t.pumpWidget(host(PxButton.text('键', focusNode: focus, onPressed: () => taps++)));
      focus.requestFocus();
      await t.pump();
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      expect(taps, 1);
    });
  });

  testWidgets('PxCard shows its title and aside over its body', (t) async {
    await t.pumpWidget(host(const PxCard(title: '工地', aside: Text('3 个'), child: Text('里面'))));
    expect(find.text('工地'), findsOneWidget);
    expect(find.text('3 个'), findsOneWidget);
    expect(t.getTopLeft(find.text('里面')).dy, greaterThan(t.getTopLeft(find.text('工地')).dy));
  });

  group('dialogs', () {
    testWidgets('showPxDialog opens with its title and closes with 关上', (t) async {
      await t.pumpWidget(
        host(
          Builder(
            builder: (context) => PxButton.text(
              '开',
              onPressed: () => showPxDialog<void>(context, title: const Text('设置'), builder: (_) => const Text('内容')),
            ),
          ),
        ),
      );
      await t.tap(find.text('开'));
      await t.pumpAndSettle();
      expect(find.text('设置'), findsOneWidget);
      expect(find.text('内容'), findsOneWidget);
      await t.tap(find.bySemanticsLabel('关上').last);
      await t.pumpAndSettle();
      expect(find.text('内容'), findsNothing);
    });

    testWidgets('showFarmDialog keeps its size and closes on the backdrop', (t) async {
      await t.binding.setSurfaceSize(const Size(1200, 900));
      addTearDown(() => t.binding.setSurfaceSize(null));
      await t.pumpWidget(
        host(
          Builder(
            builder: (context) => PxButton.text(
              '开',
              onPressed: () => showFarmDialog<void>(
                context,
                title: const Text('仓库'),
                icon: 'icon-crate',
                size: FarmDialogSize.sm,
                builder: (_) => const FarmSection(title: '收成', child: Text('一筐')),
              ),
            ),
          ),
        ),
      );
      await t.tap(find.text('开'));
      await t.pumpAndSettle();
      expect(find.text('仓库'), findsOneWidget);
      expect(find.text('收成'), findsOneWidget);
      final frame = find.descendant(of: find.byType(FarmDialog), matching: find.byType(PxWindow));
      expect(t.getSize(frame), const Size(480, 384));
      await t.tapAt(const Offset(10, 10));
      await t.pumpAndSettle();
      expect(find.text('仓库'), findsNothing);
    });
  });

  group('PxField and inputs', () {
    testWidgets('a field shows label, required star, hint, then the error instead', (t) async {
      await t.pumpWidget(host(const PxField(label: '名字', required: true, hint: Text('随便起'), child: SizedBox())));
      expect(find.textContaining('名字'), findsOneWidget);
      expect(find.text('随便起'), findsOneWidget);
      await t.pumpWidget(host(const PxField(label: '名字', optional: true, hint: Text('随便起'), error: '不能空', child: SizedBox())));
      expect(find.text('不能空'), findsOneWidget);
      expect(find.text('随便起'), findsNothing);
      expect(find.textContaining('可选'), findsOneWidget);
    });

    testWidgets('PxTextInput reports typing and follows its value', (t) async {
      var value = 'a';
      late StateSetter outer;
      await t.pumpWidget(
        host(
          Live((set) {
            outer = set;
            return PxTextInput(value: value, placeholder: '写点什么', onChanged: (v) => set(() => value = v));
          }),
        ),
      );
      await t.enterText(find.byType(TextField), 'hello');
      expect(value, 'hello');
      outer(() => value = 'reset');
      await t.pump();
      expect(find.text('reset'), findsOneWidget);
      expect(t.getSize(find.byType(PxTextInput)).height, 36);
    });

    testWidgets('PxTextInput offers suggestions that contain what is typed', (t) async {
      var value = '';
      await t.pumpWidget(
        host(Live((set) => PxTextInput(value: value, suggestions: const ['claude-opus', 'codex-mini'], onChanged: (v) => set(() => value = v)))),
      );
      await t.tap(find.byType(TextField));
      await t.enterText(find.byType(TextField), 'opus');
      await t.pumpAndSettle();
      expect(find.text('claude-opus'), findsOneWidget);
      expect(find.text('codex-mini'), findsNothing);
      await t.tap(find.text('claude-opus'));
      await t.pumpAndSettle();
      expect(value, 'claude-opus');
    });

    testWidgets('disabled inputs do not take typing', (t) async {
      await t.pumpWidget(host(PxTextInput(value: 'x', enabled: false, onChanged: (_) => fail('typed'))));
      expect(t.widget<TextField>(find.byType(TextField)).enabled, isFalse);
      await t.pumpWidget(host(PxTextArea(value: 'x', enabled: false, onChanged: (_) => fail('typed'))));
      expect(t.widget<TextField>(find.byType(TextField)).enabled, isFalse);
    });

    testWidgets('PxTextArea is six lines by default and reports typing', (t) async {
      var value = '';
      await t.pumpWidget(host(PxTextArea(value: value, onChanged: (v) => value = v)));
      final field = t.widget<TextField>(find.byType(TextField));
      expect(field.minLines, 6);
      await t.enterText(find.byType(TextField), '一\n二');
      expect(value, '一\n二');
    });
  });

  group('choices', () {
    testWidgets('PxSegmented picks, and a disabled option does not', (t) async {
      var value = 'a';
      await t.pumpWidget(
        host(
          Live(
            (set) => PxSegmented<String>(
              value: value,
              options: const [
                SegmentOption(value: 'a', label: '全部'),
                SegmentOption(value: 'b', label: '在忙'),
                SegmentOption(value: 'c', label: '歇着', disabled: true, title: '没有'),
              ],
              onChanged: (v) => set(() => value = v),
            ),
          ),
        ),
      );
      await t.tap(find.text('在忙'));
      await t.pump();
      expect(value, 'b');
      await t.tap(find.text('歇着'), warnIfMissed: false);
      expect(value, 'b');
    });

    testWidgets('PxPick opens, shows the placeholder first, and picks', (t) async {
      var value = '';
      await t.pumpWidget(
        host(
          Live(
            (set) => PxPick(
              clearable: true,
              value: value,
              placeholder: '选一个',
              semanticLabel: '模型',
              options: const [
                PickOption(value: 'o', label: 'Opus', detail: '贵'),
                PickOption(value: 's', label: 'Sonnet'),
              ],
              onChanged: (v) => set(() => value = v),
            ),
          ),
        ),
      );
      expect(find.text('选一个'), findsOneWidget);
      await t.tap(find.text('选一个'));
      await t.pumpAndSettle();
      expect(find.text('贵'), findsOneWidget);
      expect(find.text('选一个'), findsNWidgets(2));
      await t.tap(find.text('Opus'));
      await t.pumpAndSettle();
      expect(value, 'o');
      expect(find.text('贵'), findsNothing);
      expect(find.text('Opus'), findsOneWidget);
    });

    testWidgets('PxPick: arrows and Enter pick; disabled does not open', (t) async {
      var value = '';
      await t.pumpWidget(
        host(
          Live(
            (set) => PxPick(
              clearable: true,
              value: value,
              placeholder: '选',
              options: const [
                PickOption(value: 'x', label: 'X'),
                PickOption(value: 'y', label: 'Y'),
              ],
              onChanged: (v) => set(() => value = v),
            ),
          ),
        ),
      );
      await t.tap(find.text('选'));
      await t.pumpAndSettle();
      await t.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await t.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await t.sendKeyEvent(LogicalKeyboardKey.enter);
      await t.pumpAndSettle();
      expect(value, 'y');

      await t.pumpWidget(
        host(
          PxPick(
            clearable: true,
            value: '',
            placeholder: '关着',
            enabled: false,
            options: const [PickOption(value: 'x', label: 'X')],
            onChanged: (_) {},
          ),
        ),
      );
      await t.tap(find.text('关着'), warnIfMissed: false);
      await t.pumpAndSettle();
      expect(find.text('X'), findsNothing);
    });

    testWidgets('PxSwitchField toggles from the whole row, not when disabled', (t) async {
      var on = false;
      await t.pumpWidget(host(Live((set) => PxSwitchField(label: '开着', hint: '提示', checked: on, onChanged: (v) => set(() => on = v)))));
      await t.tap(find.text('开着'));
      await t.pumpAndSettle();
      expect(on, isTrue);
      await t.tap(find.text('提示'));
      await t.pumpAndSettle();
      expect(on, isFalse);
      await t.pumpWidget(host(PxSwitchField(label: '锁着', checked: false, enabled: false, onChanged: (_) => fail('toggled'))));
      await t.tap(find.text('锁着'), warnIfMissed: false);
    });
  });

  group('forms', () {
    testWidgets('PxChipsInput adds on Enter (split at commas), removes by × and Backspace', (t) async {
      var chips = <String>['a'];
      await t.pumpWidget(host(Live((set) => PxChipsInput(value: chips, placeholder: '加', onChanged: (v) => set(() => chips = v)))));
      await t.enterText(find.byType(TextField), 'b，c, a');
      await t.testTextInput.receiveAction(TextInputAction.done);
      await t.pump();
      expect(chips, ['a', 'b', 'c']);
      await t.tap(find.bySemanticsLabel('去掉 b'));
      await t.pump();
      expect(chips, ['a', 'c']);
      await t.showKeyboard(find.byType(TextField));
      await t.sendKeyEvent(LogicalKeyboardKey.backspace);
      await t.pump();
      expect(chips, ['a']);
    });

    testWidgets('PxChipsInput adds what is typed when it loses focus; disabled ignores taps', (t) async {
      var chips = <String>[];
      await t.pumpWidget(host(Live((set) => PxChipsInput(value: chips, placeholder: '加', onChanged: (v) => set(() => chips = v)))));
      expect(find.text('加'), findsOneWidget);
      await t.enterText(find.byType(TextField), 'x');
      FocusManager.instance.primaryFocus?.unfocus();
      await t.pump();
      expect(chips, ['x']);
      await t.pumpWidget(host(PxChipsInput(value: const ['y'], placeholder: '加', enabled: false, onChanged: (_) => fail('changed'))));
      await t.tap(find.bySemanticsLabel('去掉 y'), warnIfMissed: false);
    });

    testWidgets('PxKeyValueEditor edits, deletes and adds rows', (t) async {
      var env = <String, String>{'A': '1'};
      await t.pumpWidget(host(Live((set) => PxKeyValueEditor(value: env, onChanged: (v) => set(() => env = v)))));
      expect(find.text('A'), findsOneWidget);
      await t.enterText(find.byType(TextField).first, '2');
      expect(env, {'A': '2'});
      final fields = find.byType(TextField);
      await t.enterText(fields.at(1), ' B ');
      await t.enterText(fields.at(2), 'x');
      await t.pump();
      await t.tap(find.text('添加'));
      await t.pump();
      expect(env, {'A': '2', 'B': 'x'});
      await t.tap(find.text('删除').first);
      await t.pump();
      expect(env, {'B': 'x'});
    });

    testWidgets('PxKeyValueEditor: 添加 waits for a key; disabled ignores taps', (t) async {
      await t.pumpWidget(host(PxKeyValueEditor(value: const {'K': 'v'}, enabled: false, onChanged: (_) => fail('changed'))));
      await t.tap(find.text('删除'), warnIfMissed: false);
      await t.tap(find.text('添加'), warnIfMissed: false);
    });
  });

  group('icons', () {
    testWidgets('SpriteIcon draws at its size; ActionGlyph draws nothing for none', (t) async {
      await t.pumpWidget(
        host(const Row(children: [SpriteIcon('button-close', size: 24), ActionGlyph(SessionAction.none), ActionGlyph(SessionAction.editFile)])),
      );
      final images = find.byType(Image);
      expect(images, findsNWidgets(2));
      expect(t.getSize(images.first), const Size(24, 24));
      expect(t.getSize(images.last), const Size(16, 16));
    });

    testWidgets('Marked: the mark before the words; every mark and chrome sprite is an asset', (t) async {
      await t.pumpWidget(host(const Row(children: [Marked('mark-warn', child: Text('派不出去'))])));
      expect(find.text('派不出去'), findsOneWidget);
      expect(t.getSize(find.byType(Image)), const Size(12, 12));
      for (final name in ['button-close', 'button-add', 'button-delete', 'button-next', 'mark-check', 'mark-cross', 'mark-warn', 'button-copy', 'owner-face']) {
        expect(File('assets/pixel/$name.png').existsSync(), isTrue, reason: name);
      }
    });

    testWidgets('PhaseGlyph: what a working helper does, the farm\'s sprite otherwise, always its size', (t) async {
      Future<String?> drawn(Phase phase) async {
        await t.pumpWidget(host(Row(children: [PhaseGlyph(phase, size: 14)])));
        expect(t.getSize(find.byType(PhaseGlyph)), const Size(14, 14));
        final image = find.byType(Image);
        if (image.evaluate().isEmpty) return null;
        final asset = (t.widget<Image>(image).image as AssetImage).assetName;
        expect(File(asset).existsSync(), isTrue, reason: asset);
        return asset;
      }

      expect(await drawn(const PhaseArriving()), 'assets/pixel/icon-seeds.png');
      expect(
        await drawn(
          const PhaseWorking(
            since: 0,
            doing: Doing(action: SessionAction.runCommand, label: 'go test'),
          ),
        ),
        'assets/pixel/act-run_command.png',
      );
      expect(
        await drawn(
          const PhaseWorking(
            since: 0,
            doing: Doing(action: SessionAction.none, label: ''),
          ),
        ),
        isNull,
      );
      expect(await drawn(const PhaseRipe()), 'assets/pixel/icon-harvest.png');
      expect(await drawn(const PhaseFailed()), 'assets/pixel/icon-bug.png');
      expect(await drawn(const PhaseResting()), 'assets/pixel/act-wait.png');
      for (final name in outcomeIcon.values) {
        expect(File('assets/pixel/$name.png').existsSync(), isTrue, reason: name);
      }
    });
  });

  group('energy', () {
    testWidgets('EnergyBottle draws the bottle at a whole scale; StaminaBar its size', (t) async {
      final q = quotaOf(
        RuntimeInfo(
          id: 'x',
          preset: const RuntimePreset(
            id: 'x',
            label: 'x',
            blurb: '',
            look: Look(build: Build.biped, head: Head.rounded, body: '#fff', trim: '#000', hat: '#f00', eye: '#0ff'),
          ),
          facts: const RuntimeFacts(steer: false, refused: {}, capabilities: [], inProcess: false),
          installation: const InstallationNotFound(),
          usage: const AccountUsageOk(windows: [UsageWindow(label: 'Current session', usedPercent: 20)]),
          settings: RuntimeSettings.fromJson(const {'enabled': true, 'binPath': '', 'defaultModel': '', 'defaultEffort': '', 'env': <String, String>{}}),
          quota: const RuntimeQuota(left: 80, text: 'Current session 剩 80%'),
          checkedAt: 0,
        ),
      );
      await t.pumpWidget(
        host(
          Row(
            children: [
              EnergyBottle(atlas: atlas, quota: q, size: 48),
              StaminaBar(quota: q),
            ],
          ),
        ),
      );
      final sprite = atlas['energy-plenty-75'];
      expect(t.getSize(find.byType(PixelSprite)), Size(sprite.w * 2, sprite.h * 2));
      expect(t.getSize(find.byType(StaminaBar)), const Size(64, 8));
    });
  });

  group('toasts', () {
    testWidgets('a toast shows, stacks the newest in front, and closes after its timeout', (t) async {
      final m = ToastManager();
      addTearDown(m.dispose);
      await t.pumpWidget(
        host(
          Stack(
            children: [
              const SizedBox(height: 300),
              ToastViewport(manager: m, kicker: (x) => x.type == ToastType.achievement ? '解锁成就' : null),
            ],
          ),
        ),
      );
      m.add(type: ToastType.error, title: '出错了', description: '连不上', timeout: const Duration(seconds: 2));
      m.add(type: ToastType.achievement, title: '第一次', timeout: const Duration(seconds: 4));
      await t.pump();
      await t.pump(const Duration(milliseconds: 400));
      expect(find.text('出错了'), findsOneWidget);
      expect(find.text('解锁成就'), findsOneWidget);
      expect(m.toasts.first.title, '第一次');
      await t.pump(const Duration(seconds: 2));
      expect(find.text('出错了'), findsNothing);
      expect(find.text('第一次'), findsOneWidget);
      await t.pump(const Duration(seconds: 2));
      expect(m.toasts, isEmpty);
    });

    test('pausing holds the timers; past the limit toasts wait hidden', () {
      final m = ToastManager(limit: 1);
      final a = m.add(title: 'a', timeout: Duration.zero);
      m.add(title: 'b');
      expect(m.toasts.map((x) => x.title), ['b', 'a']);
      m
        ..pause()
        ..resume()
        ..close(a);
      expect(m.toasts.map((x) => x.title), ['b']);
      m.dispose();
    });
  });
}
