import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:vibevalley/host/desktop.dart';
import 'package:vibevalley/shell/desktop_title_bar.dart';

void main() {
  testWidgets('the title over the app has no fallback underline', (t) async {
    await t.pumpWidget(
      ProviderScope(
        overrides: [
          hostProvider.overrideWithValue(
            const Desktop(
              isDesktop: true,
              titleBarHeight: 28,
              title: '码农场物语',
              voiceShortcut: '',
              nativeVoice: false,
              voiceDispatch: true,
              commands: Stream.empty(),
            ),
          ),
        ],
        child: const Directionality(textDirection: TextDirection.ltr, child: DesktopTitleBar()),
      ),
    );
    final text = t.widget<RichText>(find.byType(RichText)).text as TextSpan;
    expect(text.toPlainText(), '码农场物语');
    expect(text.style?.decoration, TextDecoration.none);
  });
}
