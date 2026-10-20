import 'package:flutter/material.dart';

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
