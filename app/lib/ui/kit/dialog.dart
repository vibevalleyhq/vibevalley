// Dialogs: the config pages' dialog (web/src/components/ui/dialog.tsx) and the farm's dialog frame
// (web/src/farm/dialog.tsx), each as a widget for the frame and a show* function that opens it as a modal route
// (the page's controlled `open`/`onClose` becomes push/pop: Esc, a click on the backdrop and the close button pop it).

import 'package:flutter/material.dart';

import '../../app/theme.dart';
import 'base.dart';
import 'button.dart';
import 'icons.dart';

/// The config pages' backdrop: rgb(30 20 10 / 0.45).
const _dialogBackdrop = Color(0x731E140A);

/// Replaces web/src/components/ui/dialog.tsx Dialog's popup: a bark-outlined cream window, at most 512 px wide (the
/// screen less 32 px) and 85% of its height, 24 px in, a 24 px title and an icon close button (关上). Scrolls as a whole.
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
                  style: KitText.sm,
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Row(
                        children: [
                          Expanded(
                            child: Semantics(
                              header: true,
                              child: DefaultTextStyle(style: KitText.xl, child: title),
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

/// Opens a PxDialog (web/src/components/ui/dialog.tsx Dialog) over the screen, fading and growing from 95% in 150 ms as
/// a farm dialog does. The builder gets the dialog's context; `Navigator.pop(context, result)` closes it with a result.
Future<T?> showPxDialog<T>(BuildContext context, {required Widget title, required WidgetBuilder builder}) => showGeneralDialog<T>(
  context: context,
  barrierDismissible: true,
  barrierLabel: '关上',
  barrierColor: _dialogBackdrop,
  transitionDuration: kitMotion(context, const Duration(milliseconds: 150)),
  transitionBuilder: _fadeIn,
  pageBuilder: (context, _, _) => PxDialog(
    title: title,
    onClose: () => Navigator.of(context).pop(),
    child: Builder(builder: builder),
  ),
);

/// The farm dialog's fixed sizes (farm/dialog.tsx DIALOG_SIZE): whatever it holds, it keeps its size and scrolls inside.
enum FarmDialogSize {
  sm(480, 384),
  md(480, 608),
  lg(736, 576);

  const FarmDialogSize(this.width, this.height);
  final double width;
  final double height;
}

/// Replaces web/src/farm/dialog.tsx FarmDialog's popup: a framed cream card of a fixed size (at most 88% of the screen's
/// height and its width less 24 px), a title bar (an icon sprite, the 24 px title cut short, a round close button)
/// over a dashed line, and the body scrolling 16 px in.
class FarmDialog extends StatelessWidget {
  const FarmDialog({super.key, required this.title, required this.size, required this.child, required this.onClose, this.icon});
  final Widget title;
  final FarmDialogSize size;
  final Widget child;
  final VoidCallback onClose;

  /// A sprite name (assets/pixel), shown 32 px before the title.
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
              style: KitText.sm,
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
                              child: DefaultTextStyle(style: KitText.lg, maxLines: 1, overflow: TextOverflow.ellipsis, child: title),
                            ),
                          ),
                          const SizedBox(width: 8),
                          KitTappable(
                            onTap: onClose,
                            semanticLabel: '关上',
                            builder: (context, s) => Container(
                              width: 36,
                              height: 36,
                              color: s.hovered ? Palette.cream200 : null,
                              alignment: Alignment.center,
                              // text-xl ×: the close glyph in its place (no characters for icons).
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

/// A dialog coming up: it fades in and grows from 95%; a screen reader has it from the start.
Widget _fadeIn(BuildContext context, Animation<double> animation, Animation<double> _, Widget child) => FadeTransition(
  opacity: animation,
  alwaysIncludeSemantics: true,
  child: ScaleTransition(scale: Tween(begin: .95, end: 1.0).animate(animation), child: child),
);

/// Opens a FarmDialog over the screen: the backdrop is bark at 30%, and the card fades and grows from 95% in 150 ms.
Future<T?> showFarmDialog<T>(BuildContext context, {required Widget title, required FarmDialogSize size, String? icon, required WidgetBuilder builder}) =>
    showGeneralDialog<T>(
      context: context,
      barrierDismissible: true,
      barrierLabel: '关上',
      barrierColor: Palette.bark900.withValues(alpha: .3),
      transitionDuration: kitMotion(context, const Duration(milliseconds: 150)),
      transitionBuilder: _fadeIn,
      pageBuilder: (context, _, _) => FarmDialog(
        title: title,
        size: size,
        icon: icon,
        onClose: () => Navigator.of(context).pop(),
        child: Builder(builder: builder),
      ),
    );

/// Replaces web/src/farm/dialog.tsx Section: a small titled part of a farm dialog, 16 px below the one before.
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
          child: Text(title, style: KitText.xs.copyWith(color: Palette.bark600)),
        ),
        const SizedBox(height: 6),
        child,
      ],
    ),
  );
}
