import 'dart:async';

import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../gen/vibevalley.dart';
import '../audio/sfx.dart';
import '../ui/pixel_card.dart';
import '../voice/voice.dart';
import 'blocks_game.dart';
import 'calls.dart';
import 'bug_snake_game.dart';
import 'dino_game.dart';
import 'merge_game.dart';
import 'lcd.dart';
import 'pad.dart';
import 'screens.dart';
import 'sokoban_game.dart';
import 'kit.dart';

export 'calls.dart' show phoneProvider, PhoneState;

final phoneOpenProvider = NotifierProvider<PhoneOpen, bool>(PhoneOpen.new);

class PhoneOpen extends Notifier<bool> {
  @override
  bool build() => false;

  void set(bool open) {
    state = open;
    if (!open) ref.read(phoneProvider.notifier).putAway();
  }

  void toggle() => set(!state);
}

sealed class PhoneTarget {
  const PhoneTarget();
}

final class PhoneTargetSession extends PhoneTarget {
  const PhoneTargetSession(this.id);
  final String id;
}

final class PhoneTargetPlans extends PhoneTarget {
  const PhoneTargetPlans([this.playbook]);
  final String? playbook;
}

final phoneTargetProvider = NotifierProvider<PhoneTargets, PhoneTarget?>(PhoneTargets.new);

class PhoneTargets extends Notifier<PhoneTarget?> {
  @override
  PhoneTarget? build() => null;

  void go(PhoneTarget target) => state = target;
}

bool _live(VoiceCall call) => call.phase == CallPhase.connecting || call.phase == CallPhase.live;

void _report(WidgetRef ref, VoiceCall call) => ref.read(phoneProvider.notifier).voice(live: _live(call), connected: call.phase == CallPhase.live);

class PhoneButton extends ConsumerStatefulWidget {
  const PhoneButton({super.key, required this.call, this.height = 36});
  final VoiceCall call;
  final double height;

  @override
  ConsumerState<PhoneButton> createState() => _PhoneButtonState();
}

class _PhoneButtonState extends ConsumerState<PhoneButton> {
  @override
  void initState() {
    super.initState();
    widget.call.addListener(_voice);
  }

  @override
  void didUpdateWidget(PhoneButton old) {
    super.didUpdateWidget(old);
    if (old.call != widget.call) {
      old.call.removeListener(_voice);
      widget.call.addListener(_voice);
    }
  }

  @override
  void dispose() {
    widget.call.removeListener(_voice);
    super.dispose();
  }

  void _voice() {
    _report(ref, widget.call);
    setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final phone = ref.watch(phoneProvider);
    final count = phone.missed.length;
    final ringing = phone.ringing != null;
    final live = _live(widget.call);
    final label = ringing ? '手机：来电' : (count > 0 ? '手机，$count 个未接来电' : '手机');
    return Semantics(
      button: true,
      label: label,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: GestureDetector(
          onTap: () {
            Sfx.play('open');
            ref.read(phoneOpenProvider.notifier).toggle();
          },
          child: Shake(
            on: ringing,
            child: Stack(
              clipBehavior: Clip.none,
              children: [
                PixelCard(
                  height: widget.height,
                  rows: [
                    [Glyph(phoneCells(ringing || live), 20), Words(live ? '通话中' : (ringing ? '来电' : '手机'))],
                  ],
                ),
                if (count > 0)
                  Positioned(
                    top: -6,
                    right: -6,
                    child: Container(
                      color: const Color(0xFFC84A3A),
                      padding: const EdgeInsets.symmetric(horizontal: 4),
                      child: Text('$count', style: lcdText(color: const Color(0xFFF7E8C4), size: 10, height: 1.4)),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class FarmPhone extends ConsumerStatefulWidget {
  const FarmPhone({super.key, required this.call});

  final VoiceCall call;

  @override
  ConsumerState<FarmPhone> createState() => _FarmPhoneState();
}

class _FarmPhoneState extends ConsumerState<FarmPhone> {
  PhoneApp _app = PhoneApp.home;
  final _pad = Pad();

  @override
  void initState() {
    super.initState();
    widget.call.addListener(_voice);
  }

  @override
  void didUpdateWidget(FarmPhone old) {
    super.didUpdateWidget(old);
    if (old.call != widget.call) {
      old.call.removeListener(_voice);
      widget.call.addListener(_voice);
    }
  }

  @override
  void dispose() {
    widget.call.removeListener(_voice);
    super.dispose();
  }

  void _voice() {
    _report(ref, widget.call);
    setState(() {});
  }

  void _put() => ref.read(phoneOpenProvider.notifier).set(false);

  void _open(PhoneApp app) {
    Sfx.play('tap');
    setState(() => _app = app);
  }

  void _callManager() => unawaited(widget.call.start());

  void _settle(InboxItem call, bool answered) {
    final router = GoRouter.maybeOf(context);
    ref.read(phoneProvider.notifier).settle(call, answered: answered);
    if (!answered) return;
    switch (call.target) {
      case InboxTargetSession(:final id):
        ref.read(phoneTargetProvider.notifier).go(PhoneTargetSession(id));
      case InboxTargetPlans(:final playbook):
        ref.read(phoneTargetProvider.notifier).go(PhoneTargetPlans(playbook));
      case InboxTargetChat(:final conversation):
        router?.go('/chat/$conversation');
    }
  }

  @override
  Widget build(BuildContext context) {
    final phone = ref.watch(phoneProvider);
    final ringing = phone.ringing;
    final live = _live(widget.call);
    final game =
        !live &&
        ringing == null &&
        (_app == PhoneApp.blocks || _app == PhoneApp.dino || _app == PhoneApp.sokoban || _app == PhoneApp.bugs || _app == PhoneApp.merge);
    final Widget screen;
    if (live) {
      screen = VoiceScreen(call: widget.call);
    } else if (ringing != null) {
      screen = RingingScreen(call: ringing, onAnswer: () => _settle(ringing, true), onDecline: () => _settle(ringing, false));
    } else {
      screen = switch (_app) {
        PhoneApp.home => HomeScreen(
          missed: phone.missed.length,
          onOpen: _open,
          onCall: _callManager,
          onChannels: () {
            final router = GoRouter.maybeOf(context);
            _put();
            router?.go('/chat');
          },
          onPlans: () {
            _put();
            ref.read(phoneTargetProvider.notifier).go(const PhoneTargetPlans());
          },
        ),
        PhoneApp.blocks => BlocksGame(pad: _pad, big: true),
        PhoneApp.sokoban => SokobanGame(pad: _pad),
        PhoneApp.dino => DinoGame(pad: _pad, big: true),
        PhoneApp.bugs => BugSnakeGame(pad: _pad),
        PhoneApp.merge => MergeGame(pad: _pad),
        PhoneApp.missed ||
        PhoneApp.log => ListScreen(screen: _app, onScreen: (s) => setState(() => _app = s), onAnswer: (c) => _settle(c, true), onCall: _callManager),
      };
    }
    return _Handset(
      big: game,
      tall: game || live || ringing != null,
      pad: game ? _pad : null,
      onClose: _put,
      onHome: () {
        Sfx.play('tap');
        if (_app == PhoneApp.home && ringing == null && !live) {
          _put();
        } else {
          setState(() => _app = PhoneApp.home);
          ref.read(phoneProvider.notifier).silence();
        }
      },
      child: screen,
    );
  }
}

class _Handset extends StatefulWidget {
  const _Handset({required this.child, required this.onClose, required this.onHome, required this.pad, required this.big, required this.tall});
  final Widget child;
  final VoidCallback onClose;
  final VoidCallback onHome;

  /// null while no game is listening (the keys dim).
  final Pad? pad;
  final bool big;

  /// A taller screen for a call: 300 px cuts off the bottom of the ringing and voice screens.
  final bool tall;

  @override
  State<_Handset> createState() => _HandsetState();
}

class _HandsetState extends State<_Handset> {
  DateTime _now = DateTime.now();
  late final Timer _clock = Timer.periodic(const Duration(seconds: 15), (_) => setState(() => _now = DateTime.now()));

  @override
  void initState() {
    super.initState();
    _clock;
  }

  @override
  void dispose() {
    _clock.cancel();
    super.dispose();
  }

  KeyEventResult _key(FocusNode _, KeyEvent e) {
    if (e is KeyDownEvent && e.logicalKey == LogicalKeyboardKey.escape) {
      widget.onClose();
      return KeyEventResult.handled;
    }
    final pad = widget.pad;
    return pad == null ? KeyEventResult.ignored : padKey(pad, e);
  }

  @override
  Widget build(BuildContext context) {
    final big = widget.big;
    String two(int n) => '$n'.padLeft(2, '0');
    return Focus(
      autofocus: true,
      onKeyEvent: _key,
      child: Semantics(
        label: '农场手机',
        container: true,
        child: CustomPaint(
          painter: const _BodyPainter(),
          child: SizedBox(
            width: big ? 356 : 236,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(10, 10, 10, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Container(width: 40, height: 4, color: const Color(0xFF1E140B)),
                  const SizedBox(height: 8),
                  SizedBox(
                    height: widget.tall ? 440 : 300,
                    child: CustomPaint(
                      painter: const _ScreenPainter(),
                      child: ClipRect(
                        child: Padding(
                          padding: const EdgeInsets.all(2),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              Container(
                                decoration: const BoxDecoration(
                                  border: Border(bottom: BorderSide(color: Lcd.dark, width: 2)),
                                ),
                                padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
                                child: Row(
                                  children: [
                                    const _Signal(),
                                    const SizedBox(width: 4),
                                    Text('农场通', style: lcdText()),
                                    const Spacer(),
                                    Text('${two(_now.hour)}:${two(_now.minute)}', style: lcdText()),
                                    const SizedBox(width: 4),
                                    const _Battery(),
                                  ],
                                ),
                              ),
                              Expanded(child: widget.child),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(height: 8),
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 4),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.spaceBetween,
                      children: [
                        _Cross(pad: widget.pad),
                        Semantics(
                          button: true,
                          label: '主屏',
                          child: GestureDetector(
                            onTap: widget.onHome,
                            child: const MouseRegion(
                              cursor: SystemMouseCursors.click,
                              child: _Pressable(
                                child: SizedBox(width: 40, height: 18, child: CustomPaint(painter: _HomeKeyPainter())),
                              ),
                            ),
                          ),
                        ),
                        Row(
                          children: [
                            _AbKey(button: PadButton.b, label: 'B', pad: widget.pad),
                            const SizedBox(width: 8),
                            _AbKey(button: PadButton.a, label: 'A', pad: widget.pad),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _BodyPainter extends CustomPainter {
  const _BodyPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final w = size.width;
    final h = size.height;
    final p = Paint()..isAntiAlias = false;
    canvas
      ..drawRect(Rect.fromLTWH(3, 4, w, h), p..color = const Color(0x731E140A))
      ..drawRect(Offset.zero & size, p..color = const Color(0xFF67482D));
    // A 4 px light band inside at the top and left, a dark one at the bottom and right; the outline goes over both.
    p.color = const Color(0xFF8A6440);
    canvas
      ..drawRect(Rect.fromLTWH(0, 0, w, 4), p)
      ..drawRect(Rect.fromLTWH(0, 0, 4, h), p);
    p.color = const Color(0xFF4A321E);
    canvas
      ..drawRect(Rect.fromLTWH(0, h - 4, w, 4), p)
      ..drawRect(Rect.fromLTWH(w - 4, 0, 4, h), p);
    _outline(canvas, size, const Color(0xFF2F1F13));
  }

  @override
  bool shouldRepaint(_BodyPainter old) => false;
}

void _outline(Canvas canvas, Size size, Color color) {
  final w = size.width;
  final h = size.height;
  final p = Paint()
    ..color = color
    ..isAntiAlias = false;
  canvas
    ..drawRect(Rect.fromLTWH(0, 0, w, 2), p)
    ..drawRect(Rect.fromLTWH(0, h - 2, w, 2), p)
    ..drawRect(Rect.fromLTWH(0, 0, 2, h), p)
    ..drawRect(Rect.fromLTWH(w - 2, 0, 2, h), p);
}

class _ScreenPainter extends CustomPainter {
  const _ScreenPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..isAntiAlias = false;
    canvas
      ..drawRect(Offset.zero & size, p..color = Lcd.paper)
      ..drawRect(Rect.fromLTWH(0, 0, size.width, 3), p..color = const Color(0xFFA8BD78))
      ..drawRect(Rect.fromLTWH(0, 0, 3, size.height), p);
    _outline(canvas, size, const Color(0xFF2F1F13));
  }

  @override
  bool shouldRepaint(_ScreenPainter old) => false;
}

class _HomeKeyPainter extends CustomPainter {
  const _HomeKeyPainter();

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..isAntiAlias = false;
    canvas
      ..drawRect(Offset.zero & size, p..color = const Color(0xFF46301D))
      ..drawRect(Rect.fromLTWH(0, 0, size.width, 4), p..color = const Color(0xFF5C4029))
      ..drawRect(Rect.fromLTWH(0, 0, 4, size.height), p);
    _outline(canvas, size, const Color(0xFF2F1F13));
  }

  @override
  bool shouldRepaint(_HomeKeyPainter old) => false;
}

class _Pressable extends StatefulWidget {
  const _Pressable({required this.child});
  final Widget child;

  @override
  State<_Pressable> createState() => _PressableState();
}

class _PressableState extends State<_Pressable> {
  bool _down = false;

  @override
  Widget build(BuildContext context) => Listener(
    onPointerDown: (_) => setState(() => _down = true),
    onPointerUp: (_) => setState(() => _down = false),
    onPointerCancel: (_) => setState(() => _down = false),
    child: Transform.translate(offset: Offset(0, _down ? 1 : 0), child: widget.child),
  );
}

class _Signal extends StatelessWidget {
  const _Signal();

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      for (final h in const [3.0, 5.0, 7.0, 9.0]) ...[Container(width: 2, height: h, color: Lcd.ink), const SizedBox(width: 1)],
    ],
  );
}

class _Battery extends StatelessWidget {
  const _Battery();

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Container(
        width: 14,
        height: 8,
        decoration: BoxDecoration(
          color: Lcd.ink,
          border: Border.all(color: Lcd.ink, width: 2),
        ),
        // The right 4 px of the inside are light (the charge is the dark rest).
        alignment: Alignment.centerRight,
        child: Container(width: 4, color: Lcd.light),
      ),
      Container(width: 2, height: 4, color: Lcd.ink),
    ],
  );
}

class _PadPress extends StatefulWidget {
  const _PadPress({required this.button, required this.pad, required this.label, required this.builder});
  final PadButton button;
  final Pad? pad;
  final String label;
  final Widget Function(bool down) builder;

  @override
  State<_PadPress> createState() => _PadPressState();
}

class _PadPressState extends State<_PadPress> {
  bool _down = false;

  void _set(bool down) {
    final pad = widget.pad;
    if (pad == null || _down == down) return;
    setState(() => _down = down);
    pad.press(widget.button, down);
  }

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    enabled: widget.pad != null,
    label: widget.label,
    child: Listener(
      onPointerDown: (_) => _set(true),
      onPointerUp: (_) => _set(false),
      onPointerCancel: (_) => _set(false),
      child: MouseRegion(onExit: (_) => _set(false), child: widget.builder(_down && widget.pad != null)),
    ),
  );
}

class _Cross extends StatelessWidget {
  const _Cross({required this.pad});
  final Pad? pad;

  @override
  Widget build(BuildContext context) {
    Widget key(PadButton button, String label) => _PadPress(
      button: button,
      pad: pad,
      label: label,
      builder: (down) => Container(width: 16, height: 16, color: down ? const Color(0xFF1E140B) : const Color(0xFF2F1F13)),
    );
    return Opacity(
      opacity: pad == null ? 0.55 : 1,
      child: SizedBox(
        width: 48,
        height: 48,
        child: Stack(
          children: [
            Positioned(top: 0, left: 16, child: key(PadButton.up, '上')),
            Positioned(top: 16, left: 0, child: key(PadButton.left, '左')),
            Positioned(top: 16, right: 0, child: key(PadButton.right, '右')),
            Positioned(bottom: 0, left: 16, child: key(PadButton.down, '下')),
            Positioned(top: 16, left: 16, child: Container(width: 16, height: 16, color: const Color(0xFF2F1F13))),
          ],
        ),
      ),
    );
  }
}

class _AbKey extends StatelessWidget {
  const _AbKey({required this.button, required this.label, required this.pad});
  final PadButton button;
  final String label;
  final Pad? pad;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: pad == null ? 0.55 : 1,
    child: _PadPress(
      button: button,
      pad: pad,
      label: label,
      builder: (down) => Transform.translate(
        offset: Offset(0, down ? 1 : 0),
        child: SizedBox(
          width: 24,
          height: 24,
          child: CustomPaint(
            painter: _AbPainter(down),
            child: Center(
              child: Text(label, style: lcdText(color: const Color(0xFFF7E8C4), height: 1)),
            ),
          ),
        ),
      ),
    ),
  );
}

class _AbPainter extends CustomPainter {
  const _AbPainter(this.down);
  final bool down;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..isAntiAlias = false;
    canvas.drawRect(Offset.zero & size, p..color = const Color(0xFFC84A3A));
    if (!down) {
      p.color = const Color(0xFF9C3A2D);
      canvas
        ..drawRect(Rect.fromLTWH(0, size.height - 4, size.width, 4), p)
        ..drawRect(Rect.fromLTWH(size.width - 4, 0, 4, size.height), p);
    }
    _outline(canvas, size, const Color(0xFF2F1F13));
  }

  @override
  bool shouldRepaint(_AbPainter old) => old.down != down;
}
