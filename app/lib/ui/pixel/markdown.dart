import 'package:flutter/widgets.dart';
import '../common.dart';
import 'base.dart';

export '../markdown.dart';

TextStyle _said(TextStyle around) => around;

TextStyle _saidHeading(TextStyle body, int level) => level <= 4 ? body.copyWith(fontSize: (body.fontSize ?? 12) * 1.05, height: 1.35) : body;

TextStyle _read(TextStyle around) => PxText.read.copyWith(color: around.color);

/// Reading, a heading is the pixel font at a size it is sharp at: 24 for a title, 12 for a section, as the labels around it.
TextStyle _readHeading(TextStyle body, int level) =>
    body.copyWith(fontFamily: pixelFont, fontFamilyFallback: const [], fontSize: level == 1 ? 24 : 12, height: level == 1 ? 32 / 24 : 1.5);

Widget _dashed(Color color) => SizedBox(height: 1.5, child: DashedLine(color: color, thickness: 1.5));

const _saidLook = MdLook(body: _said, heading: _saidHeading, monoFallback: monoFallback, rule: _dashed);
const _readLook = MdLook(body: _read, heading: _readHeading, monoFallback: readMonoFallback, rule: _dashed, measure: PxText.readMeasure + 0.0);

class PxMarkdown extends StatelessWidget {
  const PxMarkdown(this.text, {super.key, this.mentions = false, this.onOpenLink, this.style, this.reading = false});
  final String text;
  final bool mentions;
  final void Function(Uri uri)? onOpenLink;

  /// With [reading], only its colour is kept: the body is PxText.read.
  final TextStyle? style;

  /// Long text to read: the body in PxText.read at most PxText.readMeasure wide; headings stay pixel, code stays mono.
  final bool reading;

  @override
  Widget build(BuildContext context) => MarkdownView(text, look: reading ? _readLook : _saidLook, mentions: mentions, onOpenLink: onOpenLink, style: style);
}

/// Plain text to read, as [PxMarkdown] with reading draws it.
class PxReadText extends StatelessWidget {
  const PxReadText(this.text, {super.key, this.color, this.maxLines});
  final String text;
  final Color? color;
  final int? maxLines;

  @override
  Widget build(BuildContext context) => Align(
    alignment: Alignment.topLeft,
    child: ConstrainedBox(
      constraints: BoxConstraints(maxWidth: PxText.readMeasure * PxText.read.fontSize!),
      child: Text(
        text,
        style: color == null ? PxText.read : PxText.read.copyWith(color: color),
        maxLines: maxLines,
        overflow: maxLines == null ? null : TextOverflow.ellipsis,
      ),
    ),
  );
}
