import 'package:flutter/material.dart';

import '../common.dart';
import 'base.dart';

/// Over the app's theme where the workbench draws: Material's own pieces (tooltips, selection, text fields) in the pro look.
ThemeData proTheme(ThemeData around) => around.copyWith(
  textTheme: Typography.material2021(
    platform: TargetPlatform.macOS,
  ).black.apply(fontFamily: readFont, fontFamilyFallback: readFallback, bodyColor: ProColor.ink),
  scaffoldBackgroundColor: ProColor.page,
  tooltipTheme: const TooltipThemeData(
    textStyle: TextStyle(fontFamily: readFont, fontFamilyFallback: readFallback, fontSize: 12, height: 16 / 12, color: Palette.paper),
    decoration: BoxDecoration(color: Color(0xF02F1F13), borderRadius: BorderRadius.all(Radius.circular(6))),
    padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
  ),
  textSelectionTheme: const TextSelectionThemeData(cursorColor: ProColor.ink, selectionColor: Color(0x5574A046)),
  // The pro fields draw their own box; the farm theme's 2 px frame would sit inside it.
  inputDecorationTheme: const InputDecorationTheme(
    filled: false,
    isDense: true,
    border: InputBorder.none,
    enabledBorder: InputBorder.none,
    focusedBorder: InputBorder.none,
    disabledBorder: InputBorder.none,
    errorBorder: InputBorder.none,
    focusedErrorBorder: InputBorder.none,
  ),
);

/// The workbench's corner of the app: the pro theme and the pro body text for everything under it.
class ProScope extends StatelessWidget {
  const ProScope({super.key, required this.child});
  final Widget child;

  @override
  Widget build(BuildContext context) => Theme(
    data: proTheme(Theme.of(context)),
    child: DefaultTextStyle(style: ProText.sm, child: child),
  );
}
