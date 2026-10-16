/// To five minutes; `tod` 0..1, 0.5 is noon.
String clockText(double tod) {
  final minutes = (tod * 24 * 60).floor();
  final m = minutes % 60;
  return '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(m - m % 5).toString().padLeft(2, '0')}';
}
