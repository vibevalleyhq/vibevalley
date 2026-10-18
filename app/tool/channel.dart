import 'dart:io';

// Packaging reads this pure library before pub has resolved the application dependencies.
// ignore: avoid_relative_lib_imports
import '../lib/host/channel.dart';

void main(List<String> args) {
  if (args.length != 1) {
    stderr.writeln('usage: channel.dart alpha|beta|release');
    exitCode = 2;
    return;
  }
  try {
    final channel = DesktopChannel.named(args.single);
    stdout.writeln([channel.productName, channel.displayName, channel.bundleId, channel.dmgFileName].join('\t'));
  } on ArgumentError catch (error) {
    stderr.writeln(error.message);
    exitCode = 2;
  }
}
