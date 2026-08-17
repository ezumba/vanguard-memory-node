# VMN v2.0.0 Release Provenance Record

**Prepared**: 2026-08-17 (post-publication GitHub synchronization pass)
**Purpose**: freeze the exact source lineage that produced the already-published
`@lnes/vanguard-memory-node@2.0.0` npm package, and record what changed on
GitHub after that publication (metadata/hygiene only, no functional change).

---

## Package identity

| Field | Value |
|---|---|
| PACKAGE | `@lnes/vanguard-memory-node@2.0.0` |
| NPM_STATUS | PUBLIC (verified live via `npm view`, independent of this session's publish action -- this session never ran `npm publish`; `npm whoami` remains unauthenticated here) |
| NPM_SHASUM | `0ef8426aa7346b324bef278d8c7d828b29f95d05` |
| NPM_INTEGRITY | `sha512-kXQoxxoBd8PlG9d1Xu5BWleJpoLUu+x6awZE27KjCE10Ef8uHjrO8O12DNL+SRuWkmM0FRc4QrPdFN4drgGaRg==` |
| NPM_FILE_COUNT | 17 |
| NPM_PACKAGE_SIZE | 35.3 kB |
| NPM_UNPACKED_SIZE | 140.3 kB |
| NPM_PUBLISHED_AT | 2026-08-17T16:44:16.899Z (from registry `time.modified`) |
| BUILD | PASS (`tsc`, clean) |
| TESTS | 34/34 PASS (30 pre-existing regression cases + 4 new cases covering `retrieve_evidence_adaptive` directly, including a constructed high-document-frequency case that forces the inline escape path) |

## Source repository

| Field | Value |
|---|---|
| SOURCE_REPO | `github.com/ezumba/vanguard-memory-node` |
| LOCAL_CHECKOUT | `/home/edt/vanguard_memory_node` (WSL2 Ubuntu) |

## Commit provenance -- three distinct references, not blurred

Per the standing rule that publish-time source and post-publish GitHub state
must be reported separately when a metadata-only cleanup happens after
publication:

| Reference | Commit | What it represents |
|---|---|---|
| **NPM_PUBLISHED_SOURCE_COMMIT** | `013149b` | The commit whose file contents were empirically confirmed byte-for-byte identical to the published npm tarball (verified by downloading the real tarball via `npm pack @lnes/vanguard-memory-node@2.0.0` and diffing every `dist/`, `src/`, and `package.json` file against this commit -- not inferred from the outer `.tgz` shasum, which is not reproducible across separate `npm pack` invocations due to gzip timestamp embedding). |
| **GITHUB_CURRENT_HEAD** | `2dd16f7` | Current `main` HEAD after 2 metadata/hygiene-only commits on top of `013149b`: `chore: normalize npm package metadata for v2.0.0` (repository.url normalized to `git+https://...`) and `chore: remove generated npm package artifact` (stray `vanguard-memory-node-1.2.0.tgz` untracked + `.gitignore` updated with `*.tgz`). Neither commit touches `dist/`, `src/*.ts` logic, or package version. |
| **GITHUB_V2_TAG_COMMIT** | `2dd16f7` | The annotated `v2.0.0` tag intentionally points at the cleaned-up HEAD, not the raw publish commit -- the tag marks "the state GitHub considers canonical for v2.0.0," which includes the disclosed metadata cleanup, not a claim that this exact commit produced the published bytes. |

**Verification method for NPM_PUBLISHED_SOURCE_COMMIT** (real, not assumed):
```
npm pack @lnes/vanguard-memory-node@2.0.0   # downloads the actual published tarball
tar xzf lnes-vanguard-memory-node-2.0.0.tgz
diff -q package/dist/core.js       <repo>/dist/core.js        # empty (identical)
diff -q package/dist/index.js      <repo>/dist/index.js       # empty (identical)
diff -q package/dist/compact_index.js <repo>/dist/compact_index.js  # empty (identical)
diff -q package/src/core.ts        <repo>/src/core.ts         # empty (identical)
diff -q package/src/index.ts       <repo>/src/index.ts        # empty (identical)
diff -q package/src/compact_index.ts <repo>/src/compact_index.ts  # empty (identical)
diff -q package/package.json       <repo>/package.json        # empty (identical)
```
All diffs were empty at the time this was checked (repo state = `013149b`).

## Full commit chain (this release)

```
2dd16f7 (HEAD, tag: v2.0.0, origin/main)  chore: remove generated npm package artifact
329d3d2                                    chore: normalize npm package metadata for v2.0.0
013149b  <- NPM_PUBLISHED_SOURCE_COMMIT   feat: graft LNES-86.6 adaptive retrieval (static Compact default + inline selectivity escape)
5a3a320                                    feat: implement namespace filtering and delta-ingestion (v1.5.1 prep)
34753d2  <- prior origin/main             docs: update README to v1.5.0
```

## Push/tag verification

| Check | Result |
|---|---|
| LOCAL_AHEAD (before push) | 4 commits |
| REMOTE_AHEAD | 0 (no unexpected commits found on origin) |
| DIVERGED | NO (`origin/main` confirmed a direct ancestor of local `main` via `git merge-base --is-ancestor`) |
| `git push origin main` | PASS -- `34753d2..2dd16f7  main -> main` |
| `v2.0.0` tag pre-existing (local or remote) | NO (checked both before creating) |
| `git push origin v2.0.0` | PASS -- `* [new tag] v2.0.0 -> v2.0.0` |
| Post-push `git fetch origin` + `rev-parse origin/main` | `2dd16f7...` (matches local HEAD exactly) |
| Working tree | CLEAN |
| HEAD_TAG_MATCH | YES (both resolve to `2dd16f7`) |

## Architecture summary (public-safe level; full mechanism is EDT TS)

`retrieve_evidence_adaptive()` in `core.ts` is now the default retrieval path
(wired into `vmn_recall`). No pre-router executes before retrieval -- every
call enters Compact candidate discovery directly, and the escape decision
reuses that step's own already-computed result rather than a separate
predictive classifier. `retrieve_evidence()` (plain linear scan) is
unchanged and still what the 14 original regression cases exercise directly,
and still what the escape path falls back to internally. Full derivation,
exact thresholds, and economics: `LNES86_ADAPTIVE_ROUTING_TS_R6.md` (EDT
internal, not reproduced here).

## Known, disclosed limitations (carried forward from LNES-86.6 validation, not new)

- Escaped queries carry a real, structural ~8.4% overhead vs calling
  `retrieve_evidence()` directly, because candidate discovery must scan the
  whole document before it can know to escape.
- The strict single-holdout-sample P99 gate narrowly missed in the LNES-86.6
  benchmark population (one large-document/no-hit outlier); a larger
  concurrency-sample showed a more favorable picture. This is a known
  envelope characteristic, not a defect introduced by this release.

## Explicitly not done in this pass

- No new benchmark/routing/threshold work (per directive: this was release
  synchronization, not a research sprint).
- No `npm publish` executed by this session (the package was already live
  when this pass began; verified independently via `npm view`, not assumed).
- No force-push, no tag overwrite, no git history rewrite.
