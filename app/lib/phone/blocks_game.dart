import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../shell/sfx.dart';
import 'blocks.dart';
import 'lcd.dart';
import 'pad.dart';
import 'widgets.dart';

final blocksGameProvider = NotifierProvider<Kept<Blocks?>, Blocks?>(() => Kept(null));
final blocksBestProvider = NotifierProvider<Kept<int>, int>(() => Kept(0));

const _cellSmall = 9.0;
const _cellBig = 14.0;

/// The light ones get an inner square, so they read on the screen.
const _shade = [Lcd.dark, Lcd.ink, Lcd.dark, Lcd.mid, Lcd.ink, Lcd.mid, Lcd.dark];

class BlocksGame extends ConsumerStatefulWidget {
  const BlocksGame({super.key, required this.pad, this.big = false});
  final Pad pad;
  final bool big;

  @override
  ConsumerState<BlocksGame> createState() => _BlocksGameState();
}

class _BlocksGameState extends ConsumerState<BlocksGame> with SingleTickerProviderStateMixin, PadGame {
  bool _playing = false;
  double _since = 0;
  Duration _last = Duration.zero;
  late final Ticker _ticker = createTicker(_frame);

  @override
  Pad get pad => widget.pad;

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  Blocks? get _g => ref.read(blocksGameProvider);

  void _sync() {
    final g = _g;
    final on = _playing && g != null && !g.over;
    if (on && !_ticker.isActive) {
      _last = Duration.zero;
      _ticker.start();
    } else if (!on && _ticker.isActive) {
      _ticker.stop();
    }
  }

  void _frame(Duration elapsed) {
    final g = _g;
    final ms = (elapsed - _last).inMicroseconds / 1000;
    _last = elapsed;
    if (g == null) return;
    _since += ms;
    if (_since >= fallMs(g.level)) {
      _since = 0;
      _apply(fall(g));
    }
  }

  void _start() {
    ref.read(blocksGameProvider.notifier).set(newBlocks(math.Random().nextInt(1 << 31)));
    _since = 0;
    setState(() => _playing = true);
    Sfx.play('plant');
    _sync();
  }

  void _apply(Blocks next) {
    final g = _g;
    if (next.lines > (g?.lines ?? 0)) Sfx.play('coin');
    if (next.over && !(g?.over ?? false)) {
      Sfx.play('nope');
      setState(() => _playing = false);
      if (next.score > ref.read(blocksBestProvider)) ref.read(blocksBestProvider.notifier).set(next.score);
    }
    ref.read(blocksGameProvider.notifier).set(next);
    _sync();
  }

  void _pause(bool on) {
    setState(() => _playing = !on);
    _sync();
  }

  @override
  void onPad(PadButton button, bool down) {
    if (!down) return;
    final g = _g;
    if (g == null || g.over) {
      if (button == PadButton.a) _start();
      return;
    }
    if (!_playing) {
      if (button == PadButton.a) _pause(false);
      return;
    }
    switch (button) {
      case PadButton.left:
        _apply(shift(g, -1));
      case PadButton.right:
        _apply(shift(g, 1));
      case PadButton.up:
        _apply(turn(g));
      case PadButton.down:
        _since = 0;
        _apply(fall(g));
      case PadButton.a:
        Sfx.play('thud');
        _apply(slam(g));
      case PadButton.b:
        _pause(true);
    }
  }

  @override
  Widget build(BuildContext context) {
    final g = ref.watch(blocksGameProvider);
    final top = ref.watch(blocksBestProvider);
    final cell = widget.big ? _cellBig : _cellSmall;
    final paused = g == null || g.over || !_playing;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          DecoratedBox(
            decoration: const BoxDecoration(boxShadow: [BoxShadow(color: Lcd.ink, spreadRadius: 2)]),
            child: SizedBox(
              width: blocksWidth * cell,
              height: blocksHeight * cell,
              child: Stack(
                children: [
                  Positioned.fill(child: CustomPaint(painter: _WellPainter(g, cell))),
                  if (paused)
                    Positioned.fill(
                      child: ColoredBox(
                        color: Lcd.paper.withValues(alpha: 0.8),
                        child: Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(g?.over ?? false ? '没地方了' : (g != null ? '暂停' : '方块'), style: lcdText()),
                              Blink(child: Text('按 A ${g != null && !g.over ? '继续' : '开始'}', style: lcdText())),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          SizedBox(width: widget.big ? 16 : 8),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _Next(g?.next),
                const SizedBox(height: 8),
                _Stat('分数', g?.score ?? 0),
                const SizedBox(height: 8),
                _Stat('行', g?.lines ?? 0),
                const SizedBox(height: 8),
                _Stat('级', g?.level ?? 1),
                const SizedBox(height: 8),
                _Stat('最好', math.max(top, g?.score ?? 0)),
                const Spacer(),
                Padding(
                  padding: const EdgeInsets.only(bottom: 4),
                  child: Text('←→ 移 ↑ 转\n↓ 落 A 到底\nB 暂停', style: lcdText(color: Lcd.dark, height: 1.625)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _WellPainter extends CustomPainter {
  _WellPainter(this.g, this.cell);
  final Blocks? g;
  final double cell;

  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..isAntiAlias = false;
    canvas.drawRect(Offset.zero & Size(blocksWidth * cell, blocksHeight * cell), p..color = Lcd.paper);
    final b = math.max(1, (cell / 7).round()).toDouble();
    void block(int x, int y, Color? shade) {
      if (y < 0) return;
      final px = x * cell;
      final py = y * cell;
      if (shade == null) {
        canvas.drawRect(Rect.fromLTWH(px + b, py + b, cell - 2 * b, cell - 2 * b), p..color = Lcd.light);
        return;
      }
      canvas
        ..drawRect(Rect.fromLTWH(px, py, cell - 1, cell - 1), p..color = shade)
        ..drawRect(Rect.fromLTWH(px + 2 * b, py + 2 * b, cell - 1 - 4 * b, cell - 1 - 4 * b), p..color = Lcd.light)
        ..drawRect(Rect.fromLTWH(px + 3 * b, py + 3 * b, cell - 1 - 6 * b, cell - 1 - 6 * b), p..color = shade);
    }

    final g = this.g;
    if (g == null) return;
    for (var i = 0; i < g.well.length; i++) {
      final c = g.well[i];
      if (c != 0) block(i % blocksWidth, i ~/ blocksWidth, _shade[c - 1]);
    }
    if (!g.over) {
      for (final (x, y) in cellsOf(landingOf(g))) {
        block(x, y, null);
      }
      for (final (x, y) in cellsOf(g.piece)) {
        block(x, y, _shade[g.piece.kind.index]);
      }
    }
  }

  @override
  bool shouldRepaint(_WellPainter old) => old.g != g || old.cell != cell;
}

class _Next extends StatelessWidget {
  const _Next(this.kind);
  final PieceKind? kind;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('下一个', style: lcdText()),
      const SizedBox(height: 4),
      Container(
        width: 36,
        height: 20,
        color: Lcd.light,
        padding: const EdgeInsets.all(4),
        child: CustomPaint(painter: _NextPainter(kind)),
      ),
    ],
  );
}

class _NextPainter extends CustomPainter {
  _NextPainter(this.kind);
  final PieceKind? kind;

  @override
  void paint(Canvas canvas, Size size) {
    final kind = this.kind;
    if (kind == null) return;
    final k = math.min(size.width / 4, size.height / 2);
    final ox = (size.width - 4 * k) / 2;
    final oy = (size.height - 2 * k) / 2;
    final p = Paint()
      ..color = Lcd.ink
      ..isAntiAlias = false;
    for (final (x, y) in cellsOf(Falling(kind: kind, turn: 0, x: 0, y: 0))) {
      canvas.drawRect(Rect.fromLTWH(ox + x * k, oy + (y == 0 ? 0 : 1) * k, 0.9 * k, 0.9 * k), p);
    }
  }

  @override
  bool shouldRepaint(_NextPainter old) => old.kind != kind;
}

class _Stat extends StatelessWidget {
  const _Stat(this.label, this.value);
  final String label;
  final int value;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Text(label, style: lcdText()),
      const Spacer(),
      Text('$value', style: lcdText()),
    ],
  );
}
