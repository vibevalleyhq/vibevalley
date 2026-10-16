// Release channels (ported from the Electron client's channel.ts, removed): alpha, beta and release install
// side by side, each with its own name, bundle id (tool/build-macos.sh writes it into the bundle) and vibevalley home.
// The channel is fixed at build time: --dart-define=VIBEVALLEY_CHANNEL=alpha|beta (release without one).

enum DesktopChannel {
  release('', 'vibevalley', 'dev.vibevalley.app'),
  beta('Beta', 'vibevalley Beta', 'dev.vibevalley.app.beta'),
  alpha('Alpha', 'vibevalley Alpha', 'dev.vibevalley.app.alpha');

  const DesktopChannel(this.label, this.productName, this.bundleId);

  /// Shown after the app's name in titles; empty for release.
  final String label;

  /// The app's name; also its folder under ~/Library/Application Support and ~/Library/Logs.
  final String productName;
  final String bundleId;

  static DesktopChannel named(String name) => values.firstWhere((c) => c.name == name, orElse: () => release);

  /// A title with the channel after it: 「码农场物语 · Alpha」.
  String titled(String title) => label.isEmpty ? title : '$title · $label';
}

/// The channel this app was built for.
final DesktopChannel desktopChannel = DesktopChannel.named(const String.fromEnvironment('VIBEVALLEY_CHANNEL', defaultValue: 'release'));
