import 'package:flutter/widgets.dart';

Duration motionDuration(BuildContext context, Duration d) => (MediaQuery.maybeDisableAnimationsOf(context) ?? false) ? Duration.zero : d;

bool motionAllowed(BuildContext context) => !(MediaQuery.maybeDisableAnimationsOf(context) ?? false);
