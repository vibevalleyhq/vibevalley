// Turns the farm's effects into the level-up banner and achievement toasts, and the server's notices and a voice call
// that broke off into toasts (web/src/ui/FxLayer.tsx). Sounds come from farm_sounds.dart. The farm screen puts FxLayer
// over the village; the toasts themselves show in the kit's ToastViewport, which AppFrame puts over the whole app
// with `toastLeading` and `toastKicker` from here.

import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/server.dart';
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../voice/voice.dart';
import 'achievements.dart';
import '../rules/progress.dart';

/// Effects made on this side to be shown as if they came (the debug console's 升一级 and 弹一个成就).
final localEffects = StreamController<GameEffect>.broadcast();

/// The farm's effects as they come: each frame's off the server's state stream, and the local ones.
Stream<GameEffect> farmEffects(VibeValleyServer server) {
  late final StreamController<GameEffect> out;
  final subs = <StreamSubscription<GameEffect>>[];
  out = StreamController<GameEffect>.broadcast(
    onListen: () {
      subs
        ..add(server.frames.expand((f) => f.frame.effects).listen(out.add))
        ..add(localEffects.stream.listen(out.add));
    },
    onCancel: () {
      for (final s in subs) {
        unawaited(s.cancel());
      }
      subs.clear();
    },
  );
  return out.stream;
}

/// The beds that open at a level (core farm.ts BEDS' unlockLevel).
const clearingLevels = {5, 8, 12};

/// What a toast raised for an achievement carries.
typedef Earned = ({String achievement, int tier});

/// The medal for an achievement toast (the bell otherwise, the kit's own).
Widget? Function(ToastData) toastLeading(SpriteAtlas? atlas) => (toast) {
  final data = toast.data;
  if (toast.type != ToastType.achievement || data is! Earned || atlas == null) return null;
  final a = achievementOf(data.achievement);
  return a == null ? null : EarnedMedal(atlas: atlas, achievement: a, tier: data.tier);
};

/// The line above an achievement toast's title.
String? toastKicker(ToastData toast) {
  final data = toast.data;
  if (toast.type != ToastType.achievement || data is! Earned) return null;
  final a = achievementOf(data.achievement);
  return a == null ? null : earnedText(a, data.tier);
}

class FxLayer extends ConsumerStatefulWidget {
  const FxLayer({super.key, this.effects, this.notices, this.call, this.manager});

  /// The effects to show; the farm's (farmEffects) when not given.
  final Stream<GameEffect>? effects;

  /// What happens beside the state; the server's side events when not given. Notices become toasts.
  final Stream<SiteEvent>? notices;

  /// The voice call, to say why it could not start or broke off.
  final VoiceCall? call;

  /// Where toasts go; the kit's `toasts` when not given.
  final ToastManager? manager;

  @override
  ConsumerState<FxLayer> createState() => _FxLayerState();
}

class _FxLayerState extends ConsumerState<FxLayer> {
  final _subs = <StreamSubscription<Object>>[];
  ({int id, int level})? _banner;
  var _bannerId = 0;
  String? _problem;

  ToastManager get _toasts => widget.manager ?? toasts;

  @override
  void initState() {
    super.initState();
    final server = ref.read(serverProvider);
    _subs
      ..add((widget.effects ?? farmEffects(server)).listen(_effect))
      ..add((widget.notices ?? server.sideEvents).listen(_notice));
    _problem = widget.call?.problem;
    widget.call?.addListener(_voice);
  }

  @override
  void dispose() {
    for (final s in _subs) {
      unawaited(s.cancel());
    }
    widget.call?.removeListener(_voice);
    super.dispose();
  }

  // Notices (refusals, errors) from the server become toasts.
  void _notice(SiteEvent e) {
    if (e is! SiteEventNotice) return;
    final level = e.level.wire;
    _toasts.add(
      type: level,
      title: noticeTitle[level] ?? '提示',
      description: e.text,
      timeout: Duration(milliseconds: level == 'error' ? 7000 : 4500),
    );
  }

  // A voice call that could not start or broke off says why.
  void _voice() {
    final problem = widget.call?.problem;
    if (problem != null && problem != _problem) {
      _toasts.add(type: ToastType.error, title: '语音没接通', description: problem, timeout: const Duration(milliseconds: 7000));
    }
    _problem = problem;
  }

  // Level-ups get the banner, achievements a toast.
  void _effect(GameEffect f) {
    switch (f) {
      case GameEffectReward():
      case GameEffectPenalty():
        break;
      case GameEffectLevelUp(:final level):
        setState(() => _banner = (id: ++_bannerId, level: level.round()));
      case GameEffectAchievement(:final achievement, :final tier):
        final a = achievementOf(achievement);
        final t = tier.round();
        if (a != null) {
          _toasts.add(
            type: ToastType.achievement,
            title: tierTitle(a, t),
            description: '${a.detail} · +${tierCoins(a, t)} 金币',
            timeout: const Duration(milliseconds: 5000),
            data: (achievement: a.id, tier: t),
          );
        }
    }
  }

  @override
  Widget build(BuildContext context) {
    final banner = _banner;
    if (banner == null) return const SizedBox.shrink();
    final atlas = ref.watch(atlasProvider).value;
    return IgnorePointer(
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.only(top: 96),
          child: LevelUpBanner(
            key: ValueKey(banner.id),
            level: banner.level,
            star: atlas?['icon-star'],
            onDone: () {
              if (mounted && _banner?.id == banner.id) setState(() => _banner = null);
            },
          ),
        ),
      ),
    );
  }
}

/// The level-up banner: drops in, holds, fades up and away (index.css animate-banner, 3.4 s).
class LevelUpBanner extends StatefulWidget {
  const LevelUpBanner({super.key, required this.level, required this.star, required this.onDone});
  final int level;
  final SpriteInfo? star;
  final VoidCallback onDone;

  @override
  State<LevelUpBanner> createState() => _LevelUpBannerState();
}

class _LevelUpBannerState extends State<LevelUpBanner> with SingleTickerProviderStateMixin {
  late final _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 3400))..forward().whenComplete(() => widget.onDone());

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  /// The banner keyframes, each interval eased with cubic-bezier(0.2, 0.9, 0.2, 1).
  static const _ease = Cubic(0.2, 0.9, 0.2, 1);
  static double _at(List<(double, double)> frames, double p) {
    for (var k = 0; k < frames.length - 1; k++) {
      final (o0, v0) = frames[k];
      final (o1, v1) = frames[k + 1];
      if (p <= o1) return v0 + (v1 - v0) * _ease.transform(((p - o0) / (o1 - o0)).clamp(0, 1));
    }
    return frames.last.$2;
  }

  @override
  Widget build(BuildContext context) {
    final clearing = clearingLevels.contains(widget.level);
    return AnimatedBuilder(
      animation: _c,
      builder: (context, child) {
        final p = _c.value;
        final opacity = _at([(0, 0), (0.09, 1), (0.86, 1), (1, 0)], p);
        final dy = _at([(0, -16), (0.09, 0), (0.15, 0), (1, -10)], p);
        final scale = _at([(0, 0.9), (0.09, 1.04), (0.15, 1), (1, 1)], p);
        return Opacity(
          opacity: opacity.clamp(0, 1),
          child: Transform.translate(
            offset: Offset(0, dy),
            child: Transform.scale(scale: scale, child: child),
          ),
        );
      },
      child: Container(
        padding: const EdgeInsets.fromLTRB(28, 16, 28, 16),
        decoration: const BoxDecoration(color: Palette.cream50, boxShadow: kitDrop),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // The star stands out of the top (-mt-9): 36 of its 56 px above the paper.
            SizedBox(
              width: 56,
              height: 20,
              child: OverflowBox(
                alignment: Alignment.bottomCenter,
                maxHeight: 56,
                child: widget.star == null
                    ? const SizedBox(height: 56)
                    : Image.asset(widget.star!.asset, width: 56, height: 56, fit: BoxFit.contain, filterQuality: FilterQuality.none),
              ),
            ),
            const SizedBox(height: 2),
            const Text(
              'LEVEL UP',
              style: TextStyle(fontFamily: pixelFont, fontSize: 12, letterSpacing: 0.3, color: Palette.leaf700),
            ),
            Text(
              '农场 Lv.${widget.level}',
              style: const TextStyle(fontFamily: pixelFont, fontSize: 24, color: Palette.bark900),
            ),
            if (clearing) ...[
              const SizedBox(height: 2),
              const Text(
                '开垦了一块新地',
                style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.bark600),
              ),
            ],
          ],
        ),
      ),
    );
  }
}
