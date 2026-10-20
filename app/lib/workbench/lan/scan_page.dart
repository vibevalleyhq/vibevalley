import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../../data/server_choice.dart';
import '../../ui/pixel/pixel.dart';

class ScanPage extends StatefulWidget {
  const ScanPage({super.key});

  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  bool _done = false;

  void _seen(BarcodeCapture capture) {
    if (_done) return;
    for (final code in capture.barcodes) {
      final text = code.rawValue;
      if (text != null && PairLink.parse(text) != null) {
        _done = true;
        Navigator.of(context).pop(text);
        return;
      }
    }
  }

  @override
  Widget build(BuildContext context) => ColoredBox(
    color: Palette.bark900,
    child: SafeArea(
      child: Stack(
        fit: StackFit.expand,
        children: [
          MobileScanner(onDetect: _seen),
          Positioned(
            left: 16,
            right: 16,
            bottom: 24,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(
                  '对准那台电脑「连接到本机」里的二维码',
                  textAlign: TextAlign.center,
                  style: PxText.sm.copyWith(color: Palette.cream50),
                ),
                const SizedBox(height: 12),
                PxButton.text('不扫了', onPressed: () => Navigator.of(context).pop()),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}
