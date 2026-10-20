import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../ui/pixel/pixel.dart';
import '../audio/sfx.dart';
import 'motion.dart';
import 'scene.dart';
import 'title_stage.dart';
import '../data/ui_state.dart';

enum _Item { start, cont, settings }

const _ink = Color(0xFF3A2A18);
const _picked = Color(0xFFFFE9A8);
const _deep = [Shadow(color: _ink, offset: Offset(4, 4))];
const _soft = [Shadow(color: _ink, offset: Offset(2, 2))];

class TitleScreen extends ConsumerStatefulWidget {
  const TitleScreen({super.key});

  @override
  ConsumerState<TitleScreen> createState() => _TitleScreenState();
}

class _TitleScreenState extends ConsumerState<TitleScreen> with SingleTickerProviderStateMixin {
  _Item? _at;
  late final AnimationController _clock = AnimationController(vsync: this, duration: const Duration(days: 1))..forward();

  /// What is focused under it passes the keys up here first, before the app's arrow-key traversal and Enter-to-activate could act on them.
  final _focus = FocusNode(debugLabel: 'title');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _focus.requestFocus();
    });
  }

  @override
  void dispose() {
    _focus.dispose();
    _clock.dispose();
    super.dispose();
  }

  bool get _canContinue => hasFarm(ref.read(stateProvider));

  List<({_Item id, String label, bool enabled})> _items(bool canContinue) => [
    (id: _Item.start, label: '开始游戏', enabled: true),
    (id: _Item.cont, label: '继续游戏', enabled: canContinue),
    (id: _Item.settings, label: '设置', enabled: true),
  ];

  _Item _current(bool canContinue) => _at ?? (canContinue ? _Item.cont : _Item.start);

  void _choose(_Item item) {
    Sfx.play('tap');
    final title = ref.read(titleOpenProvider.notifier);
    switch (item) {
      case _Item.start:
        // The manager cannot think without DeepSeek's key: ask for it first.
        if (!managerReady(ref.read(settingsProvider))) {
          toasts.add(type: ToastType.info, title: '先填钥匙', description: '管家要 DeepSeek 的 API Key 才能干活：在设置里填上。');
          title.leaveFor('/settings/deepseek');
          return;
        }
        title.enterFarm(start: true);
      case _Item.cont:
        if (_canContinue) title.enterFarm(start: false);
      case _Item.settings:
        title.leaveFor('/settings');
    }
  }

  bool _onKey(KeyEvent e) {
    if (e is! KeyDownEvent || !mounted) return false;
    final canContinue = _canContinue;
    final open = _items(canContinue).where((i) => i.enabled).toList();
    final here = open.indexWhere((i) => i.id == _current(canContinue));
    if (e.logicalKey == LogicalKeyboardKey.arrowDown || e.logicalKey == LogicalKeyboardKey.arrowUp) {
      final task = e.logicalKey == LogicalKeyboardKey.arrowDown ? 1 : open.length - 1;
      setState(() => _at = open[(here + task) % open.length].id);
      Sfx.play('pick');
      return true;
    }
    if (e.logicalKey == LogicalKeyboardKey.enter || e.logicalKey == LogicalKeyboardKey.numpadEnter) {
      _choose(_current(canContinue));
      return true;
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    final canContinue = hasFarm(ref.watch(stateProvider));
    final at = _current(canContinue);
    final size = MediaQuery.sizeOf(context);
    final wide = size.width >= 640;
    final items = _items(canContinue);
    return Focus(
      focusNode: _focus,
      autofocus: true,
      onKeyEvent: (_, e) => _onKey(e) ? KeyEventResult.handled : KeyEventResult.ignored,
      child: Semantics(
        container: true,
        label: '码农场物语 首页',
        child: ColoredBox(
          color: const Color(0xFF2A1D2E),
          child: Stack(
            fit: StackFit.expand,
            children: [
              TitleStage(scene: startScene()),
              Positioned(
                left: 0,
                top: 0,
                bottom: 0,
                width: math.min(736, size.width * 0.7),
                child: const DecoratedBox(
                  decoration: BoxDecoration(gradient: LinearGradient(colors: [Color(0xBF1E1424), Color(0x591E1424), Color(0x001E1424)])),
                ),
              ),
              SingleChildScrollView(
                child: ConstrainedBox(
                  constraints: BoxConstraints(minHeight: size.height),
                  child: Padding(
                    padding: EdgeInsets.symmetric(horizontal: size.width * 0.06, vertical: 32),
                    child: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        AnimatedBuilder(
                          animation: _clock,
                          builder: (context, child) {
                            final t = _seconds;
                            final dy = cssKeyframes([(0, 0), (0.5, -5), (1, 0)], cssProgress(t, 5), cssEaseInOut);
                            return Transform.translate(offset: Offset(0, dy), child: child);
                          },
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                '码农场物语',
                                style: TextStyle(
                                  fontFamily: pixelFont,
                                  fontSize: (size.width * 0.06).clamp(40, 72),
                                  height: 1,
                                  color: Palette.cream50,
                                  shadows: _deep,
                                ),
                              ),
                              const SizedBox(height: 12),
                              const Text(
                                '一群写代码的小动物，等你来派活',
                                style: TextStyle(fontFamily: pixelFont, fontSize: 24, color: Palette.cream100, shadows: _soft),
                              ),
                            ],
                          ),
                        ),
                        SizedBox(height: wide ? 40 : 32),
                        Flex(
                          direction: wide ? Axis.horizontal : Axis.vertical,
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            SizedBox(
                              width: 224,
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  for (var i = 0; i < items.length; i++) ...[
                                    if (i > 0) const SizedBox(height: 12),
                                    _MenuButton(
                                      label: items[i].label,
                                      enabled: items[i].enabled,
                                      picked: at == items[i].id && items[i].enabled,
                                      delay: i * 0.09,
                                      clock: _clock,
                                      onHover: () => setState(() => _at = items[i].id),
                                      onTap: () => _choose(items[i].id),
                                    ),
                                  ],
                                  if (!canContinue) ...[
                                    const SizedBox(height: 12),
                                    const Padding(
                                      padding: EdgeInsets.symmetric(horizontal: 4),
                                      child: Text(
                                        '还没有农场可以继续：先开始游戏。',
                                        style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream100, shadows: _soft),
                                      ),
                                    ),
                                  ],
                                ],
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  double get _seconds => (_clock.lastElapsedDuration?.inMicroseconds ?? 0) / 1e6;
}

class _MenuButton extends StatelessWidget {
  const _MenuButton({
    required this.label,
    required this.enabled,
    required this.picked,
    required this.delay,
    required this.clock,
    required this.onHover,
    required this.onTap,
  });
  final String label;
  final bool enabled;
  final bool picked;
  final double delay;
  final AnimationController clock;
  final VoidCallback onHover;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final button = MouseRegion(
      onEnter: enabled ? (_) => onHover() : null,
      cursor: enabled ? SystemMouseCursors.click : SystemMouseCursors.forbidden,
      child: Tappable(
        onTap: enabled ? onTap : null,
        semanticLabel: label,
        builder: (context, state) => AnimatedSlide(
          offset: Offset(picked ? 8 / 224 : 0, 0),
          duration: const Duration(milliseconds: 150),
          child: Transform.translate(
            offset: state.pressed ? const Offset(1, 1) : Offset.zero,
            child: Opacity(
              opacity: enabled ? 1 : 0.45,
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                decoration: BoxDecoration(
                  color: picked ? _picked : const Color(0xFFF3E2B8),
                  border: Border.all(color: _ink, width: 2),
                  boxShadow: const [BoxShadow(color: Color(0x993A2A18), offset: Offset(2, 2))],
                ),
                foregroundDecoration: state.focused ? BoxDecoration(border: Border.all(color: Palette.leaf500, width: 2)) : null,
                child: Row(
                  children: [
                    SizedBox(
                      width: 16,
                      child: Visibility.maintain(
                        visible: picked,
                        child: const Text(
                          '▶',
                          softWrap: false,
                          overflow: TextOverflow.visible,
                          style: TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 20, color: Palette.berry),
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    Text(
                      label,
                      style: const TextStyle(fontFamily: pixelFont, fontSize: 24, height: 28 / 20, color: Palette.bark900),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return AnimatedBuilder(
      animation: clock,
      builder: (context, child) {
        final e = (clock.lastElapsedDuration?.inMicroseconds ?? 0) / 1e6 - delay;
        final p = e <= 0 ? 0.0 : (e >= 0.45 ? 1.0 : cssSteps(e / 0.45, 5));
        return Opacity(
          opacity: p,
          child: Transform.translate(offset: Offset(-28 * (1 - p), 0), child: child),
        );
      },
      child: button,
    );
  }
}
