import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../audio/sfx.dart';
import 'lcd.dart';
import 'merge.dart';
import 'pad.dart';
import 'widgets.dart';

final mergeGameProvider = NotifierProvider<Kept<Merge?>, Merge?>(() => Kept(null));
final mergeBestProvider = NotifierProvider<Kept<int>, int>(() => Kept(0));

/// 12×12: `#` ink, `+` dark, `o` mid, `.` light.
const _pictures = [
  // 种子
  [
    '            ',
    '            ',
    '            ',
    '            ',
    '            ',
    '     ##     ',
    '    #oo#    ',
    '    #o.#    ',
    '    #oo#    ',
    '     ##     ',
    ' +o++++o++o ',
    '++++++++++++',
  ],
  // 芽
  [
    '            ',
    '            ',
    '            ',
    '            ',
    '  ##   ##   ',
    ' #oo# #oo#  ',
    '  #oo#oo#   ',
    '   ##+##    ',
    '     +      ',
    '     +      ',
    ' +o+++++o++ ',
    '++++++++++++',
  ],
  // 叶
  [
    '            ',
    '     #      ',
    '    #o#     ',
    '    #o#     ',
    '  ## + ##   ',
    ' #oo#+#oo#  ',
    ' #o.o+o.o#  ',
    '  ###+###   ',
    '     +      ',
    '     +      ',
    ' +o+++++o++ ',
    '++++++++++++',
  ],
  // 花
  [
    '   ## ##    ',
    '  #..#..#   ',
    '   ##o##    ',
    '  #..#..#   ',
    '   ##+##    ',
    '  ## + ##   ',
    ' #oo#+#oo#  ',
    '  ##o+o##   ',
    '     +      ',
    '     +      ',
    ' +o+++++o++ ',
    '++++++++++++',
  ],
  // 麦子
  [
    '  .   .   . ',
    ' #o# #o# #o#',
    ' o#o o#o o#o',
    ' #o# #o# #o#',
    ' o#o o#o o#o',
    '  +   +   + ',
    '  +   +   + ',
    '  +   +   + ',
    '  +   +   + ',
    '  +   +   + ',
    ' ++o++++o+++',
    '++++++++++++',
  ],
  // 胡萝卜
  [
    '  #  #  #   ',
    '   # # #    ',
    '    ###     ',
    '  #######   ',
    '  #ooooo#   ',
    '  #o+ooo#   ',
    '   #ooo+#   ',
    '   #oooo#   ',
    '    #o+#    ',
    '    #oo#    ',
    '     #o#    ',
    '     ##     ',
  ],
  // 麦捆
  [
    '  o. o. .o  ',
    ' #o#o#o#o#  ',
    '  #o#o#o#   ',
    '   #+++#    ',
    '   #+++#    ',
    '   #####    ',
    '   #...#    ',
    '   #+++#    ',
    '  #+++++#   ',
    ' #+++++++#  ',
    ' #+#+#+#+#  ',
    '            ',
  ],
  // 一筐
  [
    '            ',
    '    ####    ',
    '   #    #   ',
    '  # .oo. #  ',
    ' #oo.oo.oo# ',
    '############',
    ' #+.+.+.+.# ',
    ' #.+.+.+.+# ',
    '  #+.+.+.#  ',
    '  ########  ',
    '            ',
    '            ',
  ],
  // 一车
  [
    '            ',
    '  o.oo.o    ',
    ' #oooooo#   ',
    '##########  ',
    '#++++++++###',
    '#++++++++#  ',
    '##########  ',
    ' ##    ##   ',
    '#..#  #..#  ',
    '#..#  #..#  ',
    ' ##    ##   ',
    '            ',
  ],
  // 粮仓
  [
    '     ##     ',
    '    #++#    ',
    '   #++++#   ',
    '  #++++++#  ',
    ' #++++++++# ',
    '############',
    ' #oooooooo# ',
    ' #o#....#o# ',
    ' #o.#..#.o# ',
    ' #o..##..o# ',
    ' #o.#..#.o# ',
    '############',
  ],
  // 丰收
  [
    '    ####    ',
    '  ##oooo##  ',
    ' #ooo..ooo# ',
    '#oo......oo#',
    '#oooo..oooo#',
    '#ooo....ooo#',
    '#oooo..oooo#',
    '#oo......oo#',
    ' #ooo..ooo# ',
    '  ##o..o##  ',
    '    ####    ',
    '            ',
  ],
];

Color? _ink(String c) => switch (c) {
  '#' => Lcd.ink,
  '+' => Lcd.dark,
  'o' => Lcd.mid,
  '.' => Lcd.light,
  _ => null,
};

class _RowsPainter extends CustomPainter {
  _RowsPainter(this.rows, this.grid);
  final List<String> rows;
  final int grid;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / grid;
    final p = Paint()..isAntiAlias = false;
    for (var y = 0; y < rows.length; y++) {
      for (var x = 0; x < rows[y].length; x++) {
        final c = _ink(rows[y][x]);
        if (c != null) canvas.drawRect(Rect.fromLTWH(x * k, y * k, k, k), p..color = c);
      }
    }
  }

  @override
  bool shouldRepaint(_RowsPainter old) => old.rows != rows || old.grid != grid;
}

class _Crop extends StatelessWidget {
  const _Crop(this.stage, this.size, {this.faint = false});
  final int stage;
  final double size;
  final bool faint;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: faint ? 0.25 : 1,
    child: SizedBox.square(
      dimension: size,
      child: CustomPaint(painter: _RowsPainter(_pictures[math.min(stage, mergeGoal) - 1], 12)),
    ),
  );
}

const _tile = 60.0;
const _gap = 4.0;

const _swipe = 16.0;

class MergeGame extends ConsumerStatefulWidget {
  const MergeGame({super.key, required this.pad});
  final Pad pad;

  @override
  ConsumerState<MergeGame> createState() => _MergeGameState();
}

class _MergeGameState extends ConsumerState<MergeGame> with PadGame {
  bool _cheer = false;

  bool _asking = false;
  Offset _drag = Offset.zero;

  @override
  Pad get pad => widget.pad;

  Merge? get _g => ref.read(mergeGameProvider);
  void _set(Merge g) => ref.read(mergeGameProvider.notifier).set(g);

  void _start() {
    _set(newMerge(math.Random().nextInt(1 << 31)));
    setState(() => _cheer = _asking = false);
    Sfx.play('plant');
  }

  void _slide(MergeDirection direction) {
    final g = _g;
    if (g == null || g.over || _cheer || _asking) return;
    final next = slideMerge(g, direction);
    if (identical(next, g)) return;
    final was = mergeTop(g);
    final now = mergeTop(next);
    if (next.score > ref.read(mergeBestProvider)) ref.read(mergeBestProvider.notifier).set(next.score);
    if (now >= mergeGoal && was < mergeGoal) {
      setState(() => _cheer = true);
      Sfx.play('achievement');
    } else if (next.over) {
      Sfx.play('nope');
    } else if (now > was) {
      Sfx.play('ripe');
    } else {
      Sfx.play(next.grown.isNotEmpty ? 'pick' : 'tap');
    }
    _set(next);
  }

  void _back() {
    final g = _g;
    if (g?.previous == null) return;
    Sfx.play('shovel');
    setState(() => _cheer = false);
    _set(undoMerge(g!));
  }

  @override
  void onPad(PadButton button, bool down) {
    if (!down) return;
    final g = _g;
    if (g == null) {
      if (button == PadButton.a) _start();
      return;
    }
    if (_asking) {
      if (button == PadButton.a) _start();
      if (button == PadButton.b) setState(() => _asking = false);
      return;
    }
    if (_cheer) {
      if (button == PadButton.a) setState(() => _cheer = false);
      return;
    }
    switch (button) {
      case PadButton.a:
        g.over ? _start() : setState(() => _asking = true);
      case PadButton.b:
        _back();
      case PadButton.left:
        _slide(MergeDirection.left);
      case PadButton.right:
        _slide(MergeDirection.right);
      case PadButton.up:
        _slide(MergeDirection.up);
      case PadButton.down:
        _slide(MergeDirection.down);
    }
  }

  void _swiped() {
    final d = _drag;
    _drag = Offset.zero;
    if (math.max(d.dx.abs(), d.dy.abs()) < _swipe) return;
    _slide(d.dx.abs() > d.dy.abs() ? (d.dx > 0 ? MergeDirection.right : MergeDirection.left) : (d.dy > 0 ? MergeDirection.down : MergeDirection.up));
  }

  @override
  Widget build(BuildContext context) {
    final g = ref.watch(mergeGameProvider);
    final top = ref.watch(mergeBestProvider);
    final reached = g == null ? 0 : mergeTop(g);
    final score = g?.score ?? 0;
    final board = g?.board ?? List.filled(mergeSize * mergeSize, 0);
    const side = mergeSize * _tile + (mergeSize + 1) * _gap;
    final overlay = g == null
        ? ('种田 2048', '按 A 开始')
        : _asking
        ? ('重新种这块地？', 'A 重开 · B 接着种')
        : _cheer
        ? ('丰收了！', '按 A 接着种')
        : g.over
        ? ('地种满了 · $score 分', '按 A 再来 · B 悔一步')
        : null;
    return Padding(
      padding: const EdgeInsets.fromLTRB(8, 8, 8, 0),
      child: Column(
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Row(
              children: [
                Text('种田 2048', style: lcdText()),
                const Spacer(),
                Text('最好 ${math.max(top, score)}', style: lcdText()),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4),
            child: Row(
              children: [
                Text('分数 $score', style: lcdText()),
                const Spacer(),
                Text(reached > 0 ? '种到 ${mergeStageName(reached)}' : '', style: lcdText()),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Semantics(
            label: g == null ? '种田 2048' : '田里：${board.where((c) => c != 0).length} 株，最高 ${mergeStageName(math.max(reached, 1))}',
            image: true,
            child: GestureDetector(
              onPanStart: (_) => _drag = Offset.zero,
              onPanUpdate: (d) => _drag += d.delta,
              onPanEnd: (_) => _swiped(),
              child: SizedBox.square(
                dimension: side,
                child: Stack(
                  children: [
                    Positioned.fill(
                      child: Container(
                        color: Lcd.dark,
                        padding: const EdgeInsets.all(_gap),
                        child: Column(
                          children: [
                            for (var y = 0; y < mergeSize; y++) ...[
                              if (y > 0) const SizedBox(height: _gap),
                              Row(
                                children: [
                                  for (var x = 0; x < mergeSize; x++) ...[
                                    if (x > 0) const SizedBox(width: _gap),
                                    _Tile(stage: board[y * mergeSize + x], grown: g?.grown.contains(y * mergeSize + x) ?? false),
                                  ],
                                ],
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                    if (overlay != null)
                      Positioned.fill(
                        child: ColoredBox(
                          color: Lcd.paper.withValues(alpha: 0.8),
                          child: Center(
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(overlay.$1, style: lcdText()),
                                Blink(child: Text(overlay.$2, style: lcdText())),
                              ],
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
          const SizedBox(height: 6),
          Semantics(
            label: '收成图鉴',
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                for (var s = 1; s <= mergeGoal; s++) ...[if (s > 1) const SizedBox(width: 2), _Crop(s, 24, faint: s > reached)],
              ],
            ),
          ),
          const Spacer(),
          Padding(
            padding: const EdgeInsets.only(bottom: 4),
            child: Text(
              '方向键或划一下：一样的两株长成下一样\nB 悔一步 · A 重开',
              textAlign: TextAlign.center,
              style: lcdText(color: Lcd.dark, height: 1.625),
            ),
          ),
        ],
      ),
    );
  }
}

class _Tile extends StatelessWidget {
  const _Tile({required this.stage, required this.grown});
  final int stage;
  final bool grown;

  @override
  Widget build(BuildContext context) => Container(
    width: _tile,
    height: _tile,
    decoration: BoxDecoration(
      color: stage > 0 ? Lcd.paper : Lcd.light,
      border: grown ? Border.all(color: Lcd.ink, width: 2) : null,
    ),
    child: stage > 0
        ? Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _Crop(stage, 36),
              Text(mergeStageName(stage), style: lcdText(height: 14 / 12)),
            ],
          )
        : null,
  );
}

class MergeIcon extends StatelessWidget {
  const MergeIcon({super.key});

  static const _tiles = [
    ['    ', ' ## ', ' ## ', '    '],
    ['#  #', ' ## ', ' #  ', ' #  '],
    [' ## ', '#  #', ' ## ', '  # '],
    ['# # ', '# # ', '+ + ', '+ + '],
  ];

  /// Each tile a dark frame round a 4×4 crop on the screen's paper.
  static final _rows = [
    for (var y = 0; y < 13; y++)
      [
        for (var x = 0; x < 13; x++)
          () {
            if (x == 6 || y == 6) return ' ';
            final t = (y ~/ 7) * 2 + x ~/ 7;
            final (ix, iy) = (x % 7 - 1, y % 7 - 1);
            if (ix < 0 || iy < 0 || ix > 3 || iy > 3) return '+';
            final c = _tiles[t][iy][ix];
            return c == ' ' ? 'p' : c;
          }(),
      ].join(),
  ];

  @override
  Widget build(BuildContext context) => SizedBox.square(dimension: 28, child: CustomPaint(painter: _IconPainter(_rows)));
}

class _IconPainter extends _RowsPainter {
  _IconPainter(List<String> rows) : super(rows, 13);

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.width / grid;
    final p = Paint()
      ..isAntiAlias = false
      ..color = Lcd.paper;
    for (var y = 0; y < rows.length; y++) {
      for (var x = 0; x < rows[y].length; x++) {
        if (rows[y][x] == 'p') canvas.drawRect(Rect.fromLTWH(x * k, y * k, k, k), p);
      }
    }
    super.paint(canvas, size);
  }
}
