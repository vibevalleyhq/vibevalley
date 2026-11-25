.PHONY: help rust rust-changed rust-audit rust-loom protocol protocol-write goldens ts mac mobile site docs check verify dev-server dev-mac

help:
	@printf '%s\n' \
		'  rust            cargo xtask check' \
		'  rust-changed    cargo xtask changed' \
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
		'  dev-server      cargo run -p vibevalley-server' \
		'  dev-mac         cargo run -p vibevalley-mac'

rust:
	cargo xtask check
rust-changed:
	cargo xtask changed
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
dev-server:
	cargo run -p vibevalley-server
dev-mac:
	cargo run -p vibevalley-mac
