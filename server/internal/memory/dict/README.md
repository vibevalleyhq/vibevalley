`zh_s.txt.gz` is gse v1.1.0's `data/dict/zh/s_1.txt` (the simplified Chinese dictionary), `gzip -9 -n`. Upgrading gse means
taking its new one the same way and raising `TermsVersion` in `terms.go`, so every memory is cut again (NOTICE says where it is from).
