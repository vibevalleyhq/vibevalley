BASE ?= origin/main
PKG ?=
SCENE ?= all
VDP_OUT ?= /tmp/vv-vdp

.PHONY: help fmt i18n gen rust rust-clippy rust-test rust-changed rust-fast rust-audit rust-loom protocol protocol-write goldens ts mac mobile site docs check verify verify-fast pr-check vdp vdp-ui vdp-fast dev-server dev-mac package-alpha package-alpha-dmg deadcode patrol comment-review bump build-alpha build-beta build-release

help:
	@printf '%s\n' \
		'  fmt              cargo fmt --all && vp check --fix --deny-warnings' \
		'  i18n             vp run i18n:gen && vpx scripts/gen/i18n.ts check' \
		'  gen              protocol-write + api:client + capabilities + i18n' \
		'  rust             cargo xtask check' \
		'  rust-clippy      cargo clippy --workspace --all-targets -- -D warnings' \
		'  rust-test        cargo nextest run --profile fast [PKG=<crate>]' \
		'  rust-changed     cargo xtask changed --base $(BASE)' \
		'  rust-fast        fmt --check + audit + changed --fast [BASE=<ref>]' \
		'  rust-audit       cargo xtask audit (boundaries, ratchets, arch, uml --strict, deps ui --strict)' \
		'  rust-loom        cargo xtask loom' \
		'  protocol         cargo xtask protocol' \
		'  protocol-write   cargo xtask protocol --write' \
		'  goldens          cargo xtask goldens --check' \
		'  ts               vp check --deny-warnings && vp run packages:check && vp test run' \
		'  mac              vp run mac:check' \
		'  mobile           vp run mobile:check' \
		'  site             vp run site:check && vp run site:build' \
		'  docs             vp run docs:verify' \
		'  check            rust + rust-audit + ts + docs' \
		'  verify           rust + rust-audit + protocol + ts + mac:build-test + docs' \
		'  verify-fast      rust-fast + protocol + ts + mac:check + mobile:check + docs [BASE=<ref>]' \
		'  pr-check         verify + mobile' \
		'  vdp              vp run vdp $(SCENE) --out $(VDP_OUT)' \
		'  vdp-ui           vp run vdp $(SCENE) --ui-only --out $(VDP_OUT)' \
		'  vdp-fast         vp run vdp $(SCENE) --skip-build --out $(VDP_OUT)' \
		'  dev-server       cargo run -p vibevalley-server' \
		'  dev-mac          cargo run -p vibevalley-mac' \
		'  package-alpha    vp run package:mac:alpha' \
		'  package-alpha-dmg vp run package:mac:alpha:dmg' \
		'  deadcode         vp run deadcode' \
		'  patrol           vp run patrol -- scan' \
		'  comment-review   vpx scripts/audit/comment-review.ts' \
		'  bump             vp run bump' \
		'  build-alpha      vp run build:alpha' \
		'  build-beta       vp run build:beta' \
		'  build-release    vp run build:release'

fmt:
	cargo fmt --all && vp check --fix --deny-warnings
i18n:
	vp run i18n:gen && vpx scripts/gen/i18n.ts check
gen:
	$(MAKE) protocol-write && vp run api:client && vp run capabilities && $(MAKE) i18n
rust:
	cargo xtask check
rust-clippy:
	cargo clippy --workspace --all-targets -- -D warnings
rust-test:
	cargo nextest run --profile fast $(if $(PKG),-p $(PKG),--workspace)
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
pr-check:
	$(MAKE) verify && $(MAKE) mobile
vdp:
	vp run vdp $(SCENE) --out $(VDP_OUT)
vdp-ui:
	vp run vdp $(SCENE) --ui-only --out $(VDP_OUT)
vdp-fast:
	vp run vdp $(SCENE) --skip-build --out $(VDP_OUT)
dev-server:
	cargo run -p vibevalley-server
dev-mac:
	cargo run -p vibevalley-mac
package-alpha:
	vp run package:mac:alpha
package-alpha-dmg:
	vp run package:mac:alpha:dmg
deadcode:
	vp run deadcode
patrol:
	vp run patrol -- scan
comment-review:
	vpx scripts/audit/comment-review.ts
bump:
	vp run bump
build-alpha:
	vp run build:alpha
build-beta:
	vp run build:beta
build-release:
	vp run build:release
