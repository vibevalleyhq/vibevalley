// 图鉴 (web/src/pages/AssetsPage.tsx), the asset browser as the farm's almanac: every picture on shelves by what it
// is, each with its size, its anchor, the frames it moves with, the sheet it was cut from and the commands that make it
// again; the mouse cursors; the sounds, to play. The rules are in assets_data.dart.

import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../shell/sfx.dart';
import '../../ui/kit/kit.dart';
import 'assets_data.dart';
import '../shared/widgets.dart';

/// What the pictures are shown on.
enum Ground {
  check('格子'),
  grass('草地'),
  night('夜里');

  const Ground(this.label);
  final String label;
}

/// A ground behind a picture: a 12 px checker of two creams, grass green or the night's blue.
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

  /// sprites, cursors or sounds.
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
      'cursors' => const _CursorsShelf(),
      'sounds' => const _SoundsShelf(),
      _ => _SpritesShelf(id: id),
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

// ── Pictures ─────────────────────────────────────────────────────────────────

/// The scale a picture is shown at to fit `box` pixels: whole steps, so its pixels stay square.
double fitScale(Picture p, double box) {
  final k = box / (p.w > p.h ? p.w : p.h);
  return k >= 1 ? k.floorToDouble() : k;
}

class _Img extends StatelessWidget {
  const _Img(this.picture, this.scale);
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

class _SpritesShelf extends ConsumerStatefulWidget {
  const _SpritesShelf({this.id});
  final String? id;

  @override
  ConsumerState<_SpritesShelf> createState() => _SpritesShelfState();
}

class _SpritesShelfState extends ConsumerState<_SpritesShelf> {
  String _shelf = 'all';
  String _query = '';
  Ground _ground = Ground.check;

  @override
  void didUpdateWidget(_SpritesShelf old) {
    super.didUpdateWidget(old);
    // A link names a picture: show its shelf.
    if (widget.id != null && widget.id != old.id && _shelf != 'all' && _shelf != shelfOf(widget.id!)) _shelf = 'all';
  }

  @override
  Widget build(BuildContext context) {
    final pictures = ref.watch(picturesProvider).value;
    if (pictures == null) return const SizedBox.shrink();
    final selected = widget.id == null ? null : pictures[widget.id!];
    final counts = <String, int>{};
    for (final p in pictures.all) {
      counts.update(shelfOf(p.name), (n) => n + 1, ifAbsent: () => 1);
    }
    final shown = [
      for (final p in pictures.all)
        if ((_shelf == 'all' || shelfOf(p.name) == _shelf) && pictureMatches(p, _query)) p,
    ];
    final present = shelves.where((s) => (counts[s.id] ?? 0) > 0).toList();
    final visible = _shelf == 'all' ? present : present.where((s) => s.id == _shelf).toList();

    final nav = Semantics(
      label: '分类',
      container: true,
      child: PxWindow(
        paper: Palette.cream50,
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            _ShelfButton(active: _shelf == 'all', label: '全部', count: pictures.all.length, onTap: () => setState(() => _shelf = 'all')),
            for (final s in present) _ShelfButton(active: _shelf == s.id, label: s.label, count: counts[s.id] ?? 0, onTap: () => setState(() => _shelf = s.id)),
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 4),
              child: Text('${pictures.all.length} 张，切自 design/pixel/raw。', style: KitText.xs.copyWith(height: 1.625, color: Palette.bark500)),
            ),
          ],
        ),
      ),
    );

    final search = PxWindow(
      paper: Palette.cream50,
      padding: const EdgeInsets.all(10),
      child: Row(
        children: [
          Expanded(
            child: PxTextInput(
              value: _query,
              onChanged: (q) => setState(() => _query = q),
              placeholder: '找：名字、类别、动物、衣服（熊、雨衣、lang-、icon-……）',
              icon: 'button-search',
              semanticLabel: '找素材',
            ),
          ),
          const SizedBox(width: 8),
          _GroundPick(value: _ground, onChanged: (g) => setState(() => _ground = g)),
        ],
      ),
    );

    final cards = <Widget>[
      if (shown.isEmpty) const PxCard(child: Text('没有对得上的。')),
      for (final s in visible)
        if (groupsOf(s.id, [
              for (final p in shown)
                if (shelfOf(p.name) == s.id) p,
            ])
            case final groups when groups.isNotEmpty)
          PxCard(
            title: '${s.label} · ${groups.fold<int>(0, (n, g) => n + g.pictures.length)}',
            aside: Text(s.hint),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              mainAxisSize: MainAxisSize.min,
              children: [
                for (final g in groups) ...[
                  if (g.label.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Text(g.label, style: KitText.xs.copyWith(color: Palette.bark600)),
                    ),
                  _Tiles(pictures: g.pictures, all: pictures, selected: selected, ground: _ground),
                  const SizedBox(height: 12),
                ],
              ],
            ),
          ),
    ];

    final detail = selected != null
        ? _Detail(key: ValueKey(selected.name), picture: selected, all: pictures, ground: _ground)
        : PxCard(
            child: Text('点一张看大图：尺寸、落脚点、会动的帧，和它是从哪张原图切出来的、怎么重画。', style: KitText.sm.copyWith(color: Palette.bark600, height: 1.625)),
          );

    return LayoutBuilder(
      builder: (context, box) {
        // xl: list | tiles | detail; lg: list | tiles, detail under them; narrower: one column.
        final width = MediaQuery.sizeOf(context).width;
        if (width >= 1280) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 240, child: SingleChildScrollView(child: nav)),
              const SizedBox(width: 12),
              Expanded(child: ListView(children: _gapped([search, ...cards]))),
              const SizedBox(width: 12),
              SizedBox(width: 352, child: SingleChildScrollView(child: detail)),
            ],
          );
        }
        if (width >= 1024) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(width: 240, child: SingleChildScrollView(child: nav)),
              const SizedBox(width: 12),
              Expanded(child: ListView(children: _gapped([if (selected != null) detail, search, ...cards]))),
            ],
          );
        }
        return ListView(children: _gapped([nav, if (selected != null) detail, search, ...cards]));
      },
    );
  }
}

List<Widget> _gapped(List<Widget> items) => [
  for (var i = 0; i < items.length; i++) ...[if (i > 0) const SizedBox(height: 12), items[i]],
];

class _GroundPick extends StatelessWidget {
  const _GroundPick({required this.value, required this.onChanged});
  final Ground value;
  final ValueChanged<Ground> onChanged;

  @override
  Widget build(BuildContext context) => PxSegmented<Ground>(
    block: false,
    value: value,
    onChanged: onChanged,
    options: [for (final g in Ground.values) SegmentOption(value: g, label: g.label)],
  );
}

class _ShelfButton extends StatelessWidget {
  const _ShelfButton({required this.active, required this.label, required this.count, required this.onTap});
  final bool active;
  final String label;
  final int count;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: onTap,
    selected: active,
    builder: (context, s) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
      foregroundDecoration: pxRing,
      color: active
          ? Palette.leaf300.withValues(alpha: .7)
          : s.hovered
          ? Palette.cream200
          : null,
      child: Row(
        children: [
          Expanded(
            child: Text(label, style: KitText.sm.copyWith(color: active ? Palette.bark900 : Palette.bark800)),
          ),
          Text('$count', style: KitText.xs.copyWith(color: Palette.bark500)),
        ],
      ),
    ),
  );
}

class _Tiles extends StatelessWidget {
  const _Tiles({required this.pictures, required this.all, required this.selected, required this.ground});
  final List<Picture> pictures;
  final Pictures all;
  final Picture? selected;
  final Ground ground;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      // repeat(auto-fill, minmax(5.5rem, 1fr)) with 6 px between.
      final columns = ((box.maxWidth + 6) / (88 + 6)).floor().clamp(1, 1000);
      final width = (box.maxWidth - 6 * (columns - 1)) / columns;
      return Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final p in pictures)
            SizedBox(
              width: width,
              child: KitTappable(
                onTap: () => deskGo(context, '/assets/${Uri.encodeComponent(p.name)}'),
                tooltip: '${p.name} · ${_n(p.w)}×${_n(p.h)}',
                selected: selected?.name == p.name,
                builder: (context, s) => Container(
                  padding: const EdgeInsets.all(4),
                  foregroundDecoration: pxRing,
                  color: selected?.name == p.name
                      ? Palette.leaf300.withValues(alpha: .7)
                      : s.hovered
                      ? Palette.cream200
                      : null,
                  child: Column(
                    children: [
                      SizedBox.square(
                        dimension: 80,
                        child: ClipRect(
                          child: GroundBox(
                            ground: ground,
                            child: Stack(
                              children: [
                                Center(child: _Img(p, fitScale(p, 72))),
                                if (framesOf(p.name, all.has) != null)
                                  Positioned(
                                    top: 2,
                                    right: 2,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 4),
                                      color: Palette.bark900.withValues(alpha: .7),
                                      child: Text('动', style: KitText.xs.copyWith(fontSize: 9, height: 1.25, color: Palette.cream50)),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        p.name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        textAlign: TextAlign.center,
                        style: KitText.mono.copyWith(height: 1.5, color: Palette.bark600),
                      ),
                    ],
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );
}

/// A number as the page prints it: no ".0" on whole ones.
String _n(double v) => v == v.roundToDouble() ? v.toInt().toString() : v.toString();

/// One picture, large: at whole scales, its anchor and head marked, its frames played, and where it comes from.
class _Detail extends StatefulWidget {
  const _Detail({super.key, required this.picture, required this.all, required this.ground});
  final Picture picture;
  final Pictures all;
  final Ground ground;

  @override
  State<_Detail> createState() => _DetailState();
}

class _DetailState extends State<_Detail> {
  late double _scale = (260 / (widget.picture.w > widget.picture.h ? widget.picture.w : widget.picture.h)).floorToDouble().clamp(1, 8);
  bool _marks = true;
  bool _playing = true;
  int _fps = 6;
  int _frame = 0;
  Timer? _timer;

  List<String>? get _frames => framesOf(widget.picture.name, widget.all.has);

  @override
  void initState() {
    super.initState();
    _restart();
  }

  void _restart() {
    _timer?.cancel();
    _timer = null;
    if (_frames == null || !_playing || _fps <= 0) return;
    _timer = Timer.periodic(Duration(microseconds: 1000000 ~/ _fps), (_) => setState(() => _frame++));
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final picture = widget.picture;
    final frames = _frames;
    final shown = (frames != null && _playing ? widget.all[frames[_frame % frames.length]] : null) ?? picture;
    final remake = remakeOf(picture);
    final steps = {1.0, 2.0, 4.0, 8.0, _scale}.toList()..sort();
    return PxCard(
      title: picture.name,
      aside: CopyButton(text: picture.name),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 160, maxHeight: 352),
            child: GroundBox(
              ground: widget.ground,
              padding: const EdgeInsets.all(12),
              child: Center(
                child: SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: SingleChildScrollView(
                    child: SizedBox(
                      width: shown.w * _scale,
                      height: shown.h * _scale,
                      child: Stack(clipBehavior: Clip.none, children: [_Img(shown, _scale), if (_marks) ..._markers(shown, _scale)]),
                    ),
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 8,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              PxSegmented<double>(
                value: _scale,
                onChanged: (v) => setState(() => _scale = v),
                options: [for (final s in steps) SegmentOption(value: s, label: '${s < 1 ? s.toStringAsFixed(2).replaceFirst(RegExp(r'0$'), '') : _n(s)}×')],
              ),
              _CheckBox(label: '落脚点和头', value: _marks, onChanged: (v) => setState(() => _marks = v)),
            ],
          ),
          if (frames != null) ...[
            const SizedBox(height: 12),
            Container(
              color: Palette.cream100,
              padding: const EdgeInsets.all(8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      PxButton.text(
                        _playing ? '停' : '播放',
                        size: PxSize.sm,
                        onPressed: () => setState(() {
                          _playing = !_playing;
                          _restart();
                        }),
                      ),
                      const SizedBox(width: 8),
                      Text('${frames.length} 帧', style: KitText.xs.copyWith(color: Palette.bark800)),
                      const Spacer(),
                      SizedBox(
                        width: 96,
                        child: Semantics(
                          label: '每秒几帧',
                          child: SliderTheme(
                            data: SliderTheme.of(context).copyWith(
                              activeTrackColor: Palette.leaf500,
                              thumbColor: Palette.leaf500,
                              inactiveTrackColor: Palette.cream300,
                              trackHeight: 4,
                              thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
                              overlayShape: SliderComponentShape.noOverlay,
                            ),
                            child: Slider(
                              value: _fps.toDouble(),
                              min: 1,
                              max: 12,
                              divisions: 11,
                              onChanged: (v) => setState(() {
                                _fps = v.round();
                                _restart();
                              }),
                            ),
                          ),
                        ),
                      ),
                      SizedBox(
                        width: 48,
                        child: Text('$_fps 帧/秒', style: KitText.xs.copyWith(color: Palette.bark800)),
                      ),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final (i, name) in frames.indexed)
                        if (widget.all[name] case final f?)
                          KitTappable(
                            onTap: () => deskGo(context, '/assets/${Uri.encodeComponent(name)}'),
                            tooltip: name,
                            builder: (context, s) => Container(
                              width: 44,
                              height: 44,
                              decoration: BoxDecoration(border: _playing && i == _frame % frames.length ? Border.all(color: Palette.leaf500, width: 2) : null),
                              child: GroundBox(
                                ground: widget.ground,
                                child: Center(child: _Img(f, fitScale(f, 38))),
                              ),
                            ),
                          ),
                    ],
                  ),
                ],
              ),
            ),
          ],
          const SizedBox(height: 12),
          _Row('尺寸', Text('${_n(picture.w)} × ${_n(picture.h)} 像素')),
          _Row('落脚点', Text('(${_n(picture.ax)}, ${_n(picture.ay)})')),
          if (picture.hx != null && picture.hy != null) _Row('头', Text('(${_n(picture.hx!)}, ${_n(picture.hy!)})')),
          _Row('来自', picture.sheet != null ? _Code(picture.sheet!) : Text('没记下来（不再用的旧图）', style: KitText.xs.copyWith(color: Palette.bark500))),
          if (remake != null) _Row('重画', _Code(remake.draw)),
          if (remake != null) _Row('重新切', _Code(remake.cut)),
        ],
      ),
    );
  }
}

/// The anchor (where it stands) as a cross, the head as a ring.
List<Widget> _markers(Picture p, double scale) => [
  Positioned(
    left: p.ax * scale - 6,
    top: p.ay * scale - 6,
    width: 12,
    height: 12,
    child: Tooltip(
      message: '落脚点',
      child: CustomPaint(painter: _CrossPainter()),
    ),
  ),
  if (p.hx != null && p.hy != null)
    Positioned(
      left: p.hx! * scale - 5,
      top: p.hy! * scale - 5,
      width: 10,
      height: 10,
      child: Tooltip(
        message: '头',
        child: Container(
          // rounded-full, squared by the skin.
          decoration: BoxDecoration(border: Border.all(color: const Color(0xFF0EA5E9), width: 2)),
        ),
      ),
    ),
];

class _CrossPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Palette.berry;
    canvas
      ..drawRect(Rect.fromLTWH(0, size.height / 2 - 1, size.width, 2), p)
      ..drawRect(Rect.fromLTWH(size.width / 2 - 1, 0, 2, size.height), p);
  }

  @override
  bool shouldRepaint(_CrossPainter old) => false;
}

class _CheckBox extends StatelessWidget {
  const _CheckBox({required this.label, required this.value, required this.onChanged});
  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  Widget build(BuildContext context) => Semantics(
    checked: value,
    child: KitTappable(
      onTap: () => onChanged(!value),
      builder: (context, s) => Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 14,
            height: 14,
            decoration: BoxDecoration(
              color: value ? Palette.leaf500 : Palette.creamInput,
              border: Border.all(color: Palette.bark800, width: 2),
            ),
          ),
          const SizedBox(width: 6),
          Text(label, style: KitText.xs.copyWith(color: Palette.bark800)),
        ],
      ),
    ),
  );
}

class _Row extends StatelessWidget {
  const _Row(this.label, this.child);
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 72,
          child: Text(label, style: KitText.xs.copyWith(color: Palette.bark500)),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: DefaultTextStyle(
            style: KitText.xs.copyWith(color: Palette.bark800),
            child: child,
          ),
        ),
      ],
    ),
  );
}

class _Code extends StatelessWidget {
  const _Code(this.text);
  final String text;

  @override
  Widget build(BuildContext context) => Row(
    children: [
      Flexible(
        child: Tooltip(
          message: text,
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
            color: Palette.cream200,
            child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: KitText.mono.copyWith(fontSize: 11)),
          ),
        ),
      ),
      const SizedBox(width: 4),
      CopyButton(text: text),
    ],
  );
}

/// 复制, then 复制了 for a moment.
class CopyButton extends StatefulWidget {
  const CopyButton({super.key, required this.text});
  final String text;

  @override
  State<CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<CopyButton> {
  bool _done = false;
  Timer? _reset;

  @override
  void dispose() {
    _reset?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: () async {
      await Clipboard.setData(ClipboardData(text: widget.text));
      if (!mounted) return;
      setState(() => _done = true);
      _reset?.cancel();
      _reset = Timer(const Duration(milliseconds: 1200), () {
        if (mounted) setState(() => _done = false);
      });
    },
    builder: (context, s) => Container(
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      color: s.hovered ? Palette.cream200 : null,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SpriteIcon(_done ? 'mark-check' : 'button-copy', size: 12),
          const SizedBox(width: 4),
          Text(_done ? '复制了' : '复制', style: KitText.xs.copyWith(fontSize: 11, color: Palette.bark600)),
        ],
      ),
    ),
  );
}

// ── Cursors ──────────────────────────────────────────────────────────────────

/// The cursors' manifest (web/src/pixel/cursors/cursors.json, bundled as assets/cursors/): each one's hotspot in its
/// 1x picture's pixels. Null when the app was built without them.
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

class _CursorsShelf extends ConsumerStatefulWidget {
  const _CursorsShelf();

  @override
  ConsumerState<_CursorsShelf> createState() => _CursorsShelfState();
}

class _CursorsShelfState extends ConsumerState<_CursorsShelf> {
  Ground _ground = Ground.check;

  @override
  Widget build(BuildContext context) {
    final cursors = ref.watch(cursorsProvider);
    final all = cursors.value;
    return ListView(
      children: [
        PxCard(
          title: '指针 · ${all?.length ?? 0}',
          aside: _GroundPick(value: _ground, onChanged: (g) => setState(() => _ground = g)),
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

/// A cursor's picture shown 40 px tall, its hotspot as a red dot.
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
    // p-1, the picture's 64 px well, the name on its 18 px line.
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
                          child: Container(
                            // Square under the skin, its ring-2 the skin's inner cream-300 line.
                            color: Palette.berry,
                            foregroundDecoration: pxRing,
                          ),
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

// ── Sounds ───────────────────────────────────────────────────────────────────

class _SoundsShelf extends StatelessWidget {
  const _SoundsShelf();

  @override
  Widget build(BuildContext context) {
    final mono = KitText.mono.copyWith(fontSize: 12, color: Palette.bark800);
    return ListView(
      children: _gapped([
        PxCard(
          child: Text.rich(
            TextSpan(
              children: [
                const TextSpan(text: '音效都是现合成的，没有音频文件：配方在 '),
                TextSpan(text: 'lib/shell/sfx.dart', style: mono),
                const TextSpan(text: '。关了音效就听不到。背景音乐还没有，给 Suno 的提示词在 '),
                TextSpan(text: 'design/music/suno-prompts.md', style: mono),
                const TextSpan(text: '。'),
              ],
            ),
            style: KitText.sm.copyWith(color: Palette.bark800, height: 1.625),
          ),
        ),
        for (final g in soundGroups)
          PxCard(
            title: g.title,
            child: Wrap(spacing: 8, runSpacing: 8, children: [for (final name in g.names) _SoundButton(name: name)]),
          ),
      ]),
    );
  }
}

class _SoundButton extends StatelessWidget {
  const _SoundButton({required this.name});
  final String name;

  @override
  Widget build(BuildContext context) => KitTappable(
    onTap: () => Sfx.play(name),
    semanticLabel: '播放 ${soundLabel[name] ?? name}',
    builder: (context, s) {
      Widget b = Container(
        padding: const EdgeInsets.fromLTRB(8, 6, 14, 6),
        // The focus ring's inner line wins over the button's drop, as the skin has it.
        color: s.hovered ? Palette.cream300 : Palette.cream200,
        foregroundDecoration: pxRing,
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const SizedBox.square(dimension: 24, child: Center(child: SpriteIcon('button-play', size: 20))),
            const SizedBox(width: 8),
            Text(soundLabel[name] ?? name, style: KitText.sm.copyWith(color: Palette.bark800)),
            const SizedBox(width: 8),
            Text(name, style: KitText.mono.copyWith(color: Palette.bark500)),
          ],
        ),
      );
      if (s.pressed) b = Transform.translate(offset: const Offset(0, 1), child: b);
      return b;
    },
  );
}
