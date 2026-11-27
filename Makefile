BASE ?= origin/main

.PHONY: help rust rust-changed rust-fast rust-audit rust-loom protocol protocol-write goldens ts mac mobile site docs check verify verify-fast dev-server dev-mac package-alpha bump build-alpha build-beta build-release

help:
	@printf '%s\n' \
		'  rust            cargo xtask check' \
		'  rust-changed    cargo xtask changed --base $(BASE)' \
		'  rust-fast       fmt --check + audit + changed --fast [BASE=<ref>]' \
		'  rust-audit      cargo xtask audit (boundaries, ratchets, arch, uml --strict, deps ui --strict)' \
		'  rust-loom       cargo xtask loom' \
		'  protocol        cargo xtask protocol' \
		'  protocol-write  cargo xtask protocol --write' \
		'  goldens         cargo xtask goldens --check' \
		'  ts              vp check --deny-warnings && vp run packages:check && vp test run' \
		'  mac             vp run mac:check' \
		'  mobile          vp run mobile:check' \
		'  site            vp run site:check && vp run site:build' \
		'  docs            vp run docs:verify' \
		'  check           rust + rust-audit + ts + docs' \
		'  verify          rust + rust-audit + protocol + ts + mac:build-test + docs' \
		'  verify-fast     rust-fast + protocol + ts + mac:check + mobile:check + docs [BASE=<ref>]' \
		'  dev-server      cargo run -p vibevalley-server' \
		'  dev-mac         cargo run -p vibevalley-mac' \
		'  package-alpha   vp run package:mac:alpha' \
		'  bump            vp run bump' \
		'  build-alpha     vp run build:alpha' \
		'  build-beta      vp run build:beta' \
		'  build-release   vp run build:release'

rust:
	cargo xtask check
rust-changed:
	cargo xtask changed --base $(BASE)
rust-fast:
	cargo fmt --all --check && cargo xtask audit && cargo xtask changed --base $(BASE) --fast
rust-audit:
	cargo xtask audit
rust-loom:
	cargo xtask loom
protocol:
	cargo xtask protocol
protocol-write:
	cargo xtask protocol --write
goldens:
	cargo xtask goldens --check
ts:
	vp check --deny-warnings && vp run packages:check && vp test run
mac:
	vp run mac:check
mobile:
	vp run mobile:check
site:
	vp run site:check && vp run site:build
docs:
	vp run docs:verify
check:
	$(MAKE) rust && $(MAKE) rust-audit && $(MAKE) ts && $(MAKE) docs
verify:
	$(MAKE) rust && $(MAKE) rust-audit && $(MAKE) protocol && $(MAKE) ts && vp run mac:build-test && $(MAKE) docs
verify-fast:
	$(MAKE) rust-fast BASE=$(BASE) && $(MAKE) protocol && $(MAKE) ts && vp run mac:check && vp run mobile:check && $(MAKE) docs
dev-server:
	cargo run -p vibevalley-server
dev-mac:
	cargo run -p vibevalley-mac
package-alpha:
	vp run package:mac:alpha
bump:
	vp run bump
build-alpha:
	vp run build:alpha
build-beta:
	vp run build:beta
build-release:
	vp run build:release
