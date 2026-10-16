// Faces and machines for the desk pages (web/src/farm/Face.tsx), reading the sprite atlas themselves:
//   AgentFace       an agent's animal in its clothes, cut round its head (AgentFace); muted is greyed out
//   DeskManagerFace the manager's portrait in the look the player chose (ManagerFace with useManagerLook)
//   RuntimeIcon     a runtime as a farm machine with its agent's logo pinned to the lower right (RuntimeIcon)
//   RuntimeLogo     a runtime's logo alone (RuntimeLogo)
//   PoseSprite      a helper's full-body sprite in a pose, moving as the engine's motions do (SpriteImg + POSE_MOTION)
// Each draws an empty box of its size until the atlas has loaded.

import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../app/theme.dart';
import '../../data/providers.dart';
import '../../gen/vibevalley.dart';
import '../../shell/prefs.dart';
import '../../sprites/atlas.dart';
import '../../ui/px.dart';
import 'looks.dart';
import '../../rules/looks.dart';

const _grey = ColorFilter.matrix([
  0.2126, 0.7152, 0.0722, 0, 0, //
  0.2126, 0.7152, 0.0722, 0, 0,
  0.2126, 0.7152, 0.0722, 0, 0,
  0, 0, 0, 1, 0,
]);

/// opacity + grayscale, as the page's `muted`.
Widget mutedBy(bool muted, double opacity, Widget child) => muted
    ? Opacity(
        opacity: opacity,
        child: ColorFiltered(colorFilter: _grey, child: child),
      )
    : child;

class AgentFace extends ConsumerWidget {
  const AgentFace({super.key, required this.look, required this.id, required this.size, this.muted = false});

  /// The agent's look; null for one without (an animal is picked from `id`).
  final Look? look;
  final String id;
  final double size;
  final bool muted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox.square(dimension: size);
    return mutedBy(muted, .6, AnimalFace(atlas: atlas, look: castPrefix(atlas, castOf(look, id)), size: size));
  }
}

/// A cast's face (the creator's species tiles).
class CastFace extends ConsumerWidget {
  const CastFace({super.key, required this.cast, required this.size});
  final Cast cast;
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox.square(dimension: size);
    return AnimalFace(atlas: atlas, look: castPrefix(atlas, cast), size: size);
  }
}

class DeskManagerFace extends ConsumerWidget {
  const DeskManagerFace({super.key, required this.size});
  final double size;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final look = ref.watch(prefsProvider.select((p) => p.managerLook)) ?? 'farmer';
    if (atlas == null) return SizedBox.square(dimension: size);
    return ManagerFace(atlas: atlas, size: size, look: managerFaceSprite(atlas, look));
  }
}

/// The tool shed: each runtime is a farm machine.
const _machine = {
  'claude': 'machine-tractor',
  'codex': 'machine-watercart',
  'opencode': 'machine-wheelbarrow',
  'pi': 'machine-pump',
  'cursor': 'machine-seeder',
  'grok': 'machine-windmill',
  'kimi': 'machine-beehive',
  'antigravity': 'machine-lantern',
};

Widget _sprite(SpriteInfo sp, double size) => Image.asset(sp.asset, width: size, height: size, fit: BoxFit.contain, filterQuality: FilterQuality.none);

class RuntimeLogo extends ConsumerWidget {
  const RuntimeLogo({super.key, required this.runtime, required this.size, this.muted = false});
  final String runtime;
  final double size;
  final bool muted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null || !atlas.has('logo-$runtime')) return const SizedBox.shrink();
    return mutedBy(muted, .55, _sprite(atlas['logo-$runtime'], size));
  }
}

class RuntimeIcon extends ConsumerWidget {
  const RuntimeIcon({super.key, required this.runtime, required this.size, this.muted = false});
  final String runtime;
  final double size;
  final bool muted;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final atlas = ref.watch(atlasProvider).value;
    final machine = _machine[runtime];
    final badge = (size * 0.46).roundToDouble();
    return SizedBox.square(
      dimension: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          if (atlas != null && machine != null && atlas.has(machine))
            mutedBy(muted, .55, _sprite(atlas[machine], size))
          else
            Container(width: size, height: size, color: Palette.cream200),
          if (atlas != null && atlas.has('logo-$runtime'))
            Positioned(
              right: -4,
              bottom: -4,
              child: Container(
                width: badge,
                height: badge,
                padding: const EdgeInsets.all(2),
                decoration: const BoxDecoration(
                  color: Palette.cream50,
                  boxShadow: [BoxShadow(color: Palette.pxDrop, offset: Offset(2, 2))],
                ),
                child: RuntimeLogo(runtime: runtime, size: badge - 4, muted: muted),
              ),
            ),
        ],
      ),
    );
  }
}

/// How each pose moves (cast.ts POSE_MOTION, keyframes in packages/engine/src/engine.css), about the sprite's feet.
Matrix4 _motion(Pose pose, double t) {
  double ease(double x) => (1 - math.cos(math.pi * x)) / 2;
  // A loop from 0 to 1 and back, eased: the shape of the ease-in-out keyframes that peak at 50%.
  final tri = ease(t < .5 ? t * 2 : (1 - t) * 2);
  switch (pose) {
    case Pose.idle: // breathe 2.6 s: scale(1.012, 0.985) at 50%
      return Matrix4.diagonal3Values(1 + .012 * tri, 1 - .015 * tri, 1);
    case Pose.walk: // step 0.28 s: up 3 px at 50%
      return Matrix4.translationValues(0, -3 * tri, 0);
    case Pose.work: // work 0.9 s: rotate -2.5deg -> 2.5deg and up 3 px
      return Matrix4.translationValues(0, -3 * tri, 0)..rotateZ((-2.5 + 5 * tri) * math.pi / 180);
    case Pose.think: // sway 3.2 s: rotate -1.5deg -> 1.5deg
      return Matrix4.rotationZ((-1.5 + 3 * tri) * math.pi / 180);
    case Pose.cheer: // cheer 2.2 s: up 16 px at 20%, squash at 40%, still from 60%
      if (t < .2) return Matrix4.translationValues(0, -16 * (1 - math.pow(1 - t / .2, 2).toDouble()), 0);
      if (t < .4) {
        final k = (t - .2) / .2;
        return Matrix4.translationValues(0, -16 * (1 - k * k), 0)..scaleByDouble(1 + .03 * k, 1 - .03 * k, 1, 1);
      }
      if (t < .6) {
        final k = (t - .4) / .2;
        return Matrix4.diagonal3Values(1 + .03 * (1 - k), 1 - .03 * (1 - k), 1);
      }
      return Matrix4.identity();
    case Pose.worry: // worry 1.6 s: 0 -> -3deg at 25% -> 3deg at 75% -> 0
      final deg = t < .25 ? -3 * ease(t / .25) : (t < .75 ? -3 + 6 * ease((t - .25) / .5) : 3 - 3 * ease((t - .75) / .25));
      return Matrix4.rotationZ(deg * math.pi / 180);
  }
}

const _period = {
  Pose.idle: Duration(milliseconds: 2600),
  Pose.walk: Duration(milliseconds: 280),
  Pose.work: Duration(milliseconds: 900),
  Pose.think: Duration(milliseconds: 3200),
  Pose.cheer: Duration(milliseconds: 2200),
  Pose.worry: Duration(milliseconds: 1600),
};

/// A helper standing in `pose`, `height` tall (or `scale` screen pixels to an art pixel, each pose at its own size),
/// moving as it does on the page; walking plays the walk cycle on the spot.
class PoseSprite extends ConsumerStatefulWidget {
  const PoseSprite({super.key, required this.cast, required this.pose, this.height, this.scale, this.animate = true})
    : assert((height == null) != (scale == null), 'a height or a scale');
  final Cast cast;
  final Pose pose;
  final double? height;
  final double? scale;

  /// Off in tests that settle frames.
  final bool animate;

  @override
  ConsumerState<PoseSprite> createState() => _PoseSpriteState();
}

class _PoseSpriteState extends ConsumerState<PoseSprite> with SingleTickerProviderStateMixin {
  late final _loop = AnimationController(vsync: this, duration: _period[widget.pose]);
  Timer? _flip;
  int _frame = 0;

  @override
  void initState() {
    super.initState();
    _start();
  }

  void _start() {
    _flip?.cancel();
    _loop.duration = _period[widget.pose];
    if (!widget.animate) {
      _loop.stop();
      return;
    }
    _loop.repeat();
    if (widget.pose == Pose.walk) {
      _flip = Timer.periodic(const Duration(milliseconds: 1000 ~/ walkFps), (_) => setState(() => _frame++));
    }
  }

  @override
  void didUpdateWidget(PoseSprite old) {
    super.didUpdateWidget(old);
    if (old.pose != widget.pose || old.animate != widget.animate) {
      _frame = 0;
      _start();
    }
  }

  @override
  void dispose() {
    _flip?.cancel();
    _loop.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final atlas = ref.watch(atlasProvider).value;
    if (atlas == null) return SizedBox(height: widget.height);
    final SpriteInfo sp;
    if (widget.pose == Pose.walk) {
      final frames = walkFrames(atlas, widget.cast);
      sp = frames[_frame % frames.length];
    } else {
      sp = castSprite(atlas, widget.cast, widget.pose);
    }
    final h = widget.height ?? sp.h * widget.scale!;
    final w = sp.w * h / sp.h;
    return AnimatedBuilder(
      animation: _loop,
      builder: (context, child) => Transform(alignment: Alignment.bottomCenter, transform: _motion(widget.pose, _loop.value), child: child),
      child: Image.asset(sp.asset, width: w, height: h, fit: BoxFit.fill, filterQuality: FilterQuality.none, gaplessPlayback: true),
    );
  }
}
