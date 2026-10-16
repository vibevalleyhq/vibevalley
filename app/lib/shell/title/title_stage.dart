// The motions stop for those who ask for less motion.

import 'dart:math' as math;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../prefs.dart';
import 'layers.dart';
import 'motion.dart';
import 'scene.dart';

class TitleStage extends ConsumerStatefulWidget {
  const TitleStage({super.key, required this.scene});
  final TitleScene scene;

  @override
  ConsumerState<TitleStage> createState() => _TitleStageState();
}

class _TitleStageState extends ConsumerState<TitleStage> with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  double _t = 0;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker((elapsed) => setState(() => _t = elapsed.inMicroseconds / 1e6))..start();
  }

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final sizes = ref.watch(titleSpritesProvider).value;
    final pet = ref.watch(prefsProvider.select((p) => p.petOrDog));
    final still = MediaQuery.maybeDisableAnimationsOf(context) ?? false;
    final t = still ? 0.0 : _t;
    return LayoutBuilder(
      builder: (context, box) {
        // As wide as the screen, or wider to keep 3:2 at its height; centred.
        final w = math.max(box.maxWidth, box.maxHeight * 1.5);
        final h = w / 1.5;
        return ClipRect(
          child: OverflowBox(
            maxWidth: w,
            maxHeight: h,
            child: SizedBox(
              width: w,
              height: h,
              child: _Pan(t: t, size: Size(w, h), child: _layers(sizes, pet, t, still, w, h)),
            ),
          ),
        );
      },
    );
  }

  Widget _layers(TitleSprites? sizes, String pet, double t, bool still, double w, double h) {
    final scene = widget.scene;
    final light = lights[scene]!;
    final picture = Positioned.fill(
      child: Image.asset(titleBackground(scene), fit: BoxFit.fill, filterQuality: FilterQuality.none, gaplessPlayback: true),
    );
    if (sizes == null) return Stack(children: [picture]);
    Widget sprite(String name, double width, List<Css> filter) {
      Widget img = Image.asset(titleSpriteAsset(name), width: width, filterQuality: FilterQuality.none, gaplessPlayback: true);
      final f = cssFilter(filter);
      if (f != null) img = ColorFiltered(colorFilter: f, child: img);
      return img;
    }

    final motes = motesOf(scene);
    return Stack(
      clipBehavior: Clip.none,
      children: [
        picture,
        for (final c in clouds)
          () {
            final s = spriteShare(sizes, c.sprite, c.scale);
            final left = cssKeyframes([(0, -0.4), (1, 1.05)], cssProgress(t, c.duration, delay: c.delay));
            return Positioned(left: left * w, top: c.y * h, child: sprite(c.sprite, s.w * w, light.sky));
          }(),
        if (!still)
          for (var i = 0; i < puffs.length; i++)
            () {
              final puff = puffs[i];
              final s = spriteShare(sizes, puff.sprite, puff.scale);
              final p = cssProgress(t, puffSeconds, delay: -(i * puffSeconds) / puffs.length);
              final x = chimney.x + cssKeyframes([(0, 0), (0.3, 0.004), (0.6, 0.018), (1, 0.04)], p);
              final y = chimney.y + cssKeyframes([(0, 0.014), (0.3, -0.05), (0.6, -0.1), (1, -0.16)], p);
              final scale = cssKeyframes([(0, 0.4), (0.3, 0.75), (1, 1.3)], p);
              final opacity = cssKeyframes([(0, 0), (0.04, 0.95), (0.6, 0.7), (1, 0)], p);
              final pw = s.w * w, ph = pw * sizes[puff.sprite]!.h / sizes[puff.sprite]!.w;
              return Positioned(
                left: x * w - pw / 2,
                top: y * h - ph,
                child: Opacity(
                  opacity: opacity.clamp(0, 1),
                  child: Transform.scale(scale: scale, alignment: Alignment.bottomCenter, child: sprite(puff.sprite, pw, light.smoke)),
                ),
              );
            }(),
        if (light.seeds && !still)
          for (final seed in seeds)
            () {
              final s = spriteShare(sizes, seed.sprite, 0.22);
              final p = cssProgress(t, seed.duration, delay: seed.delay);
              final left = cssKeyframes([(0, seed.from), (1, seed.from + 0.75)], p, cssEaseInOut);
              final top = cssKeyframes([(0, 0.86), (0.35, 0.66), (0.65, 0.54), (1, 0.3)], p, cssEaseInOut);
              final opacity = cssKeyframes([(0, 0), (0.06, 1), (0.9, 1), (1, 0)], p, cssEaseInOut);
              final spin = cssKeyframes([(0, -18), (1, 14)], cssProgress(t, 3, delay: seed.delay, alternate: true), cssEaseInOut);
              return Positioned(
                left: left * w,
                top: top * h,
                child: Opacity(
                  opacity: opacity.clamp(0, 1),
                  child: Transform.rotate(angle: spin * math.pi / 180, child: sprite(seed.sprite, s.w * w, light.ground)),
                ),
              );
            }(),
        for (var i = 0; i < motes.length; i++) _Firefly(mote: motes[i], index: i, t: t, w: w, h: h),
        _farmer(sizes, t, w, h),
        _pet(sizes, pet, t, w, h),
        for (var i = 0; i < plants.length; i++)
          () {
            final plant = plants[i];
            final s = spriteShare(sizes, plant.sprite, plant.scale);
            final lean = cssKeyframes([(0, -plant.lean), (1, plant.lean)], cssProgress(t, plant.sway, delay: -i * 0.7, alternate: true), cssEaseInOut);
            return Positioned(
              left: (plant.x - s.w / 2) * w,
              bottom: 0,
              child: Transform.rotate(angle: lean * math.pi / 180, alignment: Alignment.bottomCenter, child: sprite(plant.sprite, s.w * w, light.ground)),
            );
          }(),
      ],
    );
  }

  Widget _farmer(TitleSprites sizes, double t, double w, double h) {
    final scene = widget.scene;
    final name = managerPose(scene);
    final s = spriteShare(sizes, name, manager.scale);
    final light = lights[scene]!;
    final filter = light.ground.isEmpty
        ? null
        : scene == TitleScene.night
        ? cssFilter(const [Brightness(0.6), Saturate(0.8)])
        : cssFilter(light.ground);
    Widget img = Image.asset(titleSpriteAsset(name), fit: BoxFit.fill, filterQuality: FilterQuality.none);
    if (filter != null) img = ColorFiltered(colorFilter: filter, child: img);
    final fw = s.w * w, fh = s.h * h;
    return Positioned(
      left: (manager.x - s.w / 2) * w,
      top: (manager.bottom - s.h) * h,
      width: fw,
      height: fh,
      child: _Breathe(
        t: t,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Positioned.fill(child: img),
            if (scene == TitleScene.night) _Lantern(t: t, box: Size(fw, fh)),
          ],
        ),
      ),
    );
  }

  Widget _pet(TitleSprites sizes, String pet, double t, double w, double h) {
    final scene = widget.scene;
    final asleep = scene == TitleScene.night;
    final frame = asleep ? 'sleep' : _petFrame(t);
    final name = '$pet-$frame';
    final s = spriteShare(sizes, name, petScale[pet] ?? 0.59);
    final filter = asleep ? cssFilter(const [Brightness(0.55), Saturate(0.8)]) : cssFilter(lights[scene]!.ground);
    Widget img = Image.asset(titleSpriteAsset(name), width: s.w * w, filterQuality: FilterQuality.none, gaplessPlayback: true);
    if (filter != null) img = ColorFiltered(colorFilter: filter, child: img);
    if (frame == 'sleep') img = _Breathe(t: t, child: img);
    return Positioned(left: (petSpot.x - s.w / 2) * w, top: (petSpot.bottom - s.h) * h, child: img);
  }

  String _petFrame(double t) {
    final round = petRound.fold(0, (sum, f) => sum + f.ms);
    var at = (t * 1000).floor() % round;
    for (final f in petRound) {
      if (at < f.ms) return f.frame;
      at -= f.ms;
    }
    return 'sit';
  }
}

class _Pan extends StatelessWidget {
  const _Pan({required this.t, required this.size, required this.child});
  final double t;
  final Size size;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final p = cssProgress(t, 70, alternate: true);
    final dx = cssKeyframes([(0, -0.01), (1, 0.01)], p, cssEaseInOut) * size.width;
    final dy = cssKeyframes([(0, 0.005), (1, -0.006)], p, cssEaseInOut) * size.height;
    final origin = Offset(size.width * 0.6, size.height * 0.55);
    final m = Matrix4.identity()
      ..translateByDouble(origin.dx, origin.dy, 0, 1)
      ..scaleByDouble(1.05, 1.05, 1, 1)
      ..translateByDouble(dx - origin.dx, dy - origin.dy, 0, 1);
    return Transform(transform: m, child: child);
  }
}

class _Breathe extends StatelessWidget {
  const _Breathe({required this.t, required this.child});
  final double t;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final sy = cssKeyframes([(0, 1), (0.5, 1.015), (1, 1)], cssProgress(t, 3.2), cssEaseInOut);
    return Transform(alignment: Alignment.bottomCenter, transform: Matrix4.diagonal3Values(1, sy, 1), child: child);
  }
}

class _Lantern extends StatelessWidget {
  const _Lantern({required this.t, required this.box});
  final double t;
  final Size box;

  @override
  Widget build(BuildContext context) {
    final p = cssSteps(cssProgress(t, 2.4, alternate: true), 6);
    final opacity = 0.65 + (1 - 0.65) * p;
    final scale = 0.92 + (1.06 - 0.92) * p;
    final d = box.width * 0.34;
    return Positioned(
      left: box.width * 0.04 - d / 2,
      top: box.height * 0.7 - d / 2,
      width: d,
      height: d,
      // Opacity goes into the colours: a layer for it would keep the glow from screening the picture.
      child: Transform.scale(
        scale: scale,
        child: DecoratedBox(
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            backgroundBlendMode: BlendMode.screen,
            // Its radius reaches the box's corner, √2 of half the side.
            gradient: RadialGradient(
              radius: math.sqrt2 / 2,
              colors: [Color.fromRGBO(255, 210, 110, 0.55 * opacity), Color.fromRGBO(255, 170, 60, 0.2 * opacity), const Color(0x00000000)],
              stops: const [0, 0.45, 0.7],
            ),
          ),
        ),
      ),
    );
  }
}

class _Firefly extends StatelessWidget {
  const _Firefly({required this.mote, required this.index, required this.t, required this.w, required this.h});
  final Mote mote;
  final int index;
  final double t;
  final double w;
  final double h;

  @override
  Widget build(BuildContext context) {
    final p = cssProgress(t, mote.duration, delay: mote.delay, alternate: true);
    final dx = cssKeyframes([(0, -10), (1, 14)], p, cssEaseInOut);
    final dy = cssKeyframes([(0, 6), (1, -12)], p, cssEaseInOut);
    final blink = cssKeyframes([(0, 0.15), (1, 1)], cssProgress(t, 1.6 + (index % 5) * 0.4, delay: mote.delay, alternate: true), cssEaseInOut);
    return Positioned(
      left: mote.x / 100 * w + dx,
      top: mote.y / 100 * h + dy,
      width: mote.size,
      height: mote.size,
      child: Opacity(
        opacity: blink,
        child: const DecoratedBox(
          decoration: BoxDecoration(
            color: Color(0xFFFFF1A0),
            boxShadow: [BoxShadow(color: Color.fromRGBO(255, 214, 90, 0.75), blurRadius: 6, spreadRadius: 2)],
          ),
        ),
      ),
    );
  }
}
