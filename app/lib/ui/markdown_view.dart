import 'package:flutter/gestures.dart';
import 'package:flutter/widgets.dart';

import 'links.dart';
import 'markdown.dart';
import 'theme.dart';

// GitHub-flavoured, no raw HTML. Colours follow the surrounding text colour, so the same rules read on cream paper and on a green bubble.

/// How a kit draws markdown; the parsing and the layout are the same for both kits.
class MdLook {
  const MdLook({required this.body, required this.heading, required this.monoFallback, required this.rule, this.measure});

  /// The body's style, from the style around it (its colour is the caller's).
  final TextStyle Function(TextStyle around) body;

  /// A heading of [level] (1–6), from the body's style.
  final TextStyle Function(TextStyle body, int level) heading;

  /// Code is in monoFont; what it has no glyph for (Chinese) falls to these.
  final List<String> monoFallback;

  /// A `---` line, in the body's colour faded.
  final Widget Function(Color color) rule;

  /// The widest a line may be, in body font sizes; null is as wide as it is given.
  final double? measure;
}

class MarkdownView extends StatefulWidget {
  const MarkdownView(this.text, {super.key, required this.look, this.mentions = false, this.onOpenLink, this.style});
  final String text;
  final MdLook look;
  final bool mentions;
  final void Function(Uri uri)? onOpenLink;
  final TextStyle? style;

  @override
  State<MarkdownView> createState() => _MarkdownViewState();
}

class _MarkdownViewState extends State<MarkdownView> {
  final _recognizers = <TapGestureRecognizer>[];
  late List<MdBlock> _parsed = _parse();

  List<MdBlock> _parse() => parseMarkdown(widget.mentions ? withMentions(widget.text) : widget.text);

  @override
  void didUpdateWidget(MarkdownView old) {
    super.didUpdateWidget(old);
    if (old.text != widget.text || old.mentions != widget.mentions) _parsed = _parse();
  }

  void _clear() {
    for (final r in _recognizers) {
      r.dispose();
    }
    _recognizers.clear();
  }

  @override
  void dispose() {
    _clear();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    _clear();
    final look = widget.look;
    final base = look.body(DefaultTextStyle.of(context).style.merge(widget.style));
    final painter = _Painter(base, _recognizers, widget.onOpenLink ?? linkOpener, look);
    final body = DefaultTextStyle(style: base, child: painter.blocks(_parsed));
    final measure = look.measure;
    if (measure == null) return body;
    return Align(
      alignment: Alignment.topLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: measure * (base.fontSize ?? 14)),
        child: body,
      ),
    );
  }
}

/// Adjacent margins collapse to the larger.
(double, double) _margins(MdBlock b) => switch (b) {
  MdHeading(:final level) when level <= 4 => (.6, .25),
  MdHeading() => (0, 0),
  MdRule() => (.7, .7),
  MdParagraph() || MdList() || MdCode() || MdQuote() || MdTable() => (.45, .45),
};

class _Painter {
  _Painter(this.base, this.recognizers, this.open, this.look);
  final TextStyle base;
  final List<TapGestureRecognizer> recognizers;
  final void Function(Uri uri)? open;
  final MdLook look;

  List<String> get _monoFallback => look.monoFallback;

  TextStyle heading(int level) => look.heading(base, level);

  double get em => base.fontSize ?? 12;
  Color get color => base.color ?? Palette.bark900;
  Color tint(double a) => color.withValues(alpha: color.a * a);

  Widget blocks(List<MdBlock> list) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      for (var i = 0; i < list.length; i++) ...[
        if (i > 0) SizedBox(height: em * (_margins(list[i - 1]).$2 > _margins(list[i]).$1 ? _margins(list[i - 1]).$2 : _margins(list[i]).$1)),
        block(list[i]),
      ],
    ],
  );

  Widget block(MdBlock b) => switch (b) {
    MdParagraph(:final text) => Text.rich(TextSpan(children: spans(parseInline(text), base))),
    MdHeading(:final level, :final text) => Text.rich(TextSpan(children: spans(parseInline(text), heading(level)))),
    MdCode(:final text) => Container(
      color: tint(.08),
      padding: EdgeInsets.symmetric(vertical: em * .55, horizontal: em * .75),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Text(
          text,
          softWrap: false,
          style: base.copyWith(fontFamily: monoFont, fontFamilyFallback: _monoFallback, fontSize: em * .85, height: 1.5),
        ),
      ),
    ),
    MdQuote(:final children) => Container(
      decoration: const BoxDecoration(
        border: Border(left: BorderSide(color: Palette.wheat, width: 3)),
      ),
      padding: EdgeInsets.only(left: em * .7),
      child: DefaultTextStyle.merge(
        style: TextStyle(color: tint(.75)),
        child: _Painter(base.copyWith(color: tint(.75)), recognizers, open, look).blocks(children),
      ),
    ),
    MdList() => list(b),
    MdRule() => look.rule(tint(.25)),
    MdTable() => table(b),
  };

  Widget list(MdList l) {
    final marker = Color.lerp(color, Palette.wheat, .45)!;
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (var i = 0; i < l.items.length; i++)
          Padding(
            // li margins .15em; in a loose list each item's paragraphs bring .45em, which collapses over it.
            padding: EdgeInsets.only(top: i == 0 ? 0 : em * (l.tight ? .15 : .45)),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: em * 1.3,
                  child: l.ordered
                      ? Padding(
                          padding: EdgeInsets.only(right: em * .3),
                          child: Text(
                            '${l.start + i}.',
                            textAlign: TextAlign.right,
                            style: base.copyWith(color: marker),
                          ),
                        )
                      : SizedBox(
                          height: em * (base.height ?? 1.2),
                          child: Center(
                            child: _Disc(size: em * .35, color: marker),
                          ),
                        ),
                ),
                Expanded(child: item(l.items[i])),
              ],
            ),
          ),
      ],
    );
  }

  Widget item(MdItem it) {
    final body = blocks(it.children);
    if (it.checked == null) return body;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          height: em * (base.height ?? 1.2),
          child: Center(child: _TaskBox(checked: it.checked!)),
        ),
        SizedBox(width: em * .35),
        Expanded(child: body),
      ],
    );
  }

  Widget table(MdTable t) {
    final style = base.copyWith(fontSize: em * .92);
    final line = BorderSide(color: tint(.18));
    TextAlign align(int c) => switch (c < t.aligns.length ? t.aligns[c] : MdAlign.none) {
      MdAlign.center => TextAlign.center,
      MdAlign.right => TextAlign.right,
      MdAlign.left || MdAlign.none => TextAlign.left,
    };
    Widget cell(String text, int c) => Padding(
      padding: EdgeInsets.symmetric(vertical: em * .25, horizontal: em * .6),
      child: Text.rich(TextSpan(children: spans(parseInline(text), style)), textAlign: align(c)),
    );
    return Align(
      alignment: Alignment.centerLeft,
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Table(
          defaultColumnWidth: const IntrinsicColumnWidth(),
          border: TableBorder.all(color: line.color),
          children: [
            TableRow(
              decoration: BoxDecoration(color: tint(.06)),
              children: [for (var c = 0; c < t.header.length; c++) cell(t.header[c], c)],
            ),
            for (final row in t.rows) TableRow(children: [for (var c = 0; c < row.length; c++) cell(row[c], c)]),
          ],
        ),
      ),
    );
  }

  List<InlineSpan> spans(List<MdInline> list, TextStyle style, {TapGestureRecognizer? link}) => [
    for (final n in list)
      ...switch (n) {
        MdText(:final text) => [TextSpan(text: text, style: style, recognizer: link)],
        MdBreak() => [TextSpan(text: '\n', style: style)],
        MdCodeSpan(:final text) => [
          TextSpan(
            text: text,
            recognizer: link,
            style: style.copyWith(
              fontFamily: monoFont,
              fontFamilyFallback: _monoFallback,
              fontSize: (style.fontSize ?? em) * .88,
              backgroundColor: (style.color ?? color).withValues(alpha: .1),
            ),
          ),
        ],
        MdStyled(:final kind, :final children) => spans(
          children,
          kind == 'del' ? style.copyWith(decoration: TextDecoration.lineThrough, decorationColor: style.color) : style,
          link: link,
        ),
        MdLink(:final href, :final children) when href == mentionHref => [
          WidgetSpan(
            alignment: PlaceholderAlignment.middle,
            child: Container(
              padding: EdgeInsets.symmetric(horizontal: (style.fontSize ?? em) * .3),
              color: (style.color ?? color).withValues(alpha: .13),
              child: Text.rich(TextSpan(children: spans(children, style)), softWrap: false),
            ),
          ),
        ],
        MdLink(:final href, :final children) => spans(
          children,
          style.copyWith(decoration: TextDecoration.underline, decorationColor: (style.color ?? color).withValues(alpha: .45)),
          link: _recognizer(href),
        ),
      },
  ];

  TapGestureRecognizer _recognizer(String href) {
    final r = TapGestureRecognizer()
      ..onTap = () {
        final uri = Uri.tryParse(href);
        if (uri != null) open?.call(uri);
      };
    recognizers.add(r);
    return r;
  }
}

class _Disc extends StatelessWidget {
  const _Disc({required this.size, required this.color});
  final double size;
  final Color color;

  @override
  Widget build(BuildContext context) => Container(
    width: size,
    height: size,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

class _TaskBox extends StatelessWidget {
  const _TaskBox({required this.checked});
  final bool checked;

  @override
  Widget build(BuildContext context) => SizedBox.square(dimension: 12, child: CustomPaint(painter: _TaskPainter(checked)));
}

class _TaskPainter extends CustomPainter {
  _TaskPainter(this.checked);
  final bool checked;

  @override
  void paint(Canvas canvas, Size size) {
    final r = Offset.zero & size;
    if (checked) {
      canvas.drawRect(r, Paint()..color = Palette.leaf500.withValues(alpha: .6));
      final tick = Paint()
        ..color = Palette.cream50
        ..style = PaintingStyle.stroke
        ..strokeWidth = 2;
      canvas.drawPath(
        Path()
          ..moveTo(size.width * .2, size.height * .5)
          ..lineTo(size.width * .42, size.height * .72)
          ..lineTo(size.width * .8, size.height * .28),
        tick,
      );
    } else {
      canvas.drawRect(r, Paint()..color = Palette.cream50.withValues(alpha: .6));
      canvas.drawRect(
        r.deflate(.5),
        Paint()
          ..color = Palette.bark500.withValues(alpha: .6)
          ..style = PaintingStyle.stroke,
      );
    }
  }

  @override
  bool shouldRepaint(_TaskPainter old) => old.checked != checked;
}
