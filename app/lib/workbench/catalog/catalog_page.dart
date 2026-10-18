import 'package:flutter/material.dart';

import '../../ui/kit/kit.dart';
import 'catalog_data.dart';
import '../shared/widgets.dart';
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

const _shelfTabs = [('sprites', '图', '/catalog'), ('cursors', '指针', '/catalog/cursors'), ('sounds', '音效', '/catalog/sounds')];

class CatalogPage extends StatelessWidget {
  const CatalogPage({super.key, required this.shelf, this.id});

  final String shelf;
  final String? id;

  @override
  Widget build(BuildContext context) {
    // The shelves sit atop the left column, where the sprites shelf lists its kinds; the page title already says what this is.
    final tabs = Semantics(
      label: '图鉴的书架',
      container: true,
      child: Container(
        color: Palette.cream200,
        padding: const EdgeInsets.all(4),
        child: Row(
          children: [
            for (final (tab, label, path) in _shelfTabs)
              Expanded(
                child: KitTappable(
                  onTap: () => workbenchGo(context, path),
                  selected: shelf == tab,
                  builder: (context, s) => Container(
                    alignment: Alignment.center,
                    padding: const EdgeInsets.symmetric(vertical: 4),
                    color: shelf == tab
                        ? Palette.leaf500
                        : s.hovered
                        ? Palette.cream300
                        : null,
                    child: Text(label, style: KitText.sm.copyWith(color: shelf == tab ? Palette.cream50 : Palette.bark800)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
    final body = switch (shelf) {
      'cursors' => CursorsShelf(tabs: tabs),
      'sounds' => SoundsShelf(tabs: tabs),
      _ => SpritesShelf(id: id, tabs: tabs),
    };
    return LayoutBuilder(
      builder: (context, box) {
        final gap = box.maxWidth >= 640 ? 12.0 : 8.0;
        return Padding(
          padding: EdgeInsets.fromLTRB(gap, 0, gap, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
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

/// A card's frame and shadow sit 2 px outside it (PxWindow); a list that starts at its edge would cut them off.
const catalogFramed = EdgeInsets.fromLTRB(4, 4, 6, 8);

/// The left column every shelf has, so switching shelves never moves the picker: the shelves on top, then [below].
class ShelfColumn extends StatelessWidget {
  const ShelfColumn({super.key, required this.tabs, required this.below});
  final Widget? tabs;
  final List<Widget> below;

  @override
  Widget build(BuildContext context) => PxWindow(
    paper: Palette.cream50,
    padding: const EdgeInsets.all(8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (tabs case final tabs?) ...[tabs, const SizedBox(height: 8)],
        ...below,
      ],
    ),
  );
}

/// The left column beside the shelf's own content, at the widths the sprites shelf uses; one column on a phone.
Widget shelfLayout(BuildContext context, {required Widget left, required List<Widget> body}) {
  if (MediaQuery.sizeOf(context).width >= 1024) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 240,
          child: SingleChildScrollView(padding: catalogFramed, child: left),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: ListView(padding: catalogFramed, children: gapped(body)),
        ),
      ],
    );
  }
  return ListView(padding: catalogFramed, children: gapped([left, ...body]));
}

/// The search row atop every shelf's content, in one place and one shape; [ground] only where there are tiles to lay on it.
class ShelfSearch extends StatelessWidget {
  const ShelfSearch({super.key, required this.query, required this.onChanged, required this.placeholder, this.ground, this.onGround});
  final String query;
  final ValueChanged<String> onChanged;
  final String placeholder;
  final Ground? ground;
  final ValueChanged<Ground>? onGround;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 4),
    child: LayoutBuilder(
      builder: (context, box) {
        final find = PxTextInput(value: query, onChanged: onChanged, placeholder: placeholder, icon: 'button-search', semanticLabel: '找素材');
        final pick = ground;
        if (pick == null) return find;
        final picker = GroundPick(value: pick, onChanged: onGround ?? (_) {});
        // The ground picker needs about 200 px; under it on a phone.
        if (box.maxWidth < 480) {
          return Column(crossAxisAlignment: CrossAxisAlignment.start, children: [find, const SizedBox(height: 8), picker]);
        }
        return Row(
          children: [
            Expanded(child: find),
            const SizedBox(width: 8),
            picker,
          ],
        );
      },
    ),
  );
}
