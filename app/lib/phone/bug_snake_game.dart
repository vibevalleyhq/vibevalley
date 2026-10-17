import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../audio/sfx.dart';
import 'bug_snake.dart';
import 'lcd.dart';
import 'pad.dart';
import 'widgets.dart';

final bugSnakeGameProvider = NotifierProvider<Kept<BugSnake?>, BugSnake?>(() => Kept(null));
final bugSnakeBestProvider = NotifierProvider<Kept<int>, int>(() => Kept(0));

const _cell = 6;
const _zoom = 3.0;
const _width = bugSnakeWidth * _cell;
const _height = bugSnakeHeight * _cell;

/// The other ways are it turned.
const _head = [' #### ', '####.#', '######', '######', '####.#', ' #### '];

const _segment = [
  [' #### ', '#++++#', '#++++#', '#++++#', '#++++#', ' #### '],
  [' #### ', '#....#', '#....#', '#....#', '#....#', ' #### '],
];
const _tail = ['      ', '  ##  ', ' #++# ', ' #++# ', '  ##  ', '      '];
const _seed = ['   #  ', '  #+# ', ' #++# ', ' #++# ', '  ##  ', '      '];

const _bug = [
  [' #  # ', '# ## #', ' #### ', '######', ' #### ', '#    #'],
  [' #  # ', '  ##  ', '######', ' #### ', '######', '      '],
];

List<String> _turned(List<String> rows) => [
  for (var y = 0; y < rows.length; y++) [for (final row in rows.reversed) row[y]].join(),
];

final _heads = {
  SnakeHeading.right: _head,
  SnakeHeading.down: _turned(_head),
  SnakeHeading.left: _turned(_turned(_head)),
  SnakeHeading.up: _turned(_turned(_turned(_head))),
};

String _ended(BugSnakeEnd end) => switch (end) {
  BugSnakeEnd.wall => '撞到田埂了',
  BugSnakeEnd.self => '咬到自己了',
  BugSnakeEnd.full => '田里爬满了',
};

class BugSnakeGame extends ConsumerStatefulWidget {
  const BugSnakeGame({super.key, required this.pad});
  final Pad pad;

  @override
  ConsumerState<BugSnakeGame> createState() => _BugSnakeGameState();
}

class _BugSnakeGameState extends ConsumerState<BugSnakeGame> with SingleTickerProviderStateMixin, PadGame {
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

  BugSnake? get _g => ref.read(bugSnakeGameProvider);

  void _sync() {
    final g = _g;
    final on = _playing && g != null && g.over == null;
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
    if (_since >= bugSnakeStepMs(g)) {
      _since = 0;
      _apply(crawlBugSnake(g));
    }
  }

  void _start() {
    ref.read(bugSnakeGameProvider.notifier).set(newBugSnake(math.Random().nextInt(1 << 31)));
    _since = 0;
    setState(() => _playing = true);
    Sfx.play('plant');
    _sync();
  }

  void _apply(BugSnake next) {
    final g = _g;
    if (g != null && next.eaten > g.eaten) Sfx.play('pick');
    if (g != null && next.bugs > g.bugs) Sfx.play('coin');
    if (g != null && next.bug != null && g.bug == null) Sfx.play('bug');
    if (next.over != null && g?.over == null) {
      Sfx.play('thud');
      setState(() => _playing = false);
      if (next.score > ref.read(bugSnakeBestProvider)) ref.read(bugSnakeBestProvider.notifier).set(next.score);
    }
    ref.read(bugSnakeGameProvider.notifier).set(next);
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
    if (g == null || g.over != null) {
      if (button == PadButton.a) _start();
      return;
    }
    if (!_playing) {
      if (button == PadButton.a) _pause(false);
      return;
    }
    final to = switch (button) {
      PadButton.up => SnakeHeading.up,
      PadButton.down => SnakeHeading.down,
      PadButton.left => SnakeHeading.left,
      PadButton.right => SnakeHeading.right,
      PadButton.a => null,
      PadButton.b => null,
    };
    if (button == PadButton.b) _pause(true);
    if (to != null) ref.read(bugSnakeGameProvider.notifier).set(steerBugSnake(g, to));
  }

  @override
  Widget build(BuildContext context) {
    final g = ref.watch(bugSnakeGameProvider);
    final top = ref.watch(bugSnakeBestProvider);
    final score = g?.score ?? 0;
    final paused = g == null || g.over != null || !_playing;
    String five(int n) => '$n'.padLeft(5, '0');
    final over = g?.over;
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Row(
              children: [
                Text('贪吃虫', style: lcdText()),
                const Spacer(),
                Text('最好 ${five(math.max(top, score))}', style: lcdText()),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
            child: Row(
              children: [
                Text('种子 ${g?.eaten ?? 0} · 虫 ${g?.bugs ?? 0}', style: lcdText()),
                const Spacer(),
                Text(five(score), style: lcdText()),
              ],
            ),
          ),
          const SizedBox(height: 8),
          DecoratedBox(
            decoration: const BoxDecoration(boxShadow: [BoxShadow(color: Lcd.ink, spreadRadius: 2)]),
            child: SizedBox(
              width: _width * _zoom,
              height: _height * _zoom,
              child: Stack(
                children: [
                  Positioned.fill(child: CustomPaint(painter: _FieldPainter(g))),
                  if (paused)
                    Positioned.fill(
                      child: ColoredBox(
                        color: Lcd.paper.withValues(alpha: 0.8),
                        child: Center(
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(over != null ? _ended(over) : (g != null ? '暂停' : '贪吃虫'), style: lcdText()),
                              Blink(child: Text('按 A ${g != null && over == null ? '继续' : (g != null ? '再来' : '开始')}', style: lcdText())),
                            ],
                          ),
                        ),
                      ),
                    ),
                ],
              ),
            ),
          ),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.only(bottom: 8),
            child: Text(
              '方向键转弯，B 暂停\n吃种子长一节，虫子飞走前吃掉多得分',
              textAlign: TextAlign.center,
              style: lcdText(color: Lcd.dark, height: 1.625),
            ),
          ),
        ],
      ),
    );
  }
}

class _FieldPainter extends CustomPainter {
  _FieldPainter(this.g);
  final BugSnake? g;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(_zoom);
    final p = Paint()..isAntiAlias = false;
    canvas.drawRect(const Rect.fromLTWH(0, 0, _width * 1.0, _height * 1.0), p..color = Lcd.paper);
    p.color = Lcd.light;
    for (var y = 0; y < bugSnakeHeight; y++) {
      for (var x = 0; x < bugSnakeWidth; x++) {
        canvas.drawRect(Rect.fromLTWH(x * _cell + 2.0, y * _cell + 3.0, 2, 1), p);
      }
    }
    final g = this.g;
    if (g == null) return;
    void draw(List<String> picture, int c) => drawPattern(canvas, picture, (c % bugSnakeWidth) * _cell * 1.0, (c ~/ bugSnakeWidth) * _cell * 1.0);
    draw(_seed, g.food);
    // It blinks its last ten ticks, before it flies off.
    final bug = g.bug;
    if (bug != null && (g.bugLeft > 10 || (g.bugLeft ~/ 2) % 2 == 0)) draw(_bug[g.bugLeft % 2], bug);
    for (var i = 0; i < g.body.length; i++) {
      draw(i == 0 ? _heads[g.heading]! : (i == g.body.length - 1 ? _tail : _segment[i % 2]), g.body[i]);
    }
  }

  @override
  bool shouldRepaint(_FieldPainter old) => old.g != g;
}

class BugSnakeIcon extends StatelessWidget {
  const BugSnakeIcon({super.key});

  @override
  Widget build(BuildContext context) => const SizedBox.square(dimension: 28, child: CustomPaint(painter: _IconPainter()));
}

class _IconPainter extends CustomPainter {
  const _IconPainter();

  static const _rows = ['    # #   ', '    ###   ', '++..#o#  #', '++..###  +'];

  @override
  void paint(Canvas canvas, Size size) {
    final k = math.min(size.width / 10, size.height / 10);
    canvas
      ..translate((size.width - 10 * k) / 2, (size.height - 10 * k) / 2)
      ..scale(k)
      ..translate(0, 1);
    final p = Paint()..isAntiAlias = false;
    for (var y = 0; y < _rows.length; y++) {
      for (var x = 0; x < _rows[y].length; x++) {
        final c = switch (_rows[y][x]) {
          '#' => Lcd.ink,
          '+' => Lcd.dark,
          '.' => Lcd.mid,
          'o' => Lcd.paper,
          _ => null,
        };
        if (c != null) canvas.drawRect(Rect.fromLTWH(x.toDouble(), y + 2.0, 1, 1), p..color = c);
      }
    }
    canvas.drawRect(const Rect.fromLTWH(0, 6, 10, 1), p..color = Lcd.dark);
  }

  @override
  bool shouldRepaint(_IconPainter old) => false;
}
