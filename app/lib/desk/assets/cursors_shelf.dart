import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../ui/kit/kit.dart';
import 'assets_page.dart';
import 'sprites_shelf.dart';

/// Null when the app was built without them.
final cursorsProvider = FutureProvider<Map<String, ({double hx, double hy})>?>((ref) async {
  try {
    final raw = jsonDecode(await rootBundle.loadString('assets/cursors/cursors.json')) as Map<String, dynamic>;
    return {
      for (final MapEntry(:key, :value) in raw.entries)
        key: (hx: ((value as Map<String, dynamic>)['hx'] as num).toDouble(), hy: (value['hy'] as num).toDouble()),
    };
  } catch (_) {
    return null;
  }
});

class CursorsShelf extends ConsumerStatefulWidget {
  const CursorsShelf({super.key});

  @override
  ConsumerState<CursorsShelf> createState() => _CursorsShelfState();
}

class _CursorsShelfState extends ConsumerState<CursorsShelf> {
  Ground _ground = Ground.check;

  @override
  Widget build(BuildContext context) {
    final cursors = ref.watch(cursorsProvider);
    final all = cursors.value;
    return ListView(
      children: [
        PxCard(
          title: '指针 · ${all?.length ?? 0}',
          aside: GroundPick(value: _ground, onChanged: (g) => setState(() => _ground = g)),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                '红点是点下去落在哪。平时是手套，指着能点的伸出食指；拿着工具时是那件工具，能用的带闪光，用不上的带禁止标记。切自 design/pixel/raw/ui-cursors.png（design/pixel/process.py ui-cursors）。',
                style: KitText.xs.copyWith(color: Palette.bark600),
              ),
              const SizedBox(height: 12),
              if (cursors.isLoading)
                const SizedBox.shrink()
              else if (all == null)
                Text('这个版本没有带上指针的图（assets/cursors）。', style: KitText.sm.copyWith(color: Palette.bark500))
              else
                LayoutBuilder(
                  builder: (context, box) {
                    final columns = ((box.maxWidth + 6) / (104 + 6)).floor().clamp(1, 1000);
                    final width = (box.maxWidth - 6 * (columns - 1)) / columns;
                    return Wrap(
                      spacing: 6,
                      runSpacing: 6,
                      children: [
                        for (final MapEntry(:key, :value) in all.entries)
                          SizedBox(
                            width: width,
                            child: _CursorTile(name: key, hx: value.hx, hy: value.hy, ground: _ground),
                          ),
                      ],
                    );
                  },
                ),
            ],
          ),
        ),
      ],
    );
  }
}

class _CursorTile extends StatefulWidget {
  const _CursorTile({required this.name, required this.hx, required this.hy, required this.ground});
  final String name;
  final double hx;
  final double hy;
  final Ground ground;

  @override
  State<_CursorTile> createState() => _CursorTileState();
}

class _CursorTileState extends State<_CursorTile> {
  double? _natural;
  double? _naturalW;
  ImageStream? _stream;
  late final _listener = ImageStreamListener((info, _) {
    if (mounted) {
      setState(() {
        _natural = info.image.height.toDouble();
        _naturalW = info.image.width.toDouble();
      });
    }
  });

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _stream?.removeListener(_listener);
    _stream = AssetImage('assets/cursors/${widget.name}.png').resolve(createLocalImageConfiguration(context))..addListener(_listener);
  }

  @override
  void dispose() {
    _stream?.removeListener(_listener);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    const height = 40.0;
    final k = _natural == null ? null : height / _natural!;
    return Padding(
      padding: const EdgeInsets.all(4),
      child: Column(
        children: [
          SizedBox(
            height: 64,
            child: GroundBox(
              ground: widget.ground,
              child: Center(
                child: SizedBox(
                  height: height,
                  width: k == null ? height : _naturalW! * k,
                  child: Stack(
                    clipBehavior: Clip.none,
                    children: [
                      Image.asset(
                        'assets/cursors/${widget.name}@2x.png',
                        height: height,
                        filterQuality: FilterQuality.none,
                        errorBuilder: (_, _, _) => Image.asset('assets/cursors/${widget.name}.png', height: height, filterQuality: FilterQuality.none),
                      ),
                      if (k != null)
                        Positioned(
                          left: widget.hx * k - 4,
                          top: widget.hy * k - 4,
                          width: 8,
                          height: 8,
                          child: Container(color: Palette.berry, foregroundDecoration: pxRing),
                        ),
                    ],
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 4),
          Text(widget.name, style: KitText.mono.copyWith(height: 1.5, color: Palette.bark600)),
        ],
      ),
    );
  }
}
