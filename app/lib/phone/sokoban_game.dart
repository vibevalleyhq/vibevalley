// 推箱子 on the farm phone (web/src/phone/Sokoban.tsx). The warehouse is kept while the phone is away or a call
// comes in.

import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../shell/sfx.dart';
import 'lcd.dart';
import 'pad.dart';
import 'sokoban.dart';

final warehouseProvider = NotifierProvider<Kept<WarehouseGame>, WarehouseGame>(() => Kept(newWarehouse()));

class SokobanGame extends ConsumerStatefulWidget {
  const SokobanGame({super.key, required this.pad});
  final Pad pad;

  @override
  ConsumerState<SokobanGame> createState() => _SokobanGameState();
}

class _SokobanGameState extends ConsumerState<SokobanGame> with PadGame {
  @override
  Pad get pad => widget.pad;

  WarehouseGame get _g => ref.read(warehouseProvider);
  void _set(WarehouseGame g) => ref.read(warehouseProvider.notifier).set(g);
  bool get _last => _g.level == warehouses.length - 1;
  void _restart() => _set(newWarehouse(_g.level));
  void _advance() => _set(newWarehouse(_last ? 0 : _g.level + 1));
  void _undo() => _set(undoWarehouse(_g));

  @override
  void onPad(PadButton button, bool down) {
    if (!down) return;
    final g = _g;
    switch (button) {
      case PadButton.a:
        warehouseDone(g) ? _advance() : _restart();
      case PadButton.b:
        _undo();
      case PadButton.left || PadButton.right || PadButton.up || PadButton.down:
        final next = moveWarehouse(g, WarehouseDirection.values.byName(button.name));
        if (identical(next, g)) return;
        if (warehouseDone(next)) {
          Sfx.play('coin');
        } else if (next.pushes > g.pushes) {
          Sfx.play('thud');
        }
        _set(next);
    }
  }

  @override
  Widget build(BuildContext context) {
    final g = ref.watch(warehouseProvider);
    final done = warehouseDone(g);
    final last = g.level == warehouses.length - 1;
    final level = warehouses[g.level];
    final width = level.rows[0].length;
    final cells = level.rows.join();
    final placed = g.boxes.where((p) => cells[p] == '.').length;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text('推箱子 ${g.level + 1}/${warehouses.length}', style: lcdText()),
              const Spacer(),
              Text('${g.moves} 步 · ${g.pushes} 推', style: lcdText()),
            ],
          ),
          const SizedBox(height: 8),
          Text(level.name, textAlign: TextAlign.center, style: lcdText()),
          const SizedBox(height: 8),
          LayoutBuilder(
            builder: (context, box) {
              final w = math.min(box.maxWidth, 224.0);
              return Center(
                child: Semantics(
                  label: '仓库棋盘，$placed/${g.boxes.length} 箱已归位',
                  image: true,
                  child: SizedBox(
                    width: w,
                    height: w * level.rows.length / width,
                    child: CustomPaint(painter: _WarehousePainter(g)),
                  ),
                ),
              );
            },
          ),
          const SizedBox(height: 8),
          Semantics(
            liveRegion: true,
            child: Text(done ? (last ? '收成全部入仓！' : '这一仓收拾好了！') : '把木箱推到 ◆ 上', textAlign: TextAlign.center, style: lcdText()),
          ),
          const Spacer(),
          Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              _Key('B 撤销', g.history.isEmpty ? null : _undo),
              const SizedBox(width: 12),
              _Key('A ${done ? (last ? '再玩一轮' : '下一关') : '重开'}', done ? _advance : _restart),
            ],
          ),
          const SizedBox(height: 8),
          Text(
            '方向键走动 · 箱子只能推',
            textAlign: TextAlign.center,
            style: lcdText(color: Lcd.dark),
          ),
        ],
      ),
    );
  }
}

class _Key extends StatelessWidget {
  const _Key(this.label, this.onTap);
  final String label;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: onTap == null ? 0.4 : 1,
    child: GestureDetector(
      onTap: onTap,
      child: MouseRegion(
        cursor: onTap == null ? MouseCursor.defer : SystemMouseCursors.click,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          decoration: BoxDecoration(border: Border.all(color: Lcd.ink)),
          child: Text(label, style: lcdText()),
        ),
      ),
    ),
  );
}

/// The board as the web page's SVG draws it: 16 units a tile, scaled to the box.
class _WarehousePainter extends CustomPainter {
  _WarehousePainter(this.g);
  final WarehouseGame g;

  @override
  void paint(Canvas canvas, Size size) {
    final rows = warehouses[g.level].rows;
    final width = rows[0].length;
    canvas.scale(size.width / (width * 16));
    final fill = Paint()..isAntiAlias = false;
    final line = Paint()
      ..isAntiAlias = false
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    for (var y = 0; y < rows.length; y++) {
      for (var x = 0; x < width; x++) {
        final tile = rows[y][x];
        final p = y * width + x;
        canvas
          ..save()
          ..translate(x * 16.0, y * 16.0);
        canvas.drawRect(const Rect.fromLTWH(0, 0, 16, 16), fill..color = tile == '#' ? Lcd.dark : Lcd.light);
        if (tile == '#') {
          canvas.drawPath(
            Path()
              ..moveTo(0, 7)
              ..lineTo(16, 7)
              ..moveTo(7, 0)
              ..lineTo(7, 7)
              ..moveTo(3, 8)
              ..lineTo(3, 16),
            line..color = Lcd.ink,
          );
        } else {
          canvas.drawRect(const Rect.fromLTWH(1, 1, 14, 14), fill..color = Lcd.paper);
        }
        if (tile == '.') {
          canvas.drawPath(
            Path()
              ..moveTo(8, 4)
              ..lineTo(12, 8)
              ..lineTo(8, 12)
              ..lineTo(4, 8)
              ..close(),
            fill..color = Lcd.mid,
          );
        }
        if (g.boxes.contains(p)) {
          const box = Rect.fromLTWH(2, 2, 12, 12);
          canvas
            ..drawRect(box, fill..color = tile == '.' ? Lcd.mid : Lcd.dark)
            ..drawRect(box, line..color = Lcd.ink)
            ..drawPath(
              Path()
                ..moveTo(4, 4)
                ..lineTo(12, 12)
                ..moveTo(12, 4)
                ..lineTo(4, 12),
              line..color = Lcd.paper,
            );
          if (tile == '.') canvas.drawRect(const Rect.fromLTWH(6, 6, 4, 4), fill..color = Lcd.ink);
        }
        if (g.player == p) {
          // M5 2h6v3H3v2h10V5h-2 M5 8h6v5H5z M4 13h3v2H4z m5 0h3v2H9z
          canvas
            ..drawPath(
              Path()
                ..moveTo(5, 2)
                ..lineTo(11, 2)
                ..lineTo(11, 5)
                ..lineTo(3, 5)
                ..lineTo(3, 7)
                ..lineTo(13, 7)
                ..lineTo(13, 5)
                ..lineTo(11, 5)
                ..addRect(const Rect.fromLTWH(5, 8, 6, 5))
                ..addRect(const Rect.fromLTWH(4, 13, 3, 2))
                ..addRect(const Rect.fromLTWH(9, 13, 3, 2)),
              fill..color = Lcd.ink,
            )
            ..drawRect(const Rect.fromLTWH(6, 5, 4, 3), fill..color = Lcd.paper);
        }
        canvas.restore();
      }
    }
  }

  @override
  bool shouldRepaint(_WarehousePainter old) => old.g != g;
}
