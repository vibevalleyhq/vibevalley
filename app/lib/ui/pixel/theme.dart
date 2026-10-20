import 'package:flutter/material.dart';
import '../theme.dart';

/// The ink line every frame and divider is drawn with.
/// A control's edge: mid brown, not near-black, so a row of buttons and fields does not read as heavy.
const pxEdge = Palette.bark500;

const pxLine = BorderSide(color: pxEdge, width: 2);

BoxDecoration pixelBox({Color fill = Palette.cream100, Color border = Palette.bark900}) => BoxDecoration(
  color: fill,
  border: Border.all(color: border, width: 2),
  boxShadow: const [BoxShadow(color: Color(0x731E140A), offset: Offset(2, 2))],
);

/// Material's type scale spaces its letters (bodyMedium by 0.25 px), so a line of Chinese would run a pixel wider every four characters.
TextTheme _unspaced(TextTheme t) {
  // This theme is merged over the one `fontFamily` has been applied to, so it names the font again.
  TextStyle? z(TextStyle? s) => s?.copyWith(letterSpacing: 0, fontFamily: pixelFont);
  return t.copyWith(
    displayLarge: z(t.displayLarge),
    displayMedium: z(t.displayMedium),
    displaySmall: z(t.displaySmall),
    headlineLarge: z(t.headlineLarge),
    headlineMedium: z(t.headlineMedium),
    headlineSmall: z(t.headlineSmall),
    titleLarge: z(t.titleLarge),
    titleMedium: z(t.titleMedium),
    titleSmall: z(t.titleSmall),
    bodyLarge: z(t.bodyLarge),
    bodyMedium: z(t.bodyMedium),
    bodySmall: z(t.bodySmall),
    labelLarge: z(t.labelLarge),
    labelMedium: z(t.labelMedium),
    labelSmall: z(t.labelSmall),
  );
}

ThemeData farmTheme() {
  final scheme = ColorScheme.fromSeed(
    seedColor: Palette.leaf600,
    brightness: Brightness.light,
    primary: Palette.leaf600,
    onPrimary: Palette.cream50,
    secondary: Palette.wheat,
    onSecondary: Palette.bark900,
    error: Palette.berry,
    surface: Palette.cream100,
    onSurface: Palette.bark900,
    surfaceContainerHighest: Palette.cream200,
    outline: Palette.bark900,
  );
  const square = RoundedRectangleBorder(side: pxLine);
  return ThemeData(
    useMaterial3: true,
    colorScheme: scheme,
    fontFamily: pixelFont,
    textTheme: _unspaced(Typography.material2021(platform: TargetPlatform.macOS).black),
    scaffoldBackgroundColor: Palette.cream200,
    splashFactory: NoSplash.splashFactory,
    appBarTheme: const AppBarTheme(backgroundColor: Palette.bark600, foregroundColor: Palette.cream50, elevation: 0, scrolledUnderElevation: 0),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(backgroundColor: Palette.leaf600, foregroundColor: Palette.cream50, shape: square, elevation: 0),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(backgroundColor: Palette.cream50, foregroundColor: Palette.bark900, shape: square, side: pxLine),
    ),
    textButtonTheme: TextButtonThemeData(
      style: TextButton.styleFrom(foregroundColor: Palette.bark800, shape: square),
    ),
    inputDecorationTheme: const InputDecorationTheme(
      filled: true,
      fillColor: Palette.creamInput,
      isDense: true,
      border: OutlineInputBorder(borderRadius: BorderRadius.zero, borderSide: pxLine),
      enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.zero, borderSide: pxLine),
      focusedBorder: OutlineInputBorder(
        borderRadius: BorderRadius.zero,
        borderSide: BorderSide(color: Palette.leaf600, width: 2),
      ),
    ),
    chipTheme: const ChipThemeData(backgroundColor: Palette.cream50, shape: square, side: pxLine),
    dividerTheme: const DividerThemeData(color: Palette.bark900, thickness: 2),
    tooltipTheme: const TooltipThemeData(
      // A long message wraps instead of running the width of the window.
      constraints: BoxConstraints(maxWidth: 480),
      decoration: BoxDecoration(color: Palette.bark900),
      textStyle: TextStyle(color: Palette.cream50, fontFamily: pixelFont),
    ),
  );
}
