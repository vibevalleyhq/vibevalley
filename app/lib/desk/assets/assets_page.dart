import 'package:flutter/material.dart';

import '../../ui/kit/kit.dart';
import 'assets_data.dart';
import '../../shared/widgets.dart';
import 'cursors_shelf.dart';
import 'sounds_shelf.dart';
import 'sprites_shelf.dart';

enum Ground {
  check('格子'),
  grass('草地'),
  night('夜里');

  const Ground(this.label);
  final String label;
}

class GroundBox extends StatelessWidget {
  const GroundBox({super.key, required this.ground, required this.child, this.padding = EdgeInsets.zero});
  final Ground ground;
  final Widget child;
  final EdgeInsets padding;

  @override
  Widget build(BuildContext context) => CustomPaint(
    painter: _GroundPainter(ground),
    child: Padding(padding: padding, child: child),
  );
}

class _GroundPainter extends CustomPainter {
  _GroundPainter(this.ground);
  final Ground ground;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Offset.zero & size;
    switch (ground) {
      case Ground.grass:
        canvas.drawRect(r, Paint()..color = const Color(0xFF7A9A4A));
      case Ground.night:
        canvas.drawRect(r, Paint()..color = const Color(0xFF22283A));
      case Ground.check:
        canvas.drawRect(r, Paint()..color = const Color(0xFFF3E9D2));
        final dark = Paint()..color = const Color(0xFFE4D6B6);
        canvas.save();
        canvas.clipRect(r);
        for (var y = 0.0; y < size.height; y += 6) {
          for (var x = ((y ~/ 6).isEven ? 6.0 : 0.0); x < size.width; x += 12) {
            canvas.drawRect(Rect.fromLTWH(x, y, 6, 6), dark);
          }
        }
        canvas.restore();
    }
  }

  @override
  bool shouldRepaint(_GroundPainter old) => old.ground != ground;
}

const _shelfTabs = [('sprites', '图', '/assets'), ('cursors', '指针', '/assets/cursors'), ('sounds', '音效', '/assets/sounds')];

class AssetsPage extends StatelessWidget {
  const AssetsPage({super.key, required this.shelf, this.id});

  final String shelf;
  final String? id;

  @override
  Widget build(BuildContext context) {
    final header = PxWindow(
      paper: Palette.cream50,
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      child: Wrap(
        spacing: 12,
        runSpacing: 8,
        alignment: WrapAlignment.spaceBetween,
        crossAxisAlignment: WrapCrossAlignment.center,
        children: [
          Text.rich(
            TextSpan(
              text: '图鉴',
              children: [
                TextSpan(
                  text: ' 农场用的每张图、每个指针、每个声音',
                  style: KitText.sm.copyWith(color: Palette.bark500),
                ),
              ],
            ),
            style: KitText.xl,
          ),
          Semantics(
            label: '图鉴的书架',
            container: true,
            child: Container(
              color: Palette.cream200,
              padding: const EdgeInsets.all(4),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  for (final (tab, label, path) in _shelfTabs)
                    KitTappable(
                      onTap: () => deskGo(context, path),
                      selected: shelf == tab,
                      builder: (context, s) => Container(
                        foregroundDecoration: pxRing,
                        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 4),
                        color: shelf == tab
                            ? Palette.leaf500
                            : s.hovered
                            ? Palette.cream300
                            : null,
                        child: Text(label, style: KitText.sm.copyWith(color: shelf == tab ? Palette.cream50 : Palette.bark800)),
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
    final body = switch (shelf) {
      'cursors' => const CursorsShelf(),
      'sounds' => const SoundsShelf(),
      _ => SpritesShelf(id: id),
    };
    return LayoutBuilder(
      builder: (context, box) {
        final gap = box.maxWidth >= 640 ? 12.0 : 8.0;
        return Padding(
          padding: EdgeInsets.fromLTRB(gap, 0, gap, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              header,
              const SizedBox(height: 12),
              Expanded(child: body),
            ],
          ),
        );
      },
    );
  }
}

/// Whole steps, so its pixels stay square.
double fitScale(Picture p, double box) {
  final k = box / (p.w > p.h ? p.w : p.h);
  return k >= 1 ? k.floorToDouble() : k;
}

class AssetImg extends StatelessWidget {
  const AssetImg(this.picture, this.scale, {super.key});
  final Picture picture;
  final double scale;

  @override
  Widget build(BuildContext context) => Image.asset(
    picture.asset,
    width: (picture.w * scale).roundToDouble(),
    height: (picture.h * scale).roundToDouble(),
    fit: BoxFit.fill,
    filterQuality: FilterQuality.none,
    isAntiAlias: false,
    gaplessPlayback: true,
    errorBuilder: (_, _, _) => SizedBox(width: picture.w * scale, height: picture.h * scale),
  );
}

List<Widget> gapped(List<Widget> items) => [
  for (var i = 0; i < items.length; i++) ...[if (i > 0) const SizedBox(height: 12), items[i]],
];
