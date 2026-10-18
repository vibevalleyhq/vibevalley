import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../data/providers.dart';
import '../ui/kit/kit.dart';
import '../village/village_view.dart';
import '../ui/glyphs.dart';
import '../shared/connection_banner.dart';
import 'scene.dart';
import '../data/ui_state.dart';

const giveUpAfter = Duration(seconds: 20);

typedef LoadStep = ({String label, bool done});

class Loading {
  const Loading(this.tasks, {required this.gaveUp});
  final List<LoadStep> tasks;
  final bool gaveUp;

  double get fraction => tasks.where((s) => s.done).length / tasks.length;
  bool get finished => fraction == 1 || gaveUp;
  LoadStep? get now => tasks.where((s) => !s.done).firstOrNull;
}

class Startup extends ConsumerStatefulWidget {
  const Startup({super.key});

  @override
  ConsumerState<Startup> createState() => _StartupState();
}

class _StartupState extends ConsumerState<Startup> {
  bool _keys = false;
  bool _picture = false;
  bool _gaveUp = false;
  bool _gone = false;
  Timer? _giveUp;
  Timer? _fade;

  @override
  void initState() {
    super.initState();
    // So the keys are known when the menu comes (开始游戏 checks them).
    unawaited(ref.read(settingsProvider.notifier).load().then((_) {}, onError: (Object _) {}).whenComplete(() => _done(() => _keys = true)));
    _giveUp = Timer(giveUpAfter, () => _done(() => _gaveUp = true));
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!_picture) {
      unawaited(precacheImage(AssetImage(titleBackground(startScene())), context, onError: (_, _) {}).whenComplete(() => _done(() => _picture = true)));
    }
  }

  void _done(VoidCallback set) {
    if (mounted) setState(set);
  }

  @override
  void dispose() {
    _giveUp?.cancel();
    _fade?.cancel();
    super.dispose();
  }

  Loading _loading() {
    final reachable = watchReachable(ref);
    final farmIn = ref.watch(stateFrameProvider).hasValue;
    final village = ref.watch(atlasProvider).hasValue && ref.watch(villageProvider).hasValue;
    return Loading([
      (label: reachable ? '连上农场' : '连上农场（服务端没答应，在重试）', done: farmIn),
      (label: '读钥匙', done: _keys),
      (label: '字体', done: true),
      (label: '画首页', done: _picture),
      (label: '像素村', done: village),
      // A server that does not answer is not waited for: its banner says why and where to go (院门).
    ], gaveUp: _gaveUp || !reachable);
  }

  @override
  Widget build(BuildContext context) {
    if (_gone) return const SizedBox.shrink();
    final loading = _loading();
    if (loading.finished) _fade ??= Timer(const Duration(milliseconds: 250), () => _done(() => _gone = true));
    final atlas = ref.watch(atlasProvider).value;
    return AnimatedOpacity(
      opacity: loading.finished ? 0 : 1,
      duration: const Duration(milliseconds: 200),
      child: Semantics(
        label: '正在开门',
        child: ColoredBox(
          color: Palette.ground,
          child: Center(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (atlas != null) ManagerFace(atlas: atlas, size: 72) else const SizedBox.square(dimension: 72),
                const SizedBox(height: 24),
                const Text(
                  '码农场物语',
                  style: TextStyle(fontFamily: pixelFont, fontSize: 40, height: 1, color: Palette.cream50, shadows: _soft),
                ),
                const SizedBox(height: 24),
                LoadingBar(loading: loading),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

const _soft = [Shadow(color: Color(0xFF1A120B), offset: Offset(2, 2))];

class LoadingBar extends StatelessWidget {
  const LoadingBar({super.key, required this.loading});
  final Loading loading;

  @override
  Widget build(BuildContext context) {
    final pct = (loading.fraction * 100).round();
    final now = loading.now;
    final width = (MediaQuery.sizeOf(context).width * 0.8).clamp(0.0, 416.0);
    const line = TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream50, shadows: _soft);
    return Semantics(
      label: '正在开门',
      value: '$pct%',
      child: SizedBox(
        width: width,
        child: Column(
          children: [
            Row(
              children: [
                Expanded(child: Text(now != null ? '${now.label}…' : '好了', style: line)),
                Text('$pct%', style: line),
              ],
            ),
            const SizedBox(height: 8),
            Container(
              height: 20,
              padding: const EdgeInsets.all(2),
              decoration: BoxDecoration(
                color: const Color(0xFFF3E2B8),
                border: Border.all(color: const Color(0xFF3A2A18), width: 2),
                boxShadow: const [BoxShadow(color: Color(0x993A2A18), offset: Offset(2, 2))],
              ),
              child: Align(
                alignment: Alignment.centerLeft,
                child: FractionallySizedBox(
                  widthFactor: (pct < 4 ? 4 : pct) / 100,
                  child: const CustomPaint(painter: _Fill(), size: Size.infinite),
                ),
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              alignment: WrapAlignment.center,
              spacing: 12,
              children: [
                for (final s in loading.tasks)
                  Opacity(
                    opacity: s.done ? 1 : 0.6,
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (s.done)
                          const PixelMark.tick(size: 10, color: Palette.cream100)
                        else
                          const Text(
                            '·',
                            style: TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream100, shadows: _soft),
                          ),
                        const SizedBox(width: 4),
                        Text(
                          s.label.replaceAll(RegExp('（.*）'), ''),
                          style: const TextStyle(fontFamily: pixelFont, fontSize: 12, color: Palette.cream100, shadows: _soft),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _Fill extends CustomPainter {
  const _Fill();

  @override
  void paint(Canvas canvas, Size size) {
    final light = Paint()..color = const Color(0xFFE5A93C);
    final dark = Paint()..color = const Color(0xFFD4952C);
    for (var x = 0.0; x < size.width; x += 10) {
      canvas.drawRect(Rect.fromLTWH(x, 0, (size.width - x).clamp(0, 8), size.height), light);
      if (x + 8 < size.width) canvas.drawRect(Rect.fromLTWH(x + 8, 0, (size.width - x - 8).clamp(0, 2), size.height), dark);
    }
  }

  @override
  bool shouldRepaint(_Fill old) => false;
}
