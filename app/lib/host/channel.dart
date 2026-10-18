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

  String get displayName => label.isEmpty ? '码农场物语' : '码农场物语 $label';
  String get dmgFileName => name == 'release' ? 'vibevalley-arm64.dmg' : 'vibevalley-$name-arm64.dmg';

  /// The channel the build was given; an unknown name is a mistake in the build, not a release.
  static DesktopChannel named(String name) {
    for (final channel in values) {
      if (channel.name == name) return channel;
    }
    throw ArgumentError('unknown VIBEVALLEY_CHANNEL: $name');
  }

  String titled(String title) => label.isEmpty ? title : '$title · $label';
}

final DesktopChannel desktopChannel = DesktopChannel.named(const String.fromEnvironment('VIBEVALLEY_CHANNEL', defaultValue: 'release'));
