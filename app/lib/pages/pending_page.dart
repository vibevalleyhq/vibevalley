// A desk page not moved over from the web page yet: says what it will hold.

import 'package:flutter/material.dart';

import '../app/theme.dart';

class PendingPage extends StatelessWidget {
  const PendingPage({super.key, required this.what});
  final String what;

  @override
  Widget build(BuildContext context) => Center(
    child: Container(
      constraints: const BoxConstraints(maxWidth: 420),
      padding: const EdgeInsets.all(20),
      decoration: pixelBox(),
      child: Text('「$what」还在从网页版搬过来', style: const TextStyle(fontSize: 16, color: Palette.bark900)),
    ),
  );
}
