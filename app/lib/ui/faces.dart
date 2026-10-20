import 'package:flutter/widgets.dart';
import '../sprites/atlas.dart';
import 'theme.dart';

class ManagerFace extends StatelessWidget {
  const ManagerFace({super.key, required this.atlas, required this.size, this.look = 'manager-face', this.fill = const Color(0xFFCFE6F5)});
  final SpriteAtlas atlas;
  final double size;
  final String look;
  final Color fill;

  @override
  Widget build(BuildContext context) {
    final sp = atlas.has(look) ? atlas[look] : atlas['manager-face'];
    final k = size / (sp.w * 0.86);
    return SizedBox.square(
      dimension: size,
      child: ClipRect(
        child: ColoredBox(
          color: fill,
          child: Stack(
            children: [
              Positioned(
                left: (size - sp.w * k) / 2,
                top: size * 0.04,
                width: sp.w * k,
                height: sp.h * k,
                child: Image.asset(sp.asset, filterQuality: FilterQuality.none, fit: BoxFit.fill),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class AnimalFace extends StatelessWidget {
  const AnimalFace({super.key, required this.atlas, required this.look, required this.size});
  final SpriteAtlas atlas;
  final String look;
  final double size;

  @override
  Widget build(BuildContext context) {
    final sp = atlas.has('$look-down') ? atlas['$look-down'] : atlas['bear-farmer-down'];
    final k = size / (sp.h * 0.5);
    final cx = sp.w / 2;
    final cy = sp.h * 0.25 + sp.h * 0.03;
    return SizedBox.square(
      dimension: size,
      child: ClipRect(
        child: ColoredBox(
          color: Palette.leaf300.withValues(alpha: 0.6),
          child: Stack(
            clipBehavior: Clip.hardEdge,
            children: [
              Positioned(
                left: size / 2 - cx * k,
                top: size / 2 - cy * k,
                width: sp.w * k,
                height: sp.h * k,
                child: Image.asset(sp.asset, filterQuality: FilterQuality.none, fit: BoxFit.fill),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
