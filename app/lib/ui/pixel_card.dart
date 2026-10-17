// At screen pixels, so the words stay sharp at any scale.

import 'package:flutter/widgets.dart';

import 'theme.dart';
import '../sprites/atlas.dart';
import 'pixels.dart';

abstract final class CardColors {
  static const ink = Color(0xFF3A2A18);
  static const paper = Color(0xFFF3E2B8);
  static const muted = Color(0xFF7A6248);
  static const good = Color(0xFF3F6B2A);
  static const lightInk = Color(0xFFFFF3DC);
  static const wood = Color(0xFFB07A45);
  static const held = Color(0xFFB4CB7C);
  static const slot = Color(0xFFEEDCB2);
  static const ripe = Color(0xFFE8B84A);
  static const bug = Color(0xFFC8543C);
  static const stuck = Color(0xFF5D8FB0);
  static const rest = Color(0xFFCDBB92);
  static const barFill = Color(0xFF7EA64F);
  static const barTrack = Color(0xFFE2C995);
}

sealed class Piece {
  const Piece();
}

final class Words extends Piece {
  const Words(this.text, {this.color, this.size = 12});
  final String text;
  final Color? color;
  final double size;
}

final class Icon extends Piece {
  const Icon(this.sprite, this.px);
  final SpriteInfo sprite;
  final double px;
}

final class Glyph extends Piece {
  const Glyph(this.cells, this.px, {this.grid = const Size(10, 16)});
  final List<(int, int, int, int, Color)> cells;
  final double px;
  final Size grid;
}

final class Faces extends Piece {
  const Faces(this.looks, this.atlas, {this.px = 22});
  final List<String> looks;
  final SpriteAtlas atlas;
  final double px;
}

final class Bar extends Piece {
  const Bar(this.fill, {required this.w, required this.h, this.color = CardColors.barFill, this.track = CardColors.barTrack});
  final double fill;
  final double w;
  final double h;
  final Color color;
  final Color track;
}

const _border = 2.0;
const _drop = 2.0;
const _gap = 3.0;

class PixelCard extends StatelessWidget {
  const PixelCard({
    super.key,
    required this.rows,
    this.paper = CardColors.paper,
    this.ink = CardColors.ink,
    this.padX = 6,
    this.padY = 3,
    this.width,
    this.height,
    this.center = false,
    this.maxWidth,
    this.maxLines,
  });

  final List<List<Piece>> rows;
  final Color paper;
  final Color ink;
  final double padX;
  final double padY;

  /// Border included: HUD parts of one row share a size.
  final double? width;
  final double? height;
  final bool center;

  final double? maxWidth;
  final int? maxLines;

  Widget _piece(Piece p) => switch (p) {
    Words(:final text, :final color, :final size) => ConstrainedBox(
      constraints: BoxConstraints(maxWidth: maxWidth ?? double.infinity),
      child: Text(
        text,
        maxLines: maxLines,
        overflow: maxLines == null ? null : TextOverflow.ellipsis,
        textAlign: center ? TextAlign.center : TextAlign.start,
        style: TextStyle(fontFamily: pixelFont, fontSize: size, height: (size + 2) / size, color: color ?? ink),
      ),
    ),
    Icon(:final sprite, :final px) => SizedBox(
      height: px,
      width: px * sprite.w / sprite.h,
      child: Image.asset(sprite.asset, filterQuality: FilterQuality.none, fit: BoxFit.fill),
    ),
    Glyph(:final cells, :final px, :final grid) => SizedBox(
      width: px * grid.width / grid.height,
      height: px,
      child: CustomPaint(painter: _GlyphPainter(cells, grid)),
    ),
    Faces(:final looks, :final atlas, :final px) => SizedBox(
      width: looks.isEmpty ? 0 : px + (looks.length - 1) * (px - 10),
      height: px,
      child: Stack(
        children: [
          for (var i = looks.length - 1; i >= 0; i--)
            Positioned(
              left: i * (px - 10),
              child: AnimalFace(atlas: atlas, look: looks[i], size: px),
            ),
        ],
      ),
    ),
    Bar(:final fill, :final w, :final h, :final color, :final track) => SizedBox(
      width: w,
      height: h,
      child: ColoredBox(
        color: track,
        child: Align(
          alignment: Alignment.centerLeft,
          child: SizedBox(
            width: (w * ((fill.clamp(0, 1) * 20).round() / 20)).roundToDouble(),
            height: h,
            child: ColoredBox(color: color),
          ),
        ),
      ),
    ),
  };

  @override
  Widget build(BuildContext context) {
    final content = Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: center ? CrossAxisAlignment.center : CrossAxisAlignment.start,
      children: [
        for (final row in rows)
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              for (var i = 0; i < row.length; i++) ...[if (i > 0) const SizedBox(width: _gap), _piece(row[i])],
            ],
          ),
      ],
    );
    return Padding(
      padding: const EdgeInsets.only(right: _drop, bottom: _drop),
      child: Container(
        constraints: BoxConstraints(minWidth: width ?? 0, minHeight: height ?? 0),
        decoration: BoxDecoration(
          color: paper,
          border: Border.all(color: CardColors.ink, width: _border),
          boxShadow: [BoxShadow(color: CardColors.ink.withValues(alpha: 0.6), offset: const Offset(_drop, _drop))],
        ),
        padding: EdgeInsets.symmetric(horizontal: padX, vertical: padY),
        child: center || width != null || height != null ? Center(widthFactor: 1, heightFactor: 1, child: content) : content,
      ),
    );
  }
}

class _GlyphPainter extends CustomPainter {
  _GlyphPainter(this.cells, this.grid);
  final List<(int, int, int, int, Color)> cells;
  final Size grid;

  @override
  void paint(Canvas canvas, Size size) {
    final k = size.height / grid.height;
    for (final (x, y, w, h, c) in cells) {
      canvas.drawRect(Rect.fromLTWH(x * k, y * k, w * k, h * k), Paint()..color = c);
    }
  }

  @override
  bool shouldRepaint(_GlyphPainter old) => false;
}
