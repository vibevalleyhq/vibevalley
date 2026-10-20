import 'package:flutter/material.dart';

import '../../ui/pro/pro.dart';

/// An issue laid out as a page: what it is and the talk about it on the left, its properties and what can be done with it on
/// the right. Too narrow for two, the properties come under the heading.
class IssueSheet extends StatelessWidget {
  const IssueSheet({super.key, required this.heading, required this.main, required this.side});
  final Widget heading;
  final List<Widget> main;
  final List<Widget> side;

  static const _sideWidth = 260.0;
  static const _twoFrom = 760.0;

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, box) {
      final body = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: main);
      final props = Column(crossAxisAlignment: CrossAxisAlignment.stretch, mainAxisSize: MainAxisSize.min, children: side);
      if (box.maxWidth < _twoFrom) {
        return Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            heading,
            const SizedBox(height: 12),
            Container(
              padding: const EdgeInsets.all(12),
              decoration: const BoxDecoration(color: ProColor.hover, borderRadius: BorderRadius.all(Radius.circular(8))),
              child: props,
            ),
            const SizedBox(height: 16),
            body,
          ],
        );
      }
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          heading,
          const SizedBox(height: 16),
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: body),
              const SizedBox(width: 24),
              Container(
                width: _sideWidth,
                padding: const EdgeInsets.only(left: 20),
                decoration: const BoxDecoration(border: Border(left: proLine)),
                child: props,
              ),
            ],
          ),
        ],
      );
    },
  );
}

/// A small heading over a part of the side panel or the page.
class SheetLabel extends StatelessWidget {
  const SheetLabel(this.text, {super.key, this.top = 16});
  final String text;
  final double top;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.only(top: top, bottom: 6),
    child: Text(
      text,
      style: ProText.xs.copyWith(color: ProColor.muted, fontWeight: FontWeight.w600),
    ),
  );
}
