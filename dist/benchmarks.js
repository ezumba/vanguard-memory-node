/**
 * Evidence-native benchmark records for ExergyNet xLMP experiments.
 *
 * Every record carries: benchmark_id, measured_value, unit, tested_envelope,
 * derivation_type, evidence_class, evidence_sha256, publicly_verifiable, and
 * universal_claim=false.
 *
 * derivation_type semantics (do not conflate):
 *   MEASURED       — value read directly from a sealed measurement artifact.
 *   DERIVED        — value computed from measured quantities (formula/regression).
 *   REFERENCE_ONLY — value RESTATED from an internal engineering report; this
 *                    package did not run the experiment and does not carry
 *                    sealed-holdout evidence for it. It is a citation, not a seal.
 *
 * evidence_class semantics:
 *   SEALED_HOLDOUT              — evidence_sha256 pins a sealed holdout evidence doc.
 *   SEALED_REGRESSION          — evidence_sha256 pins a sealed regression evidence doc.
 *   INTERNAL_ENGINEERING_REPORT— evidence_sha256 pins an internal report (not a seal).
 *
 * evidence_sha256 is the SHA-256 of the referenced evidence document itself.
 *
 * publicly_verifiable — precise semantics:
 *   TRUE iff a PUBLIC consumer can independently OBTAIN and verify the referenced
 *   evidence artifact from this machine-readable record alone, WITHOUT privileged
 *   or internal access — i.e. there is a public, retrievable artifact that any
 *   third party could fetch and hash to confirm evidence_sha256.
 *   This is deliberately stronger than "is the artifact shipped in this npm
 *   package"; not shipping it is one reason a consumer cannot verify, but the
 *   field is about public obtainability anywhere, not package inclusion.
 *   It is FALSE for every record here because no public artifact URL exists yet:
 *   the seal documents and the H200 report are internal/sealed. Verification today
 *   requires possession of the named artifact and recomputation of its SHA-256.
 *   When an evidence seal is later published at a stable public URL, that record
 *   may add an evidence_url and set publicly_verifiable=true.
 */
export const BENCHMARK_RECORDS = [
    {
        benchmark_id: 'LNES82C10M-HOLDOUT-MEAN-K',
        experiment: 'LNES-82C.10M Genuine Holdout — Mean Active Inference Context',
        measured_value: 895.96,
        unit: 'tokens',
        tested_envelope: '10M adversarial synthetic corpus (est. 10,116,589 tokens, seed=42); ' +
            '5 runs × 190 queries = 950 total; all status=ok; ' +
            'model: Nemotron-3-Nano-Omni-30B-A3B-Reasoning via NIM on GCP A100; ' +
            'WSL2 runner; sealed 2026-09-04',
        derivation_type: 'MEASURED',
        evidence_class: 'SEALED_HOLDOUT',
        evidence_document: 'EVIDENCE_SEAL_LNES82C10M_HOLDOUT.md',
        evidence_sha256: '07f7dc7e1c463268dae81dee10bb3cca4b8aeb72843fae46538aa2e39a2e32f2',
        publicly_verifiable: false,
        universal_claim: false,
        claim_boundary: 'Single model (Nemotron-3-Nano-Omni-30B-A3B-Reasoning) on single hardware configuration ' +
            '(GCP A100 via NIM). Cross-model equivalence not tested. K is determined by xLMP adaptive ' +
            'retrieval; a different retrieval engine, query distribution, or corpus type could produce ' +
            'different K values.',
    },
    {
        benchmark_id: 'LNES82C10M-STATE-RATIO',
        experiment: 'LNES-82C.10M — State-to-Active-Context Ratio (derived from sealed holdout)',
        measured_value: 11291,
        unit: 'corpus_tokens_per_active_inference_token',
        tested_envelope: 'Same as LNES82C10M-HOLDOUT-MEAN-K; ' +
            'N = 10,116,589 est. corpus tokens; mean_K = 895.96; ratio = N / mean_K = 11,291.4',
        derivation_type: 'DERIVED',
        evidence_class: 'SEALED_HOLDOUT',
        evidence_document: 'EVIDENCE_SEAL_LNES82C10M_HOLDOUT.md',
        evidence_sha256: '07f7dc7e1c463268dae81dee10bb3cca4b8aeb72843fae46538aa2e39a2e32f2',
        publicly_verifiable: false,
        universal_claim: false,
        claim_boundary: 'This is accumulated corpus size divided by mean active inference context at one scale point. ' +
            'It is not a compression ratio, storage ratio, or assertion that every query accessed every ' +
            'corpus token. Measured at one model, one corpus size, one hardware configuration.',
        derivation_notes: 'DERIVED from the sealed LNES82C10M holdout: 10,116,589 / 895.96 = 11,291.4 ≈ 11,291. ' +
            'N is estimated from corpus character count (chars / CHARS_PER_TOKEN=3.1, frozen at harness default) ' +
            'and is confirmed as "Est tokens: 10,116,589" in the sealed holdout document. ' +
            'mean_K is mean NIM-reported prompt_tokens across all 950 holdout queries.',
    },
    {
        benchmark_id: 'LNES82C10M-ACCURACY',
        experiment: 'LNES-82C.10M Genuine Holdout — Task Accuracy (Q_BEND gate)',
        measured_value: 39.5,
        unit: 'percent_correct',
        tested_envelope: 'Same as LNES82C10M-HOLDOUT-MEAN-K; ' +
            'pre-registered floor = 40.0%; Q_BEND triggered at 39.5% (0.5 pp below floor); ' +
            'Q1=43.0%, Q2=62.5%, Q3=12.0%, Q4=16.0%',
        derivation_type: 'MEASURED',
        evidence_class: 'SEALED_HOLDOUT',
        evidence_document: 'EVIDENCE_SEAL_LNES82C10M_HOLDOUT.md',
        evidence_sha256: '07f7dc7e1c463268dae81dee10bb3cca4b8aeb72843fae46538aa2e39a2e32f2',
        publicly_verifiable: false,
        universal_claim: false,
        claim_boundary: 'Q_BEND formally triggered (accuracy < 40.0% pre-registered floor). ' +
            '950/950 queries returned status=ok. Q_BEND is a retrieval-quality characterization ' +
            'under adversarial corpus density at 10M scale, not a system failure. ' +
            'Primary driver: Q3 temporal-authority class = 12.0% (adversarial corpus designed to stress this dimension). ' +
            'Claiming Q_BEND proves system failure is PROHIBITED.',
    },
    {
        benchmark_id: 'LNES82C4M-OLS-9PT-SLOPE',
        experiment: 'LNES-82C.4M — 9-Point OLS Scaling Slope (K = a + b·N)',
        measured_value: 7.834e-7,
        unit: 'tokens_K_per_token_N',
        tested_envelope: '9 ladder points, nominal corpus range 32K–4M adversarial synthetic tokens; ' +
            'n=190 queries per point; intercept a=859.10; SE(b)=1.423e-5; t=0.055; ' +
            't-crit(95%, df=7)=±2.365; R²=0.0004; RMSE=52.61; ' +
            '95% CI for b: [-3.287e-5, +3.444e-5]',
        derivation_type: 'DERIVED',
        evidence_class: 'SEALED_REGRESSION',
        evidence_document: 'EVIDENCE_SEAL_LNES82C4M.md',
        evidence_sha256: '4ce518cadc515010ab02d7dfceb6494434b1edb7897d576fab42bbd0d0ebaae2',
        publicly_verifiable: false,
        universal_claim: false,
        claim_boundary: 'Slope b is not significantly different from zero (|t|=0.055, CI spans zero, R²=0.0004). ' +
            'This does not detect a material corpus-size-to-K scaling trend within the 32K–4M tested range. ' +
            'A local positive upturn exists at 2M→4M (paired ΔK bootstrap CI excludes zero from below) — the ' +
            'global null and the local upturn are both reported in the sealed doc. ' +
            'The 10M holdout scale point is not included in this regression.',
        derivation_notes: 'DERIVED (least-squares fit): K = 859.10 + 7.834e-7 · N. ' +
            'Prior 8-point regression (32K–2M) had b=-4.326e-5; adding the 4M point shifted slope toward zero. ' +
            'Pattern is non-monotonic, not systematically positive or negative.',
    },
    {
        benchmark_id: 'H200-XLMP-CORRECT-TASK-THROUGHPUT',
        experiment: 'H200 — xLMP vs Full-Context Correct-Task Throughput (internal report)',
        measured_value: 11.3,
        unit: 'x_correct_task_throughput_vs_full_context',
        tested_envelope: 'Single dedicated H200; 100 ten-step memory tasks; concurrency ramp to 50; ' +
            'xLMP prompt tokens flat ≈660–820 across the corpus range tested. ' +
            'Throughput compared at EACH method\'s highest tested SLA-compliant operating point: ' +
            'xLMP ~1,081 correct tasks/min vs ~96 for full-context ≈ 11.3×. ' +
            'Reported by the source as a TESTED FLOOR (xLMP never breached SLA at concurrency 50), not a measured ceiling.',
        derivation_type: 'REFERENCE_ONLY',
        evidence_class: 'INTERNAL_ENGINEERING_REPORT',
        evidence_document: 'ExergyNet_H200_Performance_Benchmarks_v2/02_XLMP_MEMORY_RETRIEVAL/' +
            '01_MEMORY_EFFICIENCY_BENCHMARK/xLMP_Memory_Efficiency_Benchmark_Report.md',
        evidence_sha256: '2f03ee367802694fdc7f921303d639275a4c522e82f424e25fb4a11608581561',
        publicly_verifiable: false,
        universal_claim: false,
        claim_boundary: 'REFERENCE_ONLY: this value is restated from an internal H200 engineering report ' +
            '(evidence_sha256 above); it is NOT sealed-holdout evidence and is NOT reproducible from this package. ' +
            'It is a throughput ratio at a specific SLA-compliant operating point (a tested floor), ' +
            'NOT a universal speedup, and NOT an HBM/VRAM, energy, or thermodynamic saving — the source report ' +
            'explicitly states HBM never saturated and prompt-token reduction is not equated with HBM-byte reduction. ' +
            'Different hardware (H200), corpus, and task design than the A100 LNES82C10M holdout; ' +
            'direct cross-configuration comparison is not valid.',
        derivation_notes: 'Source: "~11.3× the useful throughput of full context and ~1.7× that of the tested RAG" and ' +
            '"xLMP flat 659–822 tok" in the internal H200 memory-efficiency report. ' +
            'Prior record cited a nonexistent "EVD-001 / LNES59_Procurement_Bench" artifact; corrected 2026-09-08 ' +
            'to the real report with its recomputed SHA-256.',
    },
];
const MEASURED_K = 895.96;
const TESTED_ENVELOPE_MAX_N = 10116589;
const K_EVIDENCE_SOURCE = 'EVIDENCE_SEAL_LNES82C10M_HOLDOUT.md ' +
    '(sha256: 07f7dc7e1c463268dae81dee10bb3cca4b8aeb72843fae46538aa2e39a2e32f2)';
/** Reject non-finite / out-of-range inputs so the tool never emits NaN or Infinity. */
function requireFinite(name, value, opts = {}) {
    const { min = 0, minInclusive = false } = opts;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new RangeError(`${name} must be a finite number (got ${value})`);
    }
    if (minInclusive ? value < min : value <= min) {
        throw new RangeError(`${name} must be ${minInclusive ? '>=' : '>'} ${min} (got ${value})`);
    }
}
/**
 * Compute context cost comparison from measured xLMP data.
 * All arithmetic uses evidence-grade measured K from the LNES82C10M sealed holdout.
 * Throws RangeError on invalid input (negative/zero/non-finite) — callers surface it as an error.
 */
export function compute_context_comparison(corpus_tokens, queries_per_day = 1, assumed_full_context_tokens, cost_per_million_input_tokens) {
    requireFinite('corpus_tokens', corpus_tokens);
    requireFinite('queries_per_day', queries_per_day);
    if (assumed_full_context_tokens !== undefined) {
        requireFinite('assumed_full_context_tokens', assumed_full_context_tokens);
    }
    if (cost_per_million_input_tokens !== undefined) {
        // Cost may legitimately be 0 (free tier); only negative/non-finite are rejected.
        requireFinite('cost_per_million_input_tokens', cost_per_million_input_tokens, { min: 0, minInclusive: true });
    }
    const full_ctx = assumed_full_context_tokens ?? Math.min(corpus_tokens, 128000);
    const outside = corpus_tokens > TESTED_ENVELOPE_MAX_N;
    const ratio = full_ctx / MEASURED_K; // MEASURED_K is a nonzero constant — never divides by zero.
    const boundary_parts = [
        `K=${MEASURED_K} tokens is measured within the tested envelope ` +
            `(≤ ${TESTED_ENVELOPE_MAX_N.toLocaleString()} adversarial synthetic tokens, ` +
            'Nemotron-3-Nano-Omni-30B-A3B-Reasoning via NIM on GCP A100, sealed 2026-09-04). ' +
            'The sealed evidence document is internal and not shipped in this package (publicly_verifiable=false).',
    ];
    if (outside) {
        boundary_parts.push(`WARNING: corpus_tokens=${corpus_tokens.toLocaleString()} exceeds the tested envelope ` +
            `(${TESTED_ENVELOPE_MAX_N.toLocaleString()} tokens). ` +
            'K extrapolation beyond the tested range is not evidence-grade.');
    }
    boundary_parts.push('This computation assumes K ≈ MEASURED_K for corpus sizes within the tested envelope. ' +
        'Local slopes exist (LNES82C4M-OLS-9PT-SLOPE; b=7.834e-7, CI includes zero). ' +
        'Cross-model equivalence is untested. Savings shown are input-token cost only — ' +
        'not VRAM, energy, or wall-clock savings.');
    const result = {
        corpus_tokens,
        envelope_status: outside ? 'OUTSIDE_TESTED_ENVELOPE' : 'WITHIN_TESTED_ENVELOPE',
        measured_K_tokens: MEASURED_K,
        K_evidence_source: K_EVIDENCE_SOURCE,
        publicly_verifiable: false,
        assumed_full_context_tokens: full_ctx,
        active_context_ratio: Math.round(ratio * 100) / 100,
        claim_boundary: boundary_parts.join(' '),
        universal_claim: false,
    };
    if (cost_per_million_input_tokens !== undefined) {
        const cost_full = full_ctx * cost_per_million_input_tokens / 1000000;
        const cost_xlmp = MEASURED_K * cost_per_million_input_tokens / 1000000;
        const savings = cost_full - cost_xlmp;
        result.cost_comparison = {
            cost_per_million_input_tokens,
            cost_full_context_per_query_usd: Math.round(cost_full * 1e8) / 1e8,
            cost_xlmp_per_query_usd: Math.round(cost_xlmp * 1e8) / 1e8,
            savings_per_query_usd: Math.round(savings * 1e8) / 1e8,
            savings_per_day_usd: Math.round(savings * queries_per_day * 1e6) / 1e6,
            queries_per_day,
        };
    }
    return result;
}
