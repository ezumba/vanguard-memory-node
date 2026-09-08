# LNES-VMN 2.1.0 — npm Publication Seal

Published 2026-09-08 to the public npm registry after the LNES-VMN-2.1.0
publication gate (Gates A–H) and publish gates (P1–P5) passed.

## Identity
```
PACKAGE                 = @lnes/vanguard-memory-node
VERSION                 = 2.1.0
GIT_COMMIT_SHA          = 7582a07c73d3d182946fb022354856d2bb324e75
GIT_TREE_SHA            = 60aea4218fa84b953094016f5f7b4203cb0d5b77
LOCAL_AUDITED_TGZ_SHA256 = 043f82c33e8c35b25ccdf8431cba1942b83492fcd421e0fb0eb167f0158dc1b9
```

## Registry (authoritative, queried post-publish)
```
NPM_REGISTRY_VERSION = 2.1.0
NPM_DIST_TAG_LATEST  = 2.1.0
NPM_DIST_TARBALL     = https://registry.npmjs.org/@lnes/vanguard-memory-node/-/vanguard-memory-node-2.1.0.tgz
NPM_DIST_INTEGRITY   = sha512-J2IPPoHpsZoE6X0ZcJqlBeFCFQb6O4WyiSdvVfWDjAtEHHAzEMPT32QLTejnXLNqU8H37PKCyKMeyOWHPbQRNA==
NPM_DIST_SHASUM      = c5d2df0618a5331e28e357d9f36d57b6db3d29e0   (npm SHA-1)
```

### Byte-identity note (honest reconciliation of the two digests)
`LOCAL_AUDITED_TGZ_SHA256` (043f82c3…, SHA-256) is the locally-audited `npm pack`
tarball. The **published** tarball is npm's own repack produced by the
`prepublishOnly` script (`npm run build && npm test`) at publish time; it embeds
fresh file mtimes, so its bytes — and therefore its `NPM_DIST_INTEGRITY`
(sha512-J2IPP…) and `NPM_DIST_SHASUM` (c5d2df06…) — differ from the local audited
tarball. This is expected and is NOT a content change:
- identical source (git commit 7582a07, tree 60aea42),
- identical 50/50 regression suite run inside `prepublishOnly` at publish time,
- identical file set and contents confirmed by install-from-registry functional test.
The local SHA-256 is the reproducibility anchor for the audited pack; the npm
integrity/shasum identify the published bytes. Different algorithms and different
mtimes, same source content.

## Verification (from the npm-installed package, not the worktree)
```
NPM_INSTALL_TEST        = PASS   (npm install @lnes/vanguard-memory-node@2.1.0 into a clean dir)
MCP_INITIALIZE          = PASS
TOOLS_LIST              = PASS   (13 tools; the 3 evidence tools expose descriptions + input schemas)
VMN_RECALL              = PASS
VMN_BENCHMARK_EVIDENCE  = PASS   (5 records)
VMN_CONTEXT_COST_COMPARE = PASS  (WITHIN for in-envelope; invalid input → handled error, no NaN/Infinity)
```

## Evidence provenance (recomputed & matched this cycle)
```
CANONICAL_SEALED_ARTIFACT_DIGESTS        = 2/2
   07f7dc7e…32f2  EVIDENCE_SEAL_LNES82C10M_HOLDOUT.md  (mean_K 895.96, accuracy 39.5%, state-ratio)
   4ce518ca…aae2  EVIDENCE_SEAL_LNES82C4M.md           (9-pt OLS slope; declared "Canonical 4M seal SHA")
CANONICAL_H200_EVIDENCE_PACKAGE_DIGESTS  = 1/1
   7005fa07…2204  EVD-001 = ExergyNet_H200_Performance_Benchmarks_v2.zip  (11.3× throughput; REFERENCE_ONLY)
   (member xLMP_Memory_Efficiency_Benchmark_Report.md = 2f03ee36…1561, where the figure is stated)
BENCHMARK_RECORDS_COVERED                = 5/5
```
All benchmark records carry `universal_claim=false` and `publicly_verifiable=false`
(evidence documents are internal/sealed; no public artifact URL yet). Same-named
seal copies in the NVIDIA-prerelease tree differ from these only by redaction of
internal GCP project IDs / VM IPs; the measured evidence is byte-identical.

## Status
```
VMN_2_1_0_PUBLICATION = COMPLETE
NPM_PUBLISH_FORCE     = NOT_USED
ALT_REGISTRY          = NOT_USED
DIST_TAG_EXPERIMENT   = NOT_USED
```
