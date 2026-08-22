# Phase 3 Closeout — provenance + progress

## Immutable starting provenance (§1)
- baseline git commit: a8475902ec8a83ccec2ea90c9630da3dd8e62a3c
- working tree: uncommitted Phase 2/3 (src/harness/*, extensions/pi-harness.ts, tests, docs, tarballs)
- pi-harness-isolated-0.3.0.tar.gz sha256: 81609b9c14c9a82d15c74ac126e70ec73c56e4537e5bb72dbbfe7da76f006e70  (MATCHES expected)
- Pi: 0.84.1 · Node: v22.22.3 · OS: Linux 7.2.0-1-cachyos-kfdfix
- baseline in-repo unit: 568/568
- baseline live: harness 25/25, delegate 41/41, reviewer corpus 66/66, reviewer stress 2/2 models

## Ordering decision
Audit serialization (§4-9) -> commit+tag (§10) -> build final 0.3.1 (§11)
-> packaged-artifact live acceptance (§2/§3) against the FINAL artifact -> instrument audit (§12).
Reason: §11 requires live packaged counts from committed source; testing 0.3.0 then
rebuilding would prove the wrong tarball.

## Progress log
- [x] §1 provenance recorded
- [ ] §4 reproduce audit fork (pre-fix counterexample)
- [ ] §5 serialize audit writes
- [ ] §6 crash-window ordering
- [ ] §7 multi-process regression test
- [ ] §8 mutation/ablation
- [ ] §9 reconcile audit docs
- [ ] §10 commit + tag v0.3.1
- [ ] §11 build final artifact, reproducibility
- [ ] §2/§3 packaged-artifact live acceptance
- [ ] §12 instrument self-audit
- [ ] §14 final report
