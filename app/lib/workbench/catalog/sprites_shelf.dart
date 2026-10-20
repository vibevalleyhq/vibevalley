import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../ui/pro/pro.dart';
import 'catalog_data.dart';
import '../shared/widgets.dart';
import 'catalog_page.dart';

class SpritesShelf extends ConsumerStatefulWidget {
  const SpritesShelf({super.key, this.id, this.tabs});
  final String? id;

  /// The shelf picker, atop the kinds.
  final Widget? tabs;

  @override
  ConsumerState<SpritesShelf> createState() => _SpritesShelfState();
}

class _SpritesShelfState extends ConsumerState<SpritesShelf> {
  String _shelf = 'all';
  String _query = '';
  Ground _ground = Ground.check;

  @override
  void didUpdateWidget(SpritesShelf old) {
    super.didUpdateWidget(old);
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
      child: ShelfColumn(
        tabs: widget.tabs,
        below: [
          _ShelfButton(active: _shelf == 'all', label: '全部', count: pictures.all.length, onTap: () => setState(() => _shelf = 'all')),
          for (final s in present) _ShelfButton(active: _shelf == s.id, label: s.label, count: counts[s.id] ?? 0, onTap: () => setState(() => _shelf = s.id)),
          Padding(
            padding: const EdgeInsets.fromLTRB(8, 8, 8, 4),
            child: Text('${pictures.all.length} 张，切自 design/pixel/raw。', style: ProText.meta),
          ),
        ],
      ),
    );

    final search = ShelfSearch(
      query: _query,
      onChanged: (q) => setState(() => _query = q),
      placeholder: '找：名字、类别、动物、衣服（熊、雨衣、lang-、icon-……）',
      ground: _ground,
      onGround: (g) => setState(() => _ground = g),
    );

    final cards = <Widget>[
      if (shown.isEmpty) const EmptyNote('没有对得上的。'),
      for (final s in visible)
        if (groupsOf(s.id, [
              for (final p in shown)
                if (shelfOf(p.name) == s.id) p,
            ])
            case final groups when groups.isNotEmpty)
          ProCard(
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
                      child: Text(
                        g.label,
                        style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600),
                      ),
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
        : const EmptyNote('点一张看大图：尺寸、落脚点、会动的帧，和它是从哪张原图切出来的、怎么重画。');

    return LayoutBuilder(
      builder: (context, box) {
        final width = MediaQuery.sizeOf(context).width;
        if (width >= 1280) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 240,
                child: SingleChildScrollView(padding: catalogFramed, child: nav),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ListView(padding: catalogFramed, children: gapped([search, ...cards])),
              ),
              const SizedBox(width: 12),
              SizedBox(
                width: 352,
                child: SingleChildScrollView(padding: catalogFramed, child: detail),
              ),
            ],
          );
        }
        if (width >= 1024) {
          return Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 240,
                child: SingleChildScrollView(padding: catalogFramed, child: nav),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: ListView(padding: catalogFramed, children: gapped([if (selected != null) detail, search, ...cards])),
              ),
            ],
          );
        }
        return ListView(padding: catalogFramed, children: gapped([nav, if (selected != null) detail, search, ...cards]));
      },
    );
  }
}

class GroundPick extends StatelessWidget {
  const GroundPick({super.key, required this.value, required this.onChanged});
  final Ground value;
  final ValueChanged<Ground> onChanged;

  @override
  Widget build(BuildContext context) => ProSegmented<Ground>(
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
  Widget build(BuildContext context) => Tappable(
    onTap: onTap,
    selected: active,
    builder: (context, s) => ProFocusRing(
      on: s.focused,
      child: Container(
        margin: const EdgeInsets.only(bottom: 2),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
        decoration: BoxDecoration(
          color: active
              ? ProColor.selected
              : s.hovered
              ? ProColor.hover
              : null,
          borderRadius: proRadius,
        ),
        child: Row(
          children: [
            Expanded(
              child: Text(label, style: ProText.sm.copyWith(fontWeight: active ? FontWeight.w600 : FontWeight.w400)),
            ),
            Text('$count', style: ProText.meta),
          ],
        ),
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
      // As many 88 px columns as fit, 6 px between, sharing what is left.
      final columns = ((box.maxWidth + 6) / (88 + 6)).floor().clamp(1, 1000);
      final width = (box.maxWidth - 6 * (columns - 1)) / columns;
      return Wrap(
        spacing: 6,
        runSpacing: 6,
        children: [
          for (final p in pictures)
            SizedBox(
              width: width,
              child: Tappable(
                onTap: () => workbenchGo(context, '/catalog/${Uri.encodeComponent(p.name)}'),
                tooltip: '${p.name} · ${numberText(p.w)}×${numberText(p.h)}',
                selected: selected?.name == p.name,
                builder: (context, s) => Container(
                  padding: const EdgeInsets.all(4),
                  decoration: BoxDecoration(
                    color: selected?.name == p.name
                        ? ProColor.selected
                        : s.hovered
                        ? ProColor.hover
                        : null,
                    border: Border.all(color: s.focused ? ProColor.focus : Colors.transparent),
                    borderRadius: const BorderRadius.all(Radius.circular(8)),
                  ),
                  child: Column(
                    children: [
                      SizedBox.square(
                        dimension: 80,
                        child: ClipRRect(
                          borderRadius: proRadius,
                          child: GroundBox(
                            ground: ground,
                            child: Stack(
                              children: [
                                Center(child: AssetImg(p, fitScale(p, 72))),
                                if (framesOf(p.name, all.has) != null)
                                  Positioned(
                                    top: 2,
                                    right: 2,
                                    child: Container(
                                      padding: const EdgeInsets.symmetric(horizontal: 4),
                                      decoration: BoxDecoration(color: Palette.bark900.withValues(alpha: .7), borderRadius: BorderRadius.circular(3)),
                                      child: Text(
                                        '动',
                                        style: ProText.xs.copyWith(fontSize: 10, height: 14 / 10, color: Palette.paper),
                                      ),
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
                        style: ProText.mono.copyWith(fontSize: 11.5, color: ProColor.muted),
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
    final tasks = {1.0, 2.0, 4.0, 8.0, _scale}.toList()..sort();
    return ProCard(
      title: picture.name,
      aside: CopyButton(text: picture.name),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 160, maxHeight: 352),
            child: _Rounded(
              GroundBox(
                ground: widget.ground,
                padding: const EdgeInsets.all(12),
                child: Center(
                  child: SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    child: SingleChildScrollView(
                      child: SizedBox(
                        width: shown.w * _scale,
                        height: shown.h * _scale,
                        child: Stack(clipBehavior: Clip.none, children: [AssetImg(shown, _scale), if (_marks) ..._markers(shown, _scale)]),
                      ),
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
              ProSegmented<double>(
                block: false,
                value: _scale,
                onChanged: (v) => setState(() => _scale = v),
                options: [
                  for (final s in tasks) SegmentOption(value: s, label: '${s < 1 ? s.toStringAsFixed(2).replaceFirst(RegExp(r'0$'), '') : numberText(s)}×'),
                ],
              ),
              ProSwitchField(label: '落脚点和头', checked: _marks, onChanged: (v) => setState(() => _marks = v)),
            ],
          ),
          if (frames != null) ...[
            const SizedBox(height: 12),
            Container(
              decoration: const BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(8))),
              padding: const EdgeInsets.all(8),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      ProButton.text(
                        _playing ? '停' : '播放',
                        size: ProSize.sm,
                        onPressed: () => setState(() {
                          _playing = !_playing;
                          _restart();
                        }),
                      ),
                      const SizedBox(width: 8),
                      Text('${frames.length} 帧', style: ProText.meta),
                      const Spacer(),
                      SizedBox(
                        width: 96,
                        child: Semantics(
                          label: '每秒几帧',
                          child: SliderTheme(
                            data: SliderTheme.of(context).copyWith(
                              activeTrackColor: Palette.leaf500,
                              thumbColor: Palette.leaf500,
                              inactiveTrackColor: ProColor.selected,
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
                      SizedBox(width: 56, child: Text('$_fps 帧/秒', style: ProText.meta)),
                    ],
                  ),
                  const SizedBox(height: 6),
                  Wrap(
                    spacing: 4,
                    runSpacing: 4,
                    children: [
                      for (final (i, name) in frames.indexed)
                        if (widget.all[name] case final f?)
                          Tappable(
                            onTap: () => workbenchGo(context, '/catalog/${Uri.encodeComponent(name)}'),
                            tooltip: name,
                            builder: (context, s) => Container(
                              width: 44,
                              height: 44,
                              foregroundDecoration: BoxDecoration(
                                border: _playing && i == _frame % frames.length ? Border.all(color: ProColor.focus, width: 2) : null,
                                borderRadius: BorderRadius.circular(4),
                              ),
                              child: ClipRRect(
                                borderRadius: BorderRadius.circular(4),
                                child: GroundBox(
                                  ground: widget.ground,
                                  child: Center(child: AssetImg(f, fitScale(f, 38))),
                                ),
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
          _Row('尺寸', Text('${numberText(picture.w)} × ${numberText(picture.h)} 像素')),
          _Row('落脚点', Text('(${numberText(picture.ax)}, ${numberText(picture.ay)})')),
          if (picture.hx != null && picture.hy != null) _Row('头', Text('(${numberText(picture.hx!)}, ${numberText(picture.hy!)})')),
          _Row('来自', picture.sheet != null ? _Code(picture.sheet!) : const Text('没记下来（不再用的旧图）', style: ProText.meta)),
          if (remake != null) _Row('重画', _Code(remake.draw)),
          if (remake != null) _Row('重新切', _Code(remake.cut)),
        ],
      ),
    );
  }
}

class CrossPainter extends CustomPainter {
  @override
  void paint(Canvas canvas, Size size) {
    final p = Paint()..color = Palette.berry;
    canvas
      ..drawRect(Rect.fromLTWH(0, size.height / 2 - 1, size.width, 2), p)
      ..drawRect(Rect.fromLTWH(size.width / 2 - 1, 0, 2, size.height), p);
  }

  @override
  bool shouldRepaint(CrossPainter old) => false;
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
          width: 64,
          child: Text(label, style: ProText.sm.copyWith(color: ProColor.muted)),
        ),
        const SizedBox(width: 8),
        Expanded(
          child: DefaultTextStyle(style: ProText.sm, child: child),
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
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 1),
            decoration: const BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(4))),
            child: Text(text, maxLines: 1, overflow: TextOverflow.ellipsis, style: ProText.mono.copyWith(fontSize: 11.5)),
          ),
        ),
      ),
      const SizedBox(width: 4),
      CopyButton(text: text),
    ],
  );
}

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
  Widget build(BuildContext context) => Tappable(
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
      decoration: BoxDecoration(color: s.hovered ? ProColor.hover : null, borderRadius: const BorderRadius.all(Radius.circular(4))),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          SpriteIcon(_done ? 'mark-check' : 'button-copy', size: 12),
          const SizedBox(width: 4),
          Text(_done ? '复制了' : '复制', style: ProText.xs.copyWith(color: ProColor.muted)),
        ],
      ),
    ),
  );
}

List<Widget> _markers(Picture p, double scale) => [
  Positioned(
    left: p.ax * scale - 6,
    top: p.ay * scale - 6,
    width: 12,
    height: 12,
    child: Tooltip(
      message: '落脚点',
      child: CustomPaint(painter: CrossPainter()),
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
          decoration: BoxDecoration(border: Border.all(color: const Color(0xFF0EA5E9), width: 2)),
        ),
      ),
    ),
];

class _Rounded extends StatelessWidget {
  const _Rounded(this.child);
  final Widget child;

  @override
  Widget build(BuildContext context) => ClipRRect(borderRadius: proRadius, child: child);
}
