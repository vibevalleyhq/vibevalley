import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import '../common.dart';
import 'base.dart';
import 'button.dart';

const _dialogBackdrop = Color(0x731E140A);

class PxDialog extends StatelessWidget {
  const PxDialog({super.key, required this.title, required this.child, required this.onClose});
  final Widget title;
  final Widget child;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    return Center(
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16),
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: 512, maxHeight: screen.height * .85),
          child: Material(
            type: MaterialType.transparency,
            child: PxWindow(
              border: 2,
              child: SingleChildScrollView(
                padding: const EdgeInsets.all(24),
                child: DefaultTextStyle(
                  style: PxText.sm,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Semantics(
                              header: true,
                              child: DefaultTextStyle(style: PxText.xl, child: title),
                            ),
                          ),
                          const SizedBox(width: 12),
                          PxButton(size: PxSize.icon, semanticLabel: '关上', onPressed: onClose, child: const SpriteIcon('button-close', size: 16)),
                        ],
                      ),
                      const SizedBox(height: 20),
                      child,
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// The builder gets the dialog's context; `Navigator.pop(context, result)` closes it with a result.
Future<T?> showPxDialog<T>(BuildContext context, {required Widget title, required WidgetBuilder builder}) => showGeneralDialog<T>(
  context: context,
  barrierDismissible: true,
  barrierLabel: '关上',
  barrierColor: _dialogBackdrop,
  transitionDuration: motionDuration(context, const Duration(milliseconds: 150)),
  transitionBuilder: _fadeIn,
  pageBuilder: (context, _, _) => PxDialog(
    title: title,
    onClose: () => Navigator.of(context).pop(),
    child: Builder(builder: builder),
  ),
);

/// Whatever it holds, it keeps its size and scrolls inside.
enum FarmDialogSize {
  sm(480, 384),
  md(480, 608),
  lg(736, 576);

  const FarmDialogSize(this.width, this.height);
  final double width;
  final double height;
}

class FarmDialog extends StatelessWidget {
  const FarmDialog({super.key, required this.title, required this.size, required this.child, required this.onClose, this.icon});
  final Widget title;
  final FarmDialogSize size;
  final Widget child;
  final VoidCallback onClose;

  final String? icon;

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    return Center(
      child: SizedBox(
        width: size.width.clamp(0, (screen.width - 24).clamp(0, double.infinity)).toDouble(),
        height: size.height.clamp(0, screen.height * .88).toDouble(),
        child: Material(
          type: MaterialType.transparency,
          child: PxWindow(
            clip: true,
            child: DefaultTextStyle(
              style: PxText.sm,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  ColoredBox(
                    color: Palette.cream100,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                      child: Row(
                        children: [
                          if (icon != null) ...[SpriteIcon(icon!, size: 32), const SizedBox(width: 8)],
                          Expanded(
                            child: Semantics(
                              header: true,
                              child: DefaultTextStyle(style: PxText.lg, maxLines: 1, overflow: TextOverflow.ellipsis, child: title),
                            ),
                          ),
                          const SizedBox(width: 8),
                          Tappable(
                            onTap: onClose,
                            semanticLabel: '关上',
                            builder: (context, s) => Container(
                              width: 36,
                              height: 36,
                              color: s.hovered ? Palette.cream200 : null,
                              alignment: Alignment.center,
                              child: Transform.translate(
                                offset: s.pressed ? const Offset(1, 1) : Offset.zero,
                                child: const SpriteIcon('button-close', size: 18),
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const ColoredBox(
                    color: Palette.cream100,
                    child: DashedLine(color: Palette.cream200),
                  ),
                  Expanded(
                    child: SingleChildScrollView(padding: const EdgeInsets.all(16), child: child),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// A screen reader has it from the start.
Widget _fadeIn(BuildContext context, Animation<double> animation, Animation<double> _, Widget child) => FadeTransition(
  opacity: animation,
  alwaysIncludeSemantics: true,
  child: ScaleTransition(scale: Tween(begin: .95, end: 1.0).animate(animation), child: child),
);

Future<T?> showFarmDialog<T>(BuildContext context, {required Widget title, required FarmDialogSize size, String? icon, required WidgetBuilder builder}) =>
    showGeneralDialog<T>(
      context: context,
      barrierDismissible: true,
      barrierLabel: '关上',
      barrierColor: Palette.bark900.withValues(alpha: .3),
      transitionDuration: motionDuration(context, const Duration(milliseconds: 150)),
      transitionBuilder: _fadeIn,
      pageBuilder: (context, _, _) => FarmDialog(
        title: title,
        size: size,
        icon: icon,
        onClose: () => Navigator.of(context).pop(),
        child: Builder(builder: builder),
      ),
    );

class FarmSection extends StatelessWidget {
  const FarmSection({super.key, required this.title, required this.child});
  final String title;
  final Widget child;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Semantics(
          header: true,
          child: Text(title, style: PxText.xs.copyWith(color: Palette.bark600)),
        ),
        const SizedBox(height: 6),
        child,
      ],
    ),
  );
}

/// A page's own modal, drawn over the page by its route rather than pushed on the navigator: the address stays the
/// page's (`/issues/<id>`), and Esc, ✕ or the backdrop close it.
class PxModalLayer extends StatefulWidget {
  const PxModalLayer({super.key, required this.onClose, required this.child, this.maxWidth = 720});
  final VoidCallback onClose;
  final Widget child;
  final double maxWidth;

  @override
  State<PxModalLayer> createState() => _PxModalLayerState();
}

class _PxModalLayerState extends State<PxModalLayer> {
  // It takes the keyboard as it opens, so Esc reaches it.
  final _scope = FocusScopeNode(debugLabel: 'modal');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _scope.requestFocus();
    });
  }

  @override
  void dispose() {
    _scope.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final screen = MediaQuery.sizeOf(context);
    return CallbackShortcuts(
      bindings: {const SingleActivator(LogicalKeyboardKey.escape): widget.onClose},
      child: FocusScope(
        node: _scope,
        child: Stack(
          children: [
            Positioned.fill(
              child: Semantics(
                button: true,
                label: '关上',
                child: GestureDetector(
                  onTap: widget.onClose,
                  child: const ColoredBox(color: _dialogBackdrop),
                ),
              ),
            ),
            Center(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: widget.maxWidth, maxHeight: screen.height * .88),
                  child: Material(
                    type: MaterialType.transparency,
                    child: PxWindow(
                      border: 2,
                      child: Stack(
                        children: [
                          SingleChildScrollView(
                            // The top leaves room for ✕, so a title under it is never covered.
                            padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
                            child: DefaultTextStyle(style: PxText.sm, child: widget.child),
                          ),
                          Positioned(
                            top: 8,
                            right: 8,
                            child: PxButton(
                              size: PxSize.icon,
                              semanticLabel: '关上',
                              onPressed: widget.onClose,
                              child: const SpriteIcon('button-close', size: 16),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
