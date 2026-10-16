// The channel is fixed at build time: --dart-define=VIBEVALLEY_CHANNEL=alpha|beta (release without one).

enum DesktopChannel {
  release('', 'vibevalley', 'dev.vibevalley.app'),
  beta('Beta', 'vibevalley Beta', 'dev.vibevalley.app.beta'),
  alpha('Alpha', 'vibevalley Alpha', 'dev.vibevalley.app.alpha');

  const DesktopChannel(this.label, this.productName, this.bundleId);

  final String label;

  /// Also its folder under ~/Library/Application Support and ~/Library/Logs.
  final String productName;
  final String bundleId;

  static DesktopChannel named(String name) => values.firstWhere((c) => c.name == name, orElse: () => release);

  String titled(String title) => label.isEmpty ? title : '$title · $label';
}

final DesktopChannel desktopChannel = DesktopChannel.named(const String.fromEnvironment('VIBEVALLEY_CHANNEL', defaultValue: 'release'));
