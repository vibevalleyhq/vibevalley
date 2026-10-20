import 'package:flutter/material.dart';

abstract final class Palette {
  static const ink950 = Color(0xFF14110E);
  static const ink900 = Color(0xFF1C1916);
  static const ink800 = Color(0xFF2A2520);
  static const ink700 = Color(0xFF3A342D);
  static const ink500 = Color(0xFF6F675C);
  static const ink300 = Color(0xFFAAA192);
  static const ink100 = Color(0xFFF1EBE0);
  static const paper = Color(0xFFFFFAF0);
  static const hat = Color(0xFFF2B53A);
  static const ok = Color(0xFF6CD38F);
  static const bad = Color(0xFFFF6A58);

  static const cream50 = Color(0xFFF7E8C4);
  static const cream100 = Color(0xFFEEDCB2);
  static const cream200 = Color(0xFFE2C995);
  static const cream300 = Color(0xFFC8A46E);
  static const creamHover = Color(0xFFF1DCAB);
  static const creamInput = Color(0xFFFFF4D8);
  static const bark400 = Color(0xFF9B7550);
  static const bark500 = Color(0xFF7F5B3B);
  static const bark600 = Color(0xFF67482D);
  static const bark800 = Color(0xFF46301D);
  static const bark900 = Color(0xFF2F1F13);
  static const leaf300 = Color(0xFFB4CB7C);
  static const leaf500 = Color(0xFF74A046);
  static const leaf600 = Color(0xFF5A8234);
  static const leaf700 = Color(0xFF3F6427);
  static const leafHover = Color(0xFF84B052);
  static const wheat = Color(0xFFE5A93C);
  static const wheatHover = Color(0xFFEFB84E);
  static const berry = Color(0xFFC84A3A);
  static const water = Color(0xFF4F8FBD);

  static const pxInk = Color(0xFF2F1F13);
  static const pxDrop = Color(0x401E140A);
  static const rim = Color(0xFFFFF4D8);

  static const ground = Color(0xFF2B3320);
}

/// The ink line every frame and divider is drawn with.
/// A control's edge: mid brown, not near-black, so a row of buttons and fields does not read as heavy.
const pxEdge = Palette.bark500;
const pxLine = BorderSide(color: pxEdge, width: 2);

const pixelFont = 'FusionPixel';

const monoFont = 'Menlo';

/// Chinese in code text has no glyph in these; it is drawn in the pixel font, so that comes last.
const monoFallback = ['SF Mono', 'Consolas', 'Courier New', 'monospace', pixelFont];

/// Long text to read: the system's Chinese sans, not bundled. The pixel font is sharp only at 12 and 24, too small and too big for a page.
const readFont = 'PingFang SC';
const readFallback = ['Hiragino Sans GB', 'Noto Sans CJK SC', 'Noto Sans SC', 'Microsoft YaHei', 'sans-serif'];

/// Code inside long text: its Chinese in the reading font rather than the pixel one.
const readMonoFallback = ['SF Mono', 'Consolas', 'Courier New', 'monospace', readFont, ...readFallback];

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
