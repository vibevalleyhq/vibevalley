import 'package:flutter/material.dart';

import '../../rules/board.dart';
import '../../ui/pro/pro.dart';

/// 显示: a small panel under its button with how the list groups and how both views order.
class DisplayMenu extends StatefulWidget {
  const DisplayMenu({super.key, required this.look, required this.onChanged});
  final BoardLook look;
  final ValueChanged<BoardLook> onChanged;

  @override
  State<DisplayMenu> createState() => _DisplayMenuState();
}

class _DisplayMenuState extends State<DisplayMenu> {
  final _portal = OverlayPortalController();
  final _link = LayerLink();
  final _group = Object();
  final _button = GlobalKey();
  double _width = 340;

  void _toggle() {
    // The panel opens leftwards from the button's right edge; on a phone the overlay is no wider than the page.
    final button = _button.currentContext?.findRenderObject();
    final overlay = Overlay.maybeOf(context)?.context.findRenderObject();
    if (button is RenderBox && overlay is RenderBox && button.hasSize) {
      final right = button.localToGlobal(Offset(button.size.width, 0)).dx - overlay.localToGlobal(Offset.zero).dx;
      _width = (right - 12).clamp(200, 340).toDouble();
    }
    setState(_portal.toggle);
  }

  void _close() {
    if (_portal.isShowing) setState(_portal.hide);
  }

  @override
  Widget build(BuildContext context) {
    final look = widget.look;
    final changed = look.grouping != defaultLook.grouping || look.ordering != defaultLook.ordering;
    return TapRegion(
      groupId: _group,
      onTapOutside: (_) => _close(),
      child: CompositedTransformTarget(
        link: _link,
        child: OverlayPortal(
          controller: _portal,
          overlayChildBuilder: (context) => CompositedTransformFollower(
            link: _link,
            targetAnchor: Alignment.bottomRight,
            followerAnchor: Alignment.topRight,
            offset: const Offset(0, 6),
            child: Align(
              alignment: Alignment.topRight,
              child: TapRegion(
                groupId: _group,
                child: Material(
                  type: MaterialType.transparency,
                  child: Container(
                    width: _width,
                    padding: const EdgeInsets.all(12),
                    decoration: const BoxDecoration(
                      color: Palette.paper,
                      border: Border.fromBorderSide(proLine),
                      borderRadius: BorderRadius.all(Radius.circular(8)),
                      boxShadow: proFloat,
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _Line(
                          label: '分组',
                          child: ProSegmented<Grouping>(
                            value: look.grouping,
                            options: [for (final g in Grouping.values) SegmentOption(value: g, label: g.label)],
                            onChanged: (g) => widget.onChanged((view: look.view, grouping: g, ordering: look.ordering)),
                          ),
                        ),
                        const SizedBox(height: 10),
                        _Line(
                          label: '排序',
                          child: ProSegmented<Ordering>(
                            value: look.ordering,
                            options: [for (final o in Ordering.values) SegmentOption(value: o, label: o.label)],
                            onChanged: (o) => widget.onChanged((view: look.view, grouping: look.grouping, ordering: o)),
                          ),
                        ),
                        const SizedBox(height: 10),
                        Text(
                          [
                            if (look.view == BoardView.board) '看板总按状态分列，拖过去就改状态；分组用在列表上。',
                            if (look.ordering != Ordering.manual) '不是「默认」排序时，待办不能上下拖着排先后。',
                            if (look.view != BoardView.board && look.ordering == Ordering.manual) '「默认」是待办里你排的先后。',
                          ].join('\n'),
                          style: ProText.meta.copyWith(height: 1.5),
                        ),
                        if (changed) ...[
                          const SizedBox(height: 8),
                          Align(
                            alignment: Alignment.centerLeft,
                            child: InlineLink(
                              '恢复默认',
                              onTap: () => widget.onChanged((view: look.view, grouping: defaultLook.grouping, ordering: defaultLook.ordering)),
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ),
          child: ProButton.text('显示', key: _button, icon: 'button-settings', tone: ProTone.quiet, semanticLabel: '显示', onPressed: _toggle),
        ),
      ),
    );
  }
}

class _Line extends StatelessWidget {
  const _Line({required this.label, required this.child});
  final String label;
  final Widget child;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.center,
    children: [
      SizedBox(
        width: 40,
        child: Text(label, style: ProText.sm.copyWith(color: ProColor.muted)),
      ),
      Expanded(child: child),
    ],
  );
}
