import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../audio/sfx.dart';
import 'dino.dart';
import 'lcd.dart';
import 'pad.dart';
import 'kit.dart';

final dinoBestProvider = NotifierProvider<Kept<int>, int>(() => Kept(0));

/// 12×14, two running frames; ducking, 16×8.
const _run = [
  [
    '      ####  ',
    '     ## ### ',
    '     #######',
    '     ####   ',
    '#    ######',
    '##  #####   ',
    '########### ',
    ' #########  ',
    '  ########  ',
    '   ######   ',
    '    ##  #   ',
    '    #   ##  ',
    '    ##      ',
    '            ',
  ],
  [
    '      ####  ',
    '     ## ### ',
    '     #######',
    '     ####   ',
    '#    ######',
    '##  #####   ',
    '########### ',
    ' #########  ',
    '  ########  ',
    '   ######   ',
    '    #  ##   ',
    '   ##   #   ',
    '        ##  ',
    '            ',
  ],
];
const _duck = [
  [
    '           ##### ',
    '#  ########## ###',
    '############### ',
    ' ##########     ',
    '  #######       ',
    '   #  ##        ',
    '   ##  #        ',
    '       ##       ',
  ],
  [
    '           ##### ',
    '#  ########## ###',
    '############### ',
    ' ##########     ',
    '  #######       ',
    '   ## #         ',
    '      ##        ',
    '                ',
  ],
];
const _cactus = [' ++   ', ' ++ + ', '+++ + ', '+++++ ', ' ++   ', ' ++   ', ' ++   ', ' ++   ', ' ++   ', ' ++   ', ' ++   ', ' ++   '];
const _cacti = [
  ' +     +    ',
  '+++ + +++   ',
  '+++ +++++ + ',
  '+++++++++++ ',
  '+++ +++++   ',
  '+++++++++   ',
  '+++ ++++++  ',
  '+++ +++++   ',
  '+++ +++++   ',
  '+++ +++++   ',
];
const _bird = [
  ['   #        ', '  ###       ', ' ###### ##  ', '#########   ', '   ######   ', '    ###     ', '            ', '            '],
  ['            ', '            ', ' ###### ##  ', '#########   ', '   ######   ', '    ####    ', '     ##     ', '      #     '],
];

List<String> _picture(Obstacle o, double t) => switch (o.kind) {
  ObstacleKind.bird => _bird[(t / 180).floor() % 2],
  ObstacleKind.cactus => _cactus,
  ObstacleKind.cacti => _cacti,
};

class DinoGame extends ConsumerStatefulWidget {
  const DinoGame({super.key, required this.pad, this.big = false});
  final Pad pad;
  final bool big;

  @override
  ConsumerState<DinoGame> createState() => _DinoGameState();
}

class _DinoGameState extends ConsumerState<DinoGame> with SingleTickerProviderStateMixin, PadGame {
  Dino? _d;
  Duration _last = Duration.zero;
  late final Ticker _ticker = createTicker(_frame);

  @override
  Pad get pad => widget.pad;

  bool get _playing => _d != null && !_d!.over;

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  void _set(Dino d) {
    setState(() => _d = d);
    if (_playing && !_ticker.isActive) {
      _last = Duration.zero;
      _ticker.start();
    } else if (!_playing && _ticker.isActive) {
      _ticker.stop();
    }
  }

  void _frame(Duration elapsed) {
    final d = _d;
    final ms = (elapsed - _last).inMicroseconds / 1000;
    _last = elapsed;
    if (d == null) return;
    final next = run(d, ms);
    if (next.over) {
      Sfx.play('thud');
      if (dinoScore(next) > ref.read(dinoBestProvider)) ref.read(dinoBestProvider.notifier).set(dinoScore(next));
    }
    _set(next);
  }

  void _start() {
    _set(jump(newDino(math.Random().nextInt(1 << 31))));
    Sfx.play('yip');
  }

  @override
  void onPad(PadButton button, bool down) {
    final d = _d;
    final jumpKey = button == PadButton.a || button == PadButton.up;
    if (d == null || d.over) {
      if (down && jumpKey) _start();
      return;
    }
    if (jumpKey && down) {
      if (d.lift == 0) Sfx.play('tap');
      _set(jump(d));
      return;
    }
    if (button == PadButton.down || button == PadButton.b) _set(duck(d, down));
  }

  @override
  Widget build(BuildContext context) {
    final zoom = widget.big ? 3.0 : 2.0;
    final top = ref.watch(dinoBestProvider);
    final d = _d;
    final score = d == null ? 0 : dinoScore(d);
    String five(int n) => '$n'.padLeft(5, '0');
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Row(
              children: [
                Text('小恐龙', style: lcdText()),
                const Spacer(),
                Text('最好 ${five(math.max(top, score))}', style: lcdText()),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 4, 4, 0),
            child: Align(
              alignment: Alignment.centerRight,
              child: Text(five(score), style: lcdText()),
            ),
          ),
          const SizedBox(height: 8),
          DecoratedBox(
            decoration: const BoxDecoration(boxShadow: [BoxShadow(color: Lcd.ink, spreadRadius: 2)]),
            child: SizedBox(
              width: dinoWidth * zoom,
              height: dinoHeight * zoom,
              child: Stack(
                children: [
                  Positioned.fill(child: CustomPaint(painter: _RunPainter(d, zoom))),
                  if (!_playing)
                    Positioned.fill(
                      child: Center(
                        child: Container(
                          color: Lcd.paper,
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text('${d?.over ?? false ? '撞上了' : '小恐龙'} · ', style: lcdText()),
                              Blink(child: Text('按 A ${d?.over ?? false ? '再来' : '开始'}', style: lcdText())),
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
              'A 或 ↑ 跳，↓ 或 B 蹲\n跑得越远越快，后面会有鸟',
              textAlign: TextAlign.center,
              style: lcdText(color: Lcd.dark, height: 1.625),
            ),
          ),
        ],
      ),
    );
  }
}

class _RunPainter extends CustomPainter {
  _RunPainter(this.d, this.zoom);
  final Dino? d;
  final double zoom;

  @override
  void paint(Canvas canvas, Size size) {
    canvas.scale(zoom);
    final p = Paint()..isAntiAlias = false;
    canvas.drawRect(const Rect.fromLTWH(0, 0, dinoWidth * 1.0, dinoHeight * 1.0), p..color = Lcd.paper);
    final run0 = d ?? newDino(0);
    canvas.drawRect(const Rect.fromLTWH(0, dinoGround * 1.0, dinoWidth * 1.0, 1), p..color = Lcd.dark);
    p.color = Lcd.mid;
    final walked = run0.distance.floor();
    for (var x = -(walked % 23); x < dinoWidth; x += 23) {
      canvas.drawRect(Rect.fromLTWH(x + 4.0, dinoGround + 3.0, 2, 1), p);
    }
    for (var x = -((walked * 2) % 37); x < dinoWidth; x += 37) {
      canvas.drawRect(Rect.fromLTWH(x + 20.0, dinoGround + 5.0, 1, 1), p);
    }
    for (final o in run0.obstacles) {
      drawPattern(canvas, _picture(o, run0.time), o.x, o.y);
    }
    final box = dinoBox(run0);
    final frame = (run0.time / 110).floor() % 2;
    final ducking = run0.ducking && run0.lift == 0;
    drawPattern(canvas, ducking ? _duck[frame] : _run[run0.lift > 0 ? 0 : frame], box.x, box.y);
  }

  @override
  bool shouldRepaint(_RunPainter old) => old.d != d || old.zoom != zoom;
}
