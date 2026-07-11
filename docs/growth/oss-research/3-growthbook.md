# OSS Research 3: GrowthBook Bayesian Stats Engine (gbstats)

Source: github.com/growthbook/growthbook @ main (2026-07), `packages/stats/gbstats/` (Python).
Docs: docs.growthbook.io/statistics/{overview,details}, /app/experiment-results.

**License scope:** repo root LICENSE is MIT-Expat for everything EXCEPT
`packages/{back-end,front-end,shared}/*/enterprise` (GrowthBook Enterprise License).
`packages/stats/` has its own plain **MIT LICENSE** file (Copyright 2024 GrowthBook, Inc.)
— the entire stats engine we studied is safely MIT. Porting formulas + attribution is fine.

## 1. The exact math (extracted from gbstats)

**Surprise finding:** GrowthBook does NOT use a Beta-Binomial conjugate model. For
"binomial" metrics they use a **Normal approximation on the lift** (`bayesian/tests.py`
`EffectBayesianABTest`), with `ProportionStatistic` (`models/statistics.py:73`):
mean `p̂ = sum/n`, variance `p̂(1−p̂)`. Prior is Gaussian **on the effect** (default
*improper/flat*, i.e. prior precision 0; optional proper prior N(0, 0.3²) on relative
lift — "95% of effects between −60% and 60%", chosen from effects observed on GrowthBook).

- **Posterior (precision-weighted Gaussian conjugacy)**, tests.py:158-180:
  `post_prec = 1/V_data + 1/V_prior` (prior term dropped if improper);
  `μ_post = (μ_data/V_data + μ_prior/V_prior) / post_prec`; `σ_post = sqrt(1/post_prec)`.
  where `μ_data = p̂_B − p̂_A` (abs) or `(p̂_B − p̂_A)/p̂_A` (rel), `V_data` via delta method.
- **Chance to win** (tests.py:80): `P(diff > 0) = norm.sf(0; μ_post, σ_post) = Φ(μ/σ)`.
- **Credible interval** (utils.py:87): `norm.ppf([α/2, 1−α/2], μ_post, σ_post)`, α = 0.05.
- **Risk / expected loss** (tests.py:205, `get_risk`): with `P = Φ(0; μ, σ)`,
  `risk_ctrl = (1−P)·E[X | X>0]`, `risk_trt = −P·E[X | X<0]` (truncated-normal means).
  Numerical-stability guard: if `|μ/σ| > 37` short-circuit to `[max(μ,0), max(−μ,0)]`
  because `Φ` saturates in float64; also a Mills-ratio asymptote for truncnorm tails
  (utils.py:38, `E[X|X<b] ≈ b + σ²/(b−μ)` once standardized bound ≥ 1e3).
- **Thompson sampling bandit** (bayesian/bandits.py): Gaussian posterior per arm
  (same precision-weighting), then **Monte Carlo**: draw 10,000 samples from all arms
  jointly, weight_i = fraction of draws where arm i is best. Production uses
  **top-two TS** (share credit between the best and second-best arm per draw) to keep
  exploring; weights are floored at `min_variation_weight = 0.01` then renormalized;
  weights are **refused entirely unless every arm has n ≥ 100** ("total sample size
  must be at least 100 per variation").
- **SRM check** (utils.py:70, `check_srm`): Pearson chi-squared against expected split.
  `x = Σ_i (O_i − E_i)²/E_i` with `E_i = w_i/Σw · N_total` (arms with weight ≤ 0 skipped);
  p = `chi2.sf(x, k−1)`. Returns p = 1 if no traffic. **Warn threshold p < 0.001**
  (docs: "you shouldn't trust the results since they are likely misleading").

**For Watrloo we keep GrowthBook's decision quantities (chance-to-win, CI, expected loss,
TS weights, SRM) but swap the Normal-approx posterior for the exact Beta-Binomial**, since
at tens of clicks `p̂(1−p̂)/n` Normal intervals go negative and misbehave. Conjugate update:
prior Beta(α₀, β₀) → posterior **Beta(α₀ + clicks, β₀ + impressions − clicks)**;
mean `α/(α+β)`, variance `αβ/((α+β)²(α+β+1))`. Chance-to-win has an exact closed form when
α_B is a positive integer (Evan Miller): `P(B>A) = Σ_{i=0}^{α_B−1} exp( lnB(α_A+i, β_A+β_B)
− ln(β_B+i) − lnB(1+i, β_B) − lnB(α_A, β_A) )` — do it in log space or the Beta functions
underflow around n ≈ 300. Non-integer α (pooled priors) → Monte Carlo fallback below.

## 2. Port-ready TypeScript (zero dependencies, validated vs scipy 1.13)

```typescript
// ---------- special functions ----------
/** Lanczos log-gamma (g=7, n=9). |err| < 1e-13 for x > 0. */
export function lgamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}
const lbeta = (a: number, b: number) => lgamma(a) + lgamma(b) - lgamma(a + b);

/** Lentz continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(x: number, a: number, b: number): number {
  const FPMIN = 1e-300;
  const qab = a + b, qap = a + 1, qam = a - 1;
  let c = 1, d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d; h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a,b) = Beta CDF. Uses the symmetry
 *  I_x(a,b) = 1 − I_{1−x}(b,a) to stay in the fast-converging region. */
export function regIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBt = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lnBt); // log-space front factor: no underflow at large a+b
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a
                                   : 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** Inverse Beta CDF (quantile). Bisection to 1e-12 bracket + Newton polish
 *  (Newton step clamped inside the bracket so it can never diverge). */
export function invRegIncompleteBeta(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0, hi = 1, mid = 0.5;
  for (let i = 0; i < 100; i++) {
    mid = (lo + hi) / 2;
    if (regIncompleteBeta(mid, a, b) > p) hi = mid; else lo = mid;
    if (hi - lo < 1e-12) break;
  }
  for (let i = 0; i < 8; i++) { // Newton polish via Beta pdf
    const val = regIncompleteBeta(mid, a, b);
    const pdf = Math.exp((a - 1) * Math.log(mid) + (b - 1) * Math.log(1 - mid) - lbeta(a, b));
    if (!isFinite(pdf) || pdf <= 0) break;
    let next = mid - (val - p) / pdf;
    if (!isFinite(next) || next <= lo || next >= hi) next = (lo + hi) / 2;
    if (val > p) hi = mid; else lo = mid;
    mid = next;
  }
  return mid;
}

// ---------- Beta-Binomial posterior for CTR ----------
export interface BetaPosterior { alpha: number; beta: number; mean: number; variance: number; }

/** Posterior over CTR. Default prior Beta(1,1) (uniform); pass a pooled
 *  empirical-Bayes prior (e.g. alpha0=k*pbar, beta0=k*(1-pbar), k≈10-20) when available. */
export function ctrPosterior(clicks: number, impressions: number,
                             alpha0 = 1, beta0 = 1): BetaPosterior {
  if (clicks < 0 || impressions < clicks) throw new Error("invalid counts");
  const alpha = alpha0 + clicks, beta = beta0 + (impressions - clicks);
  const s = alpha + beta;
  return { alpha, beta, mean: alpha / s, variance: (alpha * beta) / (s * s * (s + 1)) };
}
// Test: ctrPosterior(51,100) -> Beta(52,50): mean 0.5098039215686274,
//       variance 0.0024262512924454 (scipy beta.mean/var exact match).
// Test: ctrPosterior(5,100) -> Beta(6,96): mean 6/102 = 0.058823529411764705.

/** Central 95% credible interval of a Beta posterior. */
export function credibleInterval95(post: BetaPosterior): [number, number] {
  return [invRegIncompleteBeta(0.025, post.alpha, post.beta),
          invRegIncompleteBeta(0.975, post.alpha, post.beta)];
}
// Test: Beta(52,50) -> [0.4132834747335, 0.6059600394771] (scipy: 0.41328347473354593,
//       0.6059600394771283; port agrees to ~1e-12).
// Test: Beta(6,96) -> [0.0221105724093, 0.1117550586347] (scipy match to ~1e-10),
//       i.e. "5 clicks in 100: CTR ~5.9%, likely 2.2%-11.2%".

// ---------- Chance to win: P(B > A) ----------
/** Exact (Evan Miller closed form) when b.alpha is a positive integer —
 *  always true with integer priors + integer clicks. Log-space per term to
 *  avoid the Beta-function underflow that hits a naive product near n≈300.
 *  Falls back to seeded Monte Carlo for non-integer alpha (pooled priors). */
export function chanceToWin(a: BetaPosterior, b: BetaPosterior, mcDraws = 20000): number {
  if (Number.isInteger(b.alpha) && b.alpha > 0 && b.alpha <= 10000) {
    let total = 0;
    for (let i = 0; i < b.alpha; i++)
      total += Math.exp(lbeta(a.alpha + i, a.beta + b.beta) - Math.log(b.beta + i)
                        - lbeta(1 + i, b.beta) - lbeta(a.alpha, a.beta));
    return Math.min(1, Math.max(0, total));
  }
  const rnd = mulberry32(0x5eed_ca7); // fixed seed: stable UI numbers across renders
  let wins = 0;
  for (let i = 0; i < mcDraws; i++)
    if (randBeta(b.alpha, b.beta, rnd) > randBeta(a.alpha, a.beta, rnd)) wins++;
  return wins / mcDraws;
}
// Test: A=Beta(50,52) (49/100), B=Beta(52,50) (51/100) -> 0.6107705226878
//       (closed form ref 0.610770522687837; 2e7-draw MC gives 0.61071).
// Test (Watrloo scale): A 4 clicks/210, B 7/198, Beta(1,1) priors ->
//       chanceToWin(Beta(5,207), Beta(8,192)) = 0.8368242682210 — "leaning B,
//       but 1-in-6 it's wrong": exactly why we don't show a winner badge here.

// ---------- Thompson sampling ----------
/** Deterministic 32-bit PRNG (only needed where reproducibility matters;
 *  Math.random is fine for live serving). */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Marsaglia-Tsang (2000) Gamma(shape,1) sampler; shape<1 via Johnk boost. */
function randGamma(shape: number, rnd: () => number): number {
  if (shape < 1) return randGamma(shape + 1, rnd) * Math.pow(rnd() || 1e-300, 1 / shape);
  const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number, v: number;
    do { // Box-Muller standard normal
      const u1 = rnd(), u2 = rnd();
      x = Math.sqrt(-2 * Math.log(u1 || 1e-300)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rnd();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
/** Beta(a,b) draw via two Gammas: X/(X+Y). */
export function randBeta(a: number, b: number, rnd: () => number = Math.random): number {
  const x = randGamma(a, rnd), y = randGamma(b, rnd);
  return x / (x + y);
}
// Test: 200k draws of randBeta(6,96): sample mean 0.05880 (true 0.058824),
//       sample var 5.405e-4 (true 5.375e-4) — within MC error.

/** One Thompson-sampling pick: sample each arm's posterior, return argmax index.
 *  GrowthBook guardrails worth copying: floor each arm's long-run share at 1%-2%
 *  (they use 0.01) and force an even split until every arm clears a minimum-n
 *  floor (GrowthBook refuses weights below n=100/arm; Watrloo plan uses >=50
 *  impressions/arm, fine at our volume — the point is HAVING a floor). */
export function thompsonPick(variants: { clicks: number; impressions: number }[],
                             minImpressions = 50, rnd: () => number = Math.random): number {
  if (variants.length === 0) throw new Error("no variants");
  if (variants.some(v => v.impressions < minImpressions))
    return Math.floor(rnd() * variants.length); // even split below the floor
  let best = 0, bestDraw = -1;
  variants.forEach((v, i) => {
    const p = ctrPosterior(v.clicks, v.impressions);
    const draw = randBeta(p.alpha, p.beta, rnd);
    if (draw > bestDraw) { bestDraw = draw; best = i; }
  });
  return best;
}
// Test: [{51/1000},{102/1000}] picks index 1 in ~98% of calls; [{5/60},{5/60}]
//       splits ~50/50; any arm under 50 impressions -> uniform random.

// ---------- SRM check (chi-squared, ported from gbstats utils.check_srm) ----------
/** Regularized lower incomplete gamma P(s,x): series for x<s+1, Lentz CF otherwise. */
function lowerGammaP(s: number, x: number): number {
  if (x <= 0) return 0;
  if (x < s + 1) {
    let sum = 1 / s, term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (s + n); sum += term;
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - lgamma(s));
  }
  const FPMIN = 1e-300;
  let b = x + 1 - s, c = 1 / FPMIN, d = 1 / b, h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b; if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c; if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x + s * Math.log(x) - lgamma(s)) * h;
}
const chiSqSF = (x: number, df: number) => 1 - lowerGammaP(df / 2, x / 2);
// Test: chiSqSF(10.83,1)=0.00099868638, chiSqSF(3.84,1)=0.05004352,
//       chiSqSF(12.5,2)=0.00193045414 (all match scipy chi2.sf to ~1e-13).

/** p-value that the observed per-variant counts match the intended split.
 *  Flag SRM when p < 0.001 (GrowthBook's default warn threshold) AND total
 *  is big enough for the chi-squared approx (expected count >= ~5 per arm). */
export function srmCheck(observed: number[], weights: number[]): number {
  const total = observed.reduce((s, o) => s + o, 0);
  if (!total) return 1;
  const wSum = weights.reduce((s, w) => s + w, 0);
  let x = 0;
  observed.forEach((o, i) => {
    if (weights[i] <= 0) return;
    const e = (weights[i] / wSum) * total;
    x += ((o - e) ** 2) / e;
  });
  return chiSqSF(x, observed.length - 1);
}
// Test: srmCheck([520,480],[0.5,0.5]) = 0.20590321 (scipy ref 0.2059032107320647)
//       -> fine. srmCheck([620,380],[0.5,0.5]) ~ 3.2e-14 -> SRM, halt the test.
```

## 3. UI honesty rules (from GrowthBook docs + code)

- **Three-state verdict, never two**: chance-to-win >= 95% -> green "clear winner";
  <= 5% -> red "clear loser"; anything between is **greyed out as inconclusive** with the
  exact framing "there's either no measurable difference or you haven't gathered enough
  data yet." No intermediate "leading"/"trending" language.
- **Refuse, don't degrade**: when the math can't run (zero traffic, zero variance,
  zero baseline), gbstats returns a neutral default — `chanceToWin = 0.5, expected = 0,
  ci = (0,0)` plus an errorMessage — rather than a shaky number (tests.py `_default_output`).
  The bandit refuses to emit weights at all under 100 units/arm and says why in plain
  words. Port this pattern: Watrloo's "<30 clicks -> raw counts only" floor is the
  same idea, stricter.
- **Uncertainty is the headline**: results render as posterior violin plots / intervals,
  "as you collect more data, the tails ... shorten, indicating more certainty" —
  the interval IS the result; the point estimate is decoration.
- **Decisions via risk, not just probability**: alongside chance-to-win they show
  "Risk" = expected loss if you ship the wrong variant, so a 90%-CTW variant with tiny
  downside can be shipped without fake significance. (Watrloo idea #7's stopping rule
  — CTW > 0.95 AND expected loss < tolerance — matches GrowthBook's semantics.)
- **SRM gate before any verdict**: p < 0.001 on the split check -> banner that results
  "are likely misleading"; fix the bug and restart, never reinterpret.
- **Priors are disclosed knobs**: default is deliberately uninformative; the proper prior
  N(0, 0.3²) is documented with its plain-English meaning ("95% of effects between −60%
  and 60%"). When Watrloo pools priors across campaigns (#5), state it in the UI the same
  way ("similar ads on this surface usually get ~X%").

**Caveats for the port**: chanceToWin's closed form is O(alpha_B) — capped at 10k
iterations, well past Watrloo volume; the MC fallback covers pooled non-integer priors.
All reference values above were verified by executing the JS equivalent of this code
against scipy 1.13 (beta.ppf / chi2.sf / 2e7-draw Monte Carlo).
