import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../common.dart';
import 'base.dart';
import 'button.dart';
import 'theme.dart';

const _backdrop = Color(0x592F1F13);

class ProDialog extends StatelessWidget {
  const ProDialog({super.key, required this.title, required this.child, required this.onClose});
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
          constraints: BoxConstraints(maxWidth: 480, maxHeight: screen.height * .85),
          child: Material(
            type: MaterialType.transparency,
            child: Container(
              decoration: const BoxDecoration(
                color: ProColor.page,
                border: Border.fromBorderSide(proLine),
                borderRadius: BorderRadius.all(Radius.circular(12)),
                boxShadow: proFloat,
              ),
              child: SingleChildScrollView(
                padding: const EdgeInsets.fromLTRB(24, 20, 24, 24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: Semantics(
                            header: true,
                            child: DefaultTextStyle(style: ProText.lg, child: title),
                          ),
                        ),
                        const SizedBox(width: 12),
                        ProButton.icon('button-close', semanticLabel: '关上', onPressed: onClose),
                      ],
                    ),
                    const SizedBox(height: 16),
                    child,
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Opened on the root navigator, above the workbench's ProScope, so it brings the pro theme along.
/// The builder gets the dialog's context; `Navigator.pop(context, result)` closes it with a result.
Future<T?> showProDialog<T>(BuildContext context, {required Widget title, required WidgetBuilder builder}) => showGeneralDialog<T>(
  context: context,
  barrierDismissible: true,
  barrierLabel: '关上',
  barrierColor: _backdrop,
  transitionDuration: motionDuration(context, const Duration(milliseconds: 150)),
  transitionBuilder: (context, a, _, child) => FadeTransition(
    opacity: CurvedAnimation(parent: a, curve: Curves.easeOut),
    child: ScaleTransition(
      scale: Tween(begin: .98, end: 1.0).animate(CurvedAnimation(parent: a, curve: Curves.easeOut)),
      child: child,
    ),
  ),
  pageBuilder: (context, _, _) => ProScope(
    child: ProDialog(
      title: title,
      onClose: () => Navigator.of(context).pop(),
      child: Builder(builder: builder),
    ),
  ),
);

/// A modal drawn by the page itself (its route stays the page's): the workbench issue opens in it.
class ProModalLayer extends StatefulWidget {
  const ProModalLayer({super.key, required this.onClose, required this.child, this.maxWidth = 720});
  final VoidCallback onClose;
  final Widget child;
  final double maxWidth;

  @override
  State<ProModalLayer> createState() => _ProModalLayerState();
}

class _ProModalLayerState extends State<ProModalLayer> {
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
                  child: const ColoredBox(color: _backdrop),
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
                    child: Container(
                      clipBehavior: Clip.antiAlias,
                      decoration: const BoxDecoration(
                        color: ProColor.page,
                        border: Border.fromBorderSide(proLine),
                        borderRadius: BorderRadius.all(Radius.circular(12)),
                        boxShadow: proFloat,
                      ),
                      child: Stack(
                        children: [
                          SingleChildScrollView(
                            // The top leaves room for ✕, so a title under it is never covered.
                            padding: const EdgeInsets.fromLTRB(24, 40, 24, 24),
                            child: DefaultTextStyle(style: ProText.sm, child: widget.child),
                          ),
                          Positioned(
                            top: 8,
                            right: 8,
                            child: ProButton.icon('button-close', semanticLabel: '关上', onPressed: widget.onClose),
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
