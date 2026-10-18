import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../data/server.dart';
import '../gen/vibevalley.dart';
import '../sprites/atlas.dart';
import '../ui/kit/kit.dart';
import '../voice/voice.dart';
import '../ui/medals.dart';

/// The debug console's 升一级 and 弹一个成就.
final localEffects = StreamController<GameEffect>.broadcast();

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

const clearingLevels = {5, 8, 12};

Widget? Function(ToastData) toastLeading(SpriteAtlas? atlas) => (toast) {
  final data = toast.data;
  if (toast.type != ToastType.achievement || data is! GameEffectAchievement || atlas == null) return null;
  return EarnedMedal(atlas: atlas, achievement: data.achievement, tier: data.tier.round(), oneOff: data.oneOff ?? false);
};

String? toastKicker(ToastData toast) {
  final data = toast.data;
  if (toast.type != ToastType.achievement || data is! GameEffectAchievement) return null;
  return data.reached;
}

class FxLayer extends ConsumerStatefulWidget {
  const FxLayer({super.key, this.effects, this.notices, this.call, this.manager});

  final Stream<GameEffect>? effects;

  final Stream<LiveEvent>? notices;

  final VoiceCall? call;

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
    _subs.add((widget.effects ?? farmEffects(server)).listen(_effect));
    if (widget.notices case final notices?) {
      _subs.add(notices.listen(_notice));
    } else {
      ref.listenManual(sideEventsProvider, (_, next) {
        if (next.value case final e?) _notice(e);
      });
    }
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

  void _notice(LiveEvent e) {
    if (e is! LiveEventNotice) return;
    final level = e.level.wire;
    _toasts.add(
      type: level,
      title: noticeTitle[level] ?? '提示',
      description: e.text,
      timeout: Duration(milliseconds: level == 'error' ? 7000 : 4500),
    );
  }

  void _voice() {
    final problem = widget.call?.problem;
    if (problem != null && problem != _problem) {
      _toasts.add(type: ToastType.error, title: '语音没接通', description: problem, timeout: const Duration(milliseconds: 7000));
    }
    _problem = problem;
  }

  void _effect(GameEffect f) {
    switch (f) {
      case GameEffectReward():
      case GameEffectPenalty():
        break;
      case GameEffectLevelUp(:final level):
        setState(() => _banner = (id: ++_bannerId, level: level.round()));
      case GameEffectAchievement(:final title, :final detail, :final coins):
        // The words are the server's (the effect carries them).
        _toasts.add(
          type: ToastType.achievement,
          title: title,
          description: '$detail · +${coins.round()} 金币',
          timeout: const Duration(milliseconds: 5000),
          data: f,
        );
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
            // The star stands out of the top: 36 of its 56 px above the paper.
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
