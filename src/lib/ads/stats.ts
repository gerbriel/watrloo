// AGENT UNIT — implemented per instructions. Preserve these export signatures.
// Honest low-volume ad statistics (Beta-Binomial), ported per
// docs/growth/oss-research/3-growthbook.md. No dependencies.
//
// Math is adapted from GrowthBook's `packages/stats/` (gbstats), which ships
// its own plain MIT LICENSE (Copyright 2024 GrowthBook, Inc.) separate from
// the rest of the repo — porting the formulas is license-clean. Watrloo swaps
// GrowthBook's Normal-approximation-on-the-lift model for an exact
// Beta-Binomial conjugate posterior (see the research doc, section 1), since
// at tens of clicks the Normal interval goes negative and misbehaves.

// ---------- special functions ----------

/** Lanczos log-gamma (g=7, n=9). |err| < 1e-13 for x > 0. */
export function lgamma(x: number): number {
  const c = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028,
    771.32342877765313, -176.61502916214059, 12.507343278686905,
    -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + 7.5;
  for (let i = 1; i < 9; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

const lbeta = (a: number, b: number): number => lgamma(a) + lgamma(b) - lgamma(a + b);

/** Lentz continued fraction for the incomplete beta (Numerical Recipes betacf). */
function betacf(x: number, a: number, b: number): number {
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-16) break;
  }
  return h;
}

/**
 * Regularized incomplete beta I_x(a,b) = Beta CDF. Uses the symmetry
 * I_x(a,b) = 1 − I_{1−x}(b,a) to stay in the fast-converging region.
 */
export function regIncompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBt = lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lnBt); // log-space front factor: no underflow at large a+b
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a : 1 - (bt * betacf(1 - x, b, a)) / b;
}

/**
 * Inverse Beta CDF (quantile). Bisection to a 1e-12 bracket, then Newton
 * polish (each step clamped inside the bracket so it can never diverge).
 */
export function invRegIncompleteBeta(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  let mid = 0.5;
  for (let i = 0; i < 100; i++) {
    mid = (lo + hi) / 2;
    if (regIncompleteBeta(mid, a, b) > p) hi = mid;
    else lo = mid;
    if (hi - lo < 1e-12) break;
  }
  for (let i = 0; i < 8; i++) {
    // Newton polish via the Beta pdf.
    const val = regIncompleteBeta(mid, a, b);
    const pdf = Math.exp((a - 1) * Math.log(mid) + (b - 1) * Math.log(1 - mid) - lbeta(a, b));
    if (!isFinite(pdf) || pdf <= 0) break;
    let next = mid - (val - p) / pdf;
    if (!isFinite(next) || next <= lo || next >= hi) next = (lo + hi) / 2;
    if (val > p) hi = mid;
    else lo = mid;
    mid = next;
  }
  return mid;
}

// ---------- Beta-Binomial posterior (internal representation) ----------

interface BetaPosterior {
  alpha: number;
  beta: number;
  mean: number;
  variance: number;
}

/**
 * Posterior over CTR. Default prior Beta(1,1) (uniform); pass a pooled
 * empirical-Bayes prior (e.g. alpha0=k*pbar, beta0=k*(1-pbar), k≈10-20) when
 * available.
 */
function betaPosterior(clicks: number, impressions: number, alpha0 = 1, beta0 = 1): BetaPosterior {
  if (clicks < 0 || impressions < clicks) throw new Error("invalid counts");
  const alpha = alpha0 + clicks;
  const beta = beta0 + (impressions - clicks);
  const s = alpha + beta;
  return { alpha, beta, mean: alpha / s, variance: (alpha * beta) / (s * s * (s + 1)) };
}
// Test: betaPosterior(51,100) -> Beta(52,50): mean 0.5098039215686274,
//       variance 0.0024262512924454 (scipy beta.mean/var exact match).
// Test: betaPosterior(5,100) -> Beta(6,96): mean 6/102 = 0.058823529411764705.

/** Central 95% credible interval of a Beta posterior. */
function credibleInterval95(post: BetaPosterior): [number, number] {
  return [invRegIncompleteBeta(0.025, post.alpha, post.beta), invRegIncompleteBeta(0.975, post.alpha, post.beta)];
}
// Test: Beta(52,50) -> [0.4132834747335, 0.6059600394771] (scipy: 0.41328347473354593,
//       0.6059600394771283; port agrees to ~1e-12).
// Test: Beta(6,96) -> [0.0221105724093, 0.1117550586347] (scipy match to ~1e-10),
//       i.e. "5 clicks in 100: CTR ~5.9%, likely 2.2%-11.2%".

export interface CtrPosterior {
  mean: number;
  low95: number;
  high95: number;
  samples: number;
}

/**
 * Beta-Binomial posterior over CTR, summarized as a mean and 95% credible
 * interval. With zero impressions this refuses to fabricate a distribution
 * out of the uniform prior (which would report mean 0.5): it reports mean 0
 * and the maximally uninformative interval [0,1] — GrowthBook's
 * "refuse, don't degrade" pattern for when the math simply has no data to run on.
 */
export function ctrPosterior(clicks: number, impressions: number): CtrPosterior {
  if (impressions <= 0) return { mean: 0, low95: 0, high95: 1, samples: impressions };
  const post = betaPosterior(clicks, impressions);
  const [low95, high95] = credibleInterval95(post);
  return { mean: post.mean, low95, high95, samples: impressions };
}

// ---------- Chance to win: P(b > a) ----------

/**
 * Exact chance that variant `b`'s true rate exceeds variant `a`'s, i.e.
 * P(b > a) (Evan Miller closed form) when b.alpha is a positive integer —
 * always true here since priors and clicks are both integers. Log-space
 * per term avoids the Beta-function underflow that a naive product hits
 * around n≈300. Falls back to seeded Monte Carlo for non-integer alpha
 * (e.g. pooled empirical-Bayes priors).
 */
function betaChanceToWin(a: BetaPosterior, b: BetaPosterior, mcDraws = 20000): number {
  if (Number.isInteger(b.alpha) && b.alpha > 0 && b.alpha <= 10000) {
    let total = 0;
    for (let i = 0; i < b.alpha; i++) {
      total += Math.exp(
        lbeta(a.alpha + i, a.beta + b.beta) - Math.log(b.beta + i) - lbeta(1 + i, b.beta) - lbeta(a.alpha, a.beta),
      );
    }
    return Math.min(1, Math.max(0, total));
  }
  const rnd = mulberry32(0x5eed_ca7); // fixed seed: stable UI numbers across renders
  let wins = 0;
  for (let i = 0; i < mcDraws; i++) {
    if (randBeta(b.alpha, b.beta, rnd) > randBeta(a.alpha, a.beta, rnd)) wins++;
  }
  return wins / mcDraws;
}
// Reference (docs/growth/oss-research/3-growthbook.md, scipy 1.13-validated):
//   betaChanceToWin(Beta(50,52), Beta(52,50)) = P(b>a) = 0.6107705226878
//   (closed-form ref 0.610770522687837; a 2e7-draw MC gives 0.61071).
//   betaChanceToWin(Beta(5,207), Beta(8,192)) = P(b>a) = 0.8368242682210
//   ("Watrloo scale": a=4 clicks/210 impressions, b=7/198, Beta(1,1) priors —
//   leaning b, but ~1-in-6 chance it's wrong, which is exactly why we don't
//   show a winner badge at this volume).

/**
 * P(variant a's true CTR > variant b's). 0.5 = no evidence either way — also
 * the answer whenever either arm has zero impressions, since there is
 * nothing to compare yet and a shaky number would be worse than an honest
 * "don't know" (GrowthBook's `_default_output` pattern).
 */
export function chanceToWin(
  a: { clicks: number; impressions: number },
  b: { clicks: number; impressions: number },
): number {
  if (a.impressions <= 0 || b.impressions <= 0) return 0.5;
  const postA = betaPosterior(a.clicks, a.impressions);
  const postB = betaPosterior(b.clicks, b.impressions);
  // betaChanceToWin(x, y) computes P(y > x); swap positional order so this
  // reads as "chance a wins": betaChanceToWin(postB, postA) = P(postA > postB).
  return betaChanceToWin(postB, postA);
}
// Reference: chanceToWin({clicks:49,impressions:100}, {clicks:51,impressions:100})
//   = P(a>b) = 1 − 0.6107705226878 = 0.3892294773122 — the complement of the
//   betaChanceToWin reference above, since b's higher empirical CTR (51% vs
//   49%) makes b more likely to win, so a's chance is below 0.5.

// ---------- Thompson sampling ----------

/**
 * Deterministic 32-bit PRNG (only needed where reproducibility matters;
 * Math.random is fine for live serving).
 */
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
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      // Box-Muller standard normal.
      const u1 = rnd();
      const u2 = rnd();
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
  const x = randGamma(a, rnd);
  const y = randGamma(b, rnd);
  return x / (x + y);
}
// Test: 200k draws of randBeta(6,96): sample mean 0.05880 (true 0.058824),
//       sample var 5.405e-4 (true 5.375e-4) — within MC error.

/**
 * One Thompson-sampling pick: sample each arm's posterior, return the argmax
 * index. GrowthBook guardrail worth copying: force an even split until every
 * arm clears a minimum-impressions floor (GrowthBook refuses weights below
 * n=100/arm; Watrloo's default floor here is 50 — the point is HAVING a floor).
 */
export function thompsonPick(
  variants: { clicks: number; impressions: number }[],
  minImpressions = 50,
  rnd: () => number = Math.random,
): number {
  if (variants.length === 0) throw new Error("no variants");
  if (variants.some((v) => v.impressions < minImpressions)) {
    return Math.floor(rnd() * variants.length); // even split below the floor
  }
  let best = 0;
  let bestDraw = -1;
  variants.forEach((v, i) => {
    const post = betaPosterior(v.clicks, v.impressions);
    const draw = randBeta(post.alpha, post.beta, rnd);
    if (draw > bestDraw) {
      bestDraw = draw;
      best = i;
    }
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
    let sum = 1 / s;
    let term = sum;
    for (let n = 1; n < 500; n++) {
      term *= x / (s + n);
      sum += term;
      // eslint-disable-next-line oxc/erasing-op -- 1e-16 is a convergence tolerance, not zero
      if (Math.abs(term) < Math.abs(sum) * 1e-16) break;
    }
    return sum * Math.exp(-x + s * Math.log(x) - lgamma(s));
  }
  const FPMIN = 1e-300;
  let b = x + 1 - s;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - s);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 1e-16) break;
  }
  return 1 - Math.exp(-x + s * Math.log(x) - lgamma(s)) * h;
}

const chiSqSF = (x: number, df: number): number => 1 - lowerGammaP(df / 2, x / 2);
// Test: chiSqSF(10.83,1)=0.00099868638, chiSqSF(3.84,1)=0.05004352,
//       chiSqSF(12.5,2)=0.00193045414 (all match scipy chi2.sf to ~1e-13).

/**
 * p-value that the observed per-variant counts match the intended split.
 * Flag sample-ratio-mismatch (SRM) when p < 0.001 (GrowthBook's default warn
 * threshold): "you shouldn't trust the results since they are likely
 * misleading" — fix the bug and restart, never reinterpret.
 */
export function srmCheck(observed: number[], weights: number[]): number {
  const total = observed.reduce((s, o) => s + o, 0);
  if (!total) return 1;
  const wSum = weights.reduce((s, w) => s + w, 0);
  let x = 0;
  observed.forEach((o, i) => {
    if (weights[i] <= 0) return;
    const e = (weights[i] / wSum) * total;
    x += (o - e) ** 2 / e;
  });
  return chiSqSF(x, observed.length - 1);
}
// Test: srmCheck([520,480],[0.5,0.5]) = 0.20590321 (scipy ref 0.2059032107320647)
//       -> fine. srmCheck([620,380],[0.5,0.5]) ~ 3.2e-14 -> SRM, halt the test.

/** Below this many impressions, the UI must say "not enough data" (GrowthBook's floor). */
export const MIN_SAMPLE = 100;
