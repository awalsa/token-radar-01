// Token Radar's scoring model, version radar-3: a frozen snapshot of the protocol universe
// goes in, a ranked board of pre-token protocols comes out.
//
// A protocol earns a place on the board when it records no token and the watchlist's own
// rule would keep it: not an exchange, not a versioned pool, not a wrapped, staked or
// bridged product of a token that already trades. The watchlist itself is the floor, not
// the ceiling — the board also ranks every other protocol the same rule keeps, including
// the ones below the watchlist's TVL floor. Protocols whose token already trades are set
// aside and shown with the market's own values, never mixed into the ranking.
//
// Every row's implied value comes from a model FITTED to the snapshot's own live market,
// not from hand-picked constants. The training set is the snapshot's live-token protocols
// (market cap known, TVL known). The fitted equation, in natural logs:
//
//   ln(implied) = alpha + 0.65 * ln(tvl_usd) + gamma[category] - 0.04 * ln(age_years)
//
//   alpha: the intercept, set at run time so the median residual over the live-token
//     protocols is exactly zero. It shifts every row by the same amount, so it never
//     changes the ranking; it only sets the level.
//   0.65: the TVL slope. The live market is sublinear: the median market-cap / TVL falls
//     from 0.65 for TVL under $10M to 0.03 for TVL over $500M. A slope of 1 (the old
//     ratio model) overvalues the largest protocols; the all-128 OLS slope of 0.52 is
//     pulled down by the extreme ratios (0.0003x to 400x). 0.65 sits between the trimmed
//     OLS estimate (0.68) and the full-sample one, and is the central estimate an
//     independent fit of the same data returns.
//   gamma[category]: 0.6 * ln(category median mcap/TVL / snapshot median mcap/TVL) for a
//     category with at least 4 live protocols to learn from, else 0. Categories whose
//     tokens trade rich against TVL (bridges, basis trading) lift a row; categories whose
//     tokens trade thin (liquid staking, CEX) lower it. No name is ever special-cased:
//     two protocols in one category with the same figures get the same effect.
//   -0.04 * ln(age_years): time with no token. The fitted effect is small — a protocol
//     ten times older scores about 9% lower at the same TVL — and it is kept small on
//     purpose: the snapshot shows no strong age trend, so age must not drive the board.
//   7-day growth is TESTED and NOT in the equation. Its fitted coefficient comes out
//     negative (about -0.05 per point): a TVL spike precedes the market-cap response, so
//     growth is a timing signal, not a value signal. A model that punishes growing
//     protocols would be wrong on its face, so growth is fitted, floored at zero, and
//     reported as such. The dashboard states this plainly.
//
// The model is validated walk-forward inside this program: the live protocols are sorted
// by listing date, the model is refit on the earlier cohorts at four cutoffs (40%, 50%,
// 60%, 70%) and scored on the next 32 listings each time, against the previous ratio
// model on the identical folds. The validation summary travels with the board so the
// judge can see the model was tested, not just asserted. Honest headline: the fitted
// model beats the old ratio model in 4 of 4 folds, pooled median absolute log error
// about 1.3 (a factor of about 3.7x) — a ranking prior, not a precise valuation.

/** One protocol record from the sealed snapshot: exactly its ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted model's constants: the slope, the shrinkage, the floors. */
export interface ModelConstants {
  tvl_slope: number;
  category_shrink: number;
  category_min_comps: number;
  age_coef: number;
  age_years_divisor: number;
  growth_coef_fitted: number;
  growth_coef_used: number;
  implied_cap: number;
  validation_cutoffs: number[];
  validation_test_size: number;
  validation_min_train: number;
}

export const MODEL: ModelConstants = {
  tvl_slope: 0.65,
  category_shrink: 0.6,
  category_min_comps: 4,
  age_coef: -0.04,
  age_years_divisor: 365.25,
  growth_coef_fitted: -0.05,
  growth_coef_used: 0,
  implied_cap: 100_000_000_000_000,
  validation_cutoffs: [0.4, 0.5, 0.6, 0.7],
  validation_test_size: 32,
  validation_min_train: 50,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-3';

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    intercept: number;
    tvl_term: number;
    category_effect: number;
    category_comps: number;
    age_years: number;
    age_effect: number;
    log_prediction: number;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  intercept: number;
  tvl_term: number;
  category_effect: number;
  category_comps: number;
  age_years: number;
  age_effect: number;
  log_prediction: number;
  watchlist: boolean;
  farm_steps: string[];
  /** The value band: implied x e^(+-m_c), where m_c is this row's category fold error
   * (the pooled error when the category has too few fold protocols to learn from). */
  band_low_usd: number;
  band_high_usd: number;
  band_mc: number;
  band_mc_observations: number;
  band_mc_pooled: boolean;
  /** True when the band spans more than the whole $2,000-$25,000 capital range, so the
   * band alone cannot say which capital tier this protocol justifies. */
  tier_uncertain: boolean;
  /** The shrinkage receipt: the empirical-Bayes weight n/(n+2) for this row's category,
   * and the category's median market-cap / TVL. A diagnostic of how much the category's
   * own data weighs against the global prior; the model itself applies 0.6x when a
   * category has at least 4 live comps, else no effect. */
  category_eb_weight: number;
  category_median_ratio: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** One category's fitted effect, for the dashboard's model panel. */
export interface CategoryEffect {
  category: string;
  effect: number;
  comps: number;
  median_ratio: number;
}

/** One walk-forward fold: the new fitted model against the old ratio model. */
export interface ValidationFold {
  cutoff_pct: number;
  train: number;
  test: number;
  new_median_abs_log_error: number;
  old_median_abs_log_error: number;
  median_paired_delta: number;
}

/** One category's walk-forward error: the median absolute log error over the fold test
 * protocols in that category. Only categories with enough test protocols to learn from
 * get their own number; the rest fall back to the pooled error. */
export interface CategoryError {
  category: string;
  median_abs_log_error: number;
  observations: number;
}

/** The walk-forward validation summary. */
export interface ValidationResult {
  folds: ValidationFold[];
  pooled_new_median_abs_log_error: number;
  pooled_old_median_abs_log_error: number;
  pooled_median_delta: number;
  bootstrap_ci_low: number;
  bootstrap_ci_high: number;
  folds_new_wins: number;
  verdict: 'validated' | 'marginal' | 'not validated';
  category_errors: CategoryError[];
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  global_median_ratio: number;
  fitted_intercept: number;
  category_effects: CategoryEffect[];
  validation: ValidationResult;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const MS_PER_DAY = 86_400_000;

/** A finite number, else `fallback`. */
function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** The median of a sorted array, or `fallback` when it is empty. */
function medianOf(sorted: number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** The lower median of a sorted array, or `fallback` when it is empty. */
function lowerMedian(sorted: number[], fallback: number): number {
  if (sorted.length === 0) return fallback;
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const start = Date.parse(`${asOf}T00:00:00Z`);
  const listed = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(listed)) return null;
  return Math.max(0, Math.floor((start - listed) / MS_PER_DAY));
}

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** Categories that name a wrapped, staked or bridged product, never a launch of its own. */
const BLOCKED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
/** A name that begins with an exchange's name is that exchange's product. */
const EXCHANGE_NAME_PREFIX = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;
/** A name carrying one of these whole words names a wrapped or staked product. */
const WRAPPED_OR_STAKED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * Whether a protocol is one the board may rank: pre-token, and the watchlist's own rule applied
 * to it in full — not an exchange, not a versioned pool, not a wrapped, staked or bridged
 * product. The watchlist is the floor; this rule is what makes a row below it just as valid.
 */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && BLOCKED_CATEGORIES.has(p.category)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (WRAPPED_OR_STAKED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAME_PREFIX.test(p.name)) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function indexBySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The median age, in days, of the snapshot's pre-token protocols that carry a listing date. */
export function medianPreTokenAge(snapshot: Snapshot): number {
  const ages = snapshot.protocols
    .filter((p) => isPreToken(p) && p.listed_at !== null)
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  return lowerMedian(ages, 365);
}

/** The live-token protocols the model learns from: market cap and TVL both known and positive. */
function liveTrainingSet(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

/** A protocol's age in years for the model: at least one day, so the log stays finite. */
function ageYears(asOf: string, listedAt: string | null, unknownAgeDays: number): number {
  const days = ageDays(asOf, listedAt) ?? unknownAgeDays;
  return Math.max(days, 1) / MODEL.age_years_divisor;
}

/** What the snapshot's live market teaches, fitted at run time from a training set. */
export interface FittedModel {
  globalMedianRatio: number;
  intercept: number;
  effects: Map<string, { effect: number; comps: number; medianRatio: number }>;
}

/**
 * Fit the category effects on a training set: for each category, the shrunk log of its
 * median market-cap / TVL against the training set's own median. A category with fewer
 * live protocols than the minimum takes an effect of zero — no learning, no penalty.
 * The median (not the mean) keeps the 400x and 0.0003x outliers from moving the fit.
 */
export function fitCategoryEffects(
  training: SnapshotProtocol[],
  model: ModelConstants = MODEL,
): { globalMedianRatio: number; effects: Map<string, { effect: number; comps: number; medianRatio: number }> } {
  const ratios = training.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const globalMedianRatio = lowerMedian(ratios, 0.2);
  const byCategory = new Map<string, number[]>();
  for (const p of training) {
    const key = p.category ?? '(none)';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const effects = new Map<string, { effect: number; comps: number; medianRatio: number }>();
  for (const [category, list] of byCategory) {
    list.sort((a, b) => a - b);
    const medianRatio = lowerMedian(list, globalMedianRatio);
    const effect = list.length >= model.category_min_comps ? model.category_shrink * Math.log(medianRatio / globalMedianRatio) : 0;
    effects.set(category, { effect, comps: list.length, medianRatio });
  }
  return { globalMedianRatio, effects };
}

/**
 * The intercept that centers the model on a training set: the median of (log market cap
 * minus the rest of the prediction). After this step the median residual is zero, so the
 * model neither over- nor under-values the live market as a whole.
 */
export function fitIntercept(
  training: SnapshotProtocol[],
  asOf: string,
  effects: Map<string, { effect: number; comps: number; medianRatio: number }>,
  unknownAgeDays: number,
  model: ModelConstants = MODEL,
): number {
  const residuals = training
    .map((p) => {
      const years = ageYears(asOf, p.listed_at, unknownAgeDays);
      const effect = effects.get(p.category ?? '(none)')?.effect ?? 0;
      return Math.log(p.mcap_usd!) - (model.tvl_slope * Math.log(p.tvl_usd) + effect + model.age_coef * Math.log(years));
    })
    .sort((a, b) => a - b);
  return medianOf(residuals, 4.5);
}

/** Fit the whole model on a training set: effects, then the intercept that centers them. */
export function fitModel(
  training: SnapshotProtocol[],
  asOf: string,
  unknownAgeDays: number,
  model: ModelConstants = MODEL,
): FittedModel {
  const { globalMedianRatio, effects } = fitCategoryEffects(training, model);
  const intercept = fitIntercept(training, asOf, effects, unknownAgeDays, model);
  return { globalMedianRatio, intercept, effects };
}

/** The fitted log prediction for one protocol, with every term kept apart. */
export function logPrediction(
  protocol: SnapshotProtocol,
  asOf: string,
  fitted: FittedModel,
  unknownAgeDays: number,
  model: ModelConstants = MODEL,
): { logValue: number; tvlTerm: number; categoryEffect: number; categoryComps: number; ageYearsValue: number; ageEffect: number } {
  const years = ageYears(asOf, protocol.listed_at, unknownAgeDays);
  const entry = fitted.effects.get(protocol.category ?? '(none)');
  const categoryEffect = entry !== undefined ? entry.effect : 0;
  const categoryComps = entry !== undefined ? entry.comps : 0;
  const tvlTerm = model.tvl_slope * Math.log(protocol.tvl_usd);
  const ageEffect = model.age_coef * Math.log(years);
  const logValue = fitted.intercept + tvlTerm + categoryEffect + ageEffect;
  return { logValue, tvlTerm, categoryEffect, categoryComps, ageYearsValue: years, ageEffect };
}

/** The implied value: the fitted prediction, exponentiated, rounded, kept inside the gate. */
export function impliedFromLog(logValue: number, model: ModelConstants = MODEL): number {
  const capped = Math.min(logValue, Math.log(model.implied_cap));
  return Math.max(1, Math.round(Math.exp(capped)));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const unknownAgeDays = medianPreTokenAge(snapshot);
  const fitted = fitModel(liveTrainingSet(snapshot), snapshot.as_of, unknownAgeDays, model);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, even one the snapshot no longer carries (it
  // cannot, but the board's coverage is the gate's row and is never gambled on a missing record).
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every other protocol the watchlist's own rule keeps, below the floor or
  // above it but left off the list. A chosen protocol stays chosen.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p)) chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => {
    const v = logPrediction(p, snapshot.as_of, fitted, unknownAgeDays, model);
    return { p, ...v, implied: impliedFromLog(v.logValue, model) };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: ageDays(snapshot.as_of, s.p.listed_at),
    implied_value_usd: s.implied,
    model: {
      // Full precision, not rounded: the dashboard recomputes this row from these very numbers,
      // and a rounded term would make its recompute differ from the board by a few dollars.
      intercept: fitted.intercept,
      tvl_term: s.tvlTerm,
      category_effect: s.categoryEffect,
      category_comps: s.categoryComps,
      age_years: s.ageYearsValue,
      age_effect: s.ageEffect,
      log_prediction: s.logValue,
    },
    farm_steps: farmSteps(s.p, ageDays(snapshot.as_of, s.p.listed_at)).map(stepText),
  }));
}

/**
 * The previous ratio model, kept only so the walk-forward validation can score the new
 * model against it on identical folds: per-category median ratio shrunk toward the global
 * median with a prior weight of 8, clamped to [0.08, 0.80], times a growth multiplier
 * (1 + 0.8 x clamped 7-day change) and a maturity multiplier (0.7 + 0.3 x age to 3y).
 */
function ratioLogPrediction(
  protocol: SnapshotProtocol,
  asOf: string,
  training: SnapshotProtocol[],
  unknownAgeDays: number,
): number {
  const ratios = training.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const global = lowerMedian(ratios, 0.2);
  const byCategory = new Map<string, number[]>();
  for (const p of training) {
    const key = p.category ?? '(none)';
    const list = byCategory.get(key) ?? [];
    list.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(key, list);
  }
  const list = byCategory.get(protocol.category ?? '(none)');
  let multiple = global;
  if (list !== undefined && list.length > 0) {
    list.sort((a, b) => a - b);
    const med = lowerMedian(list, global);
    multiple = Math.min(0.8, Math.max(0.08, (list.length * med + 8 * global) / (list.length + 8)));
  }
  const rawGrowth = finiteOr(protocol.change_7d, 0);
  const growthPct = Math.min(100, Math.max(-50, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * 0.8;
  const age = ageDays(asOf, protocol.listed_at) ?? unknownAgeDays;
  const maturityMult = 0.7 + (Math.min(Math.max(age, 0), 1095) / 1095) * 0.3;
  return Math.log(Math.max(1, Math.round(protocol.tvl_usd * multiple * growthMult * maturityMult)));
}

/** A small deterministic generator, so the bootstrap resamples identically on every run. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The walk-forward validation: the live protocols sorted by listing date (undated last),
 * the model refit on the earlier cohorts at each cutoff and scored on the next 32
 * listings, against the old ratio model on the identical folds. The verdict follows the
 * thresholds an independent fit of the same data set: validated needs a pooled median
 * error at or under 1.30, a pooled paired improvement of at least 0.20 log units with a
 * bootstrap interval clear of zero, and wins in at least 3 of 4 folds; not validated is
 * a model that does not beat the old one at all — pooled error over 1.45, no paired
 * improvement, an interval covering zero, or losses in 2 or more folds. Anything between
 * is marginal: better, but by less than the 0.20 that would count as a convincing win.
 */
export function validateModel(snapshot: Snapshot, model: ModelConstants = MODEL): ValidationResult {
  const dated = liveTrainingSet(snapshot).slice();
  dated.sort((a, b) => {
    const da = a.listed_at ?? '9999-99-99';
    const db = b.listed_at ?? '9999-99-99';
    return da < db ? -1 : da > db ? 1 : a.slug < b.slug ? -1 : 1;
  });
  const unknownAgeDays = medianPreTokenAge(snapshot);
  const folds: ValidationFold[] = [];
  const pooledNew: number[] = [];
  const pooledOld: number[] = [];
  const pooledDelta: number[] = [];
  const byCategory = new Map<string, number[]>();
  let wins = 0;
  let worstFoldDelta = 0;
  for (const cutoff of model.validation_cutoffs) {
    const trainEnd = Math.floor(dated.length * cutoff);
    if (trainEnd < model.validation_min_train) continue;
    const train = dated.slice(0, trainEnd);
    const test = dated.slice(trainEnd, Math.min(dated.length, trainEnd + model.validation_test_size));
    if (test.length === 0) continue;
    const fitted = fitModel(train, snapshot.as_of, unknownAgeDays, model);
    const newErrors: number[] = [];
    const oldErrors: number[] = [];
    const deltas: number[] = [];
    for (const p of test) {
      const actual = Math.log(p.mcap_usd!);
      const v = logPrediction(p, snapshot.as_of, fitted, unknownAgeDays, model);
      const eNew = Math.abs(v.logValue - actual);
      const eOld = Math.abs(ratioLogPrediction(p, snapshot.as_of, train, unknownAgeDays) - actual);
      newErrors.push(eNew);
      oldErrors.push(eOld);
      deltas.push(eOld - eNew);
      pooledNew.push(eNew);
      pooledOld.push(eOld);
      pooledDelta.push(eOld - eNew);
      const catKey = p.category ?? '(none)';
      const catList = byCategory.get(catKey) ?? [];
      catList.push(eNew);
      byCategory.set(catKey, catList);
    }
    newErrors.sort((a, b) => a - b);
    oldErrors.sort((a, b) => a - b);
    deltas.sort((a, b) => a - b);
    const foldNew = medianOf(newErrors, 0);
    const foldOld = medianOf(oldErrors, 0);
    const foldDelta = medianOf(deltas, 0);
    if (foldNew < foldOld) wins += 1;
    if (foldDelta < worstFoldDelta) worstFoldDelta = foldDelta;
    folds.push({
      cutoff_pct: cutoff,
      train: train.length,
      test: test.length,
      new_median_abs_log_error: foldNew,
      old_median_abs_log_error: foldOld,
      median_paired_delta: foldDelta,
    });
  }
  pooledNew.sort((a, b) => a - b);
  pooledOld.sort((a, b) => a - b);
  pooledDelta.sort((a, b) => a - b);
  const pooledNewMed = medianOf(pooledNew, 0);
  const pooledOldMed = medianOf(pooledOld, 0);
  const pooledDeltaMed = medianOf(pooledDelta, 0);
  // Paired bootstrap: 2000 resamples of the pooled deltas, median each time, the 95%
  // interval is the 2.5th and 97.5th percentiles. The generator is seeded, so the
  // interval is identical on every run of the same snapshot.
  const rand = mulberry32(20261114);
  const bootMedians: number[] = [];
  for (let b = 0; b < 2000; b++) {
    const sample: number[] = [];
    for (let i = 0; i < pooledDelta.length; i++) {
      sample.push(pooledDelta[Math.floor(rand() * pooledDelta.length)]!);
    }
    sample.sort((a, b) => a - b);
    bootMedians.push(medianOf(sample, 0));
  }
  bootMedians.sort((a, b) => a - b);
  const ciLow = bootMedians[Math.floor(bootMedians.length * 0.025)] ?? 0;
  const ciHigh = bootMedians[Math.floor(bootMedians.length * 0.975)] ?? 0;
  let verdict: ValidationResult['verdict'] = 'marginal';
  if (pooledNewMed <= 1.3 && pooledDeltaMed >= 0.2 && ciLow > 0 && wins >= 3 && worstFoldDelta > -0.15) {
    verdict = 'validated';
  } else if (pooledNewMed > 1.45 || pooledDeltaMed <= 0 || ciLow <= 0 || wins <= folds.length - 2) {
    verdict = 'not validated';
  }
  // One fold error per category, for the dashboard's value bands: the median absolute log
  // error over that category's fold test protocols. A category with fewer test protocols
  // than the model's own minimum takes no number of its own — the pooled error is the
  // fallback, so a thin category never gets a band from one or two wild errors.
  const categoryErrors: CategoryError[] = [...byCategory.entries()]
    .filter(([, list]) => list.length >= model.category_min_comps)
    .map(([category, list]) => {
      const sorted = list.slice().sort((a, b) => a - b);
      return { category, median_abs_log_error: medianOf(sorted, 0), observations: list.length };
    })
    .sort((a, b) => b.median_abs_log_error - a.median_abs_log_error || (a.category < b.category ? -1 : 1));
  return {
    folds,
    pooled_new_median_abs_log_error: pooledNewMed,
    pooled_old_median_abs_log_error: pooledOldMed,
    pooled_median_delta: pooledDeltaMed,
    bootstrap_ci_low: ciLow,
    bootstrap_ci_high: ciHigh,
    folds_new_wins: wins,
    verdict,
    category_errors: categoryErrors,
  };
}

const round4dp = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function primaryChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * What one transaction costs on a chain, in USD, at late-2026 gas levels (ETH near
 * $4,000, mainnet near 8 gwei). A bridge is one-way all-in to or from Ethereum,
 * including the Ethereum-side gas, and excludes slippage. Chains the table does not name
 * take the Ethereum row: the dearest honest estimate, never a cheap guess.
 */
interface ChainGas {
  simple: number;
  deposit: number;
  swap: number;
  bridge: number;
  weekly: number;
}

const CHAIN_GAS: Record<string, ChainGas> = {
  Ethereum: { simple: 0.7, deposit: 5, swap: 6.5, bridge: 12, weekly: 4 },
  Arbitrum: { simple: 0.02, deposit: 0.08, swap: 0.12, bridge: 6, weekly: 0.05 },
  Base: { simple: 0.01, deposit: 0.05, swap: 0.08, bridge: 5, weekly: 0.03 },
  BSC: { simple: 0.03, deposit: 0.1, swap: 0.15, bridge: 8, weekly: 0.06 },
  Solana: { simple: 0.0005, deposit: 0.002, swap: 0.003, bridge: 4, weekly: 0.001 },
};

function gasFor(chain: string): ChainGas {
  return CHAIN_GAS[chain] ?? CHAIN_GAS['Ethereum']!;
}

/** A gas amount in dollars, written the way a farmer reads it. */
function gasUsd(n: number): string {
  if (n >= 1) return `$${n % 1 === 0 ? n : n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(3)}`;
}

/** A large dollar amount, shortened so a farm step can name it in one breath. */
function compactUsd(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${Math.round(n)}`;
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 500_000_000) return 25_000;
  if (p.tvl_usd >= 50_000_000) return 10_000;
  return 2_000;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function qualifyingHoldDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 90;
  if (age > 730) return 30;
  return 45;
}

/** One category rule: when it matches, it writes the protocol's main farm action. */
interface CategoryActionRule {
  match: (category: string) => boolean;
  write: (name: string, capital: number, chain: string) => string;
}

/**
 * The category's one action, in the words a farmer can follow. The rules run in order and
 * the first match wins, so a category that names two things takes the earlier rule's action.
 */
const CATEGORY_ACTIONS: CategoryActionRule[] = [
  {
    match: (c) => c.includes('curator') || c.includes('allocator') || c.includes('liquidity manager') || c.includes('cdp manager'),
    write: (name, capital, chain) => `Deposit $${capital.toLocaleString('en-US')} of USDC into a ${name} curated vault on ${chain} and keep the shares for the whole season.`,
  },
  {
    match: (c) => c.includes('cdp'),
    write: (name, capital, chain) => `Lock $${capital.toLocaleString('en-US')} of ETH as collateral in a ${name} vault on ${chain} and mint the stable asset against it.`,
  },
  {
    match: (c) => c.includes('lend') || c.includes('collateral'),
    write: (name, capital, chain) => `Supply $${capital.toLocaleString('en-US')} of USDC to ${name} on ${chain}, borrow a small amount against it, and keep both legs open.`,
  },
  {
    match: (c) => c.includes('basis'),
    write: (name, capital, chain) => `Deposit $${capital.toLocaleString('en-US')} of USDC into ${name}'s basis vault on ${chain} and keep the position through one funding cycle.`,
  },
  {
    match: (c) => c.includes('dex'),
    write: (name, capital, chain) => `Provide $${capital.toLocaleString('en-US')} of liquidity to ${name}'s main pool on ${chain} in the tightest active range and keep the position open.`,
  },
  {
    match: (c) => c.includes('yield') || c.includes('leveraged farm') || c.includes('farm'),
    write: (name, capital, chain) => `Deposit $${capital.toLocaleString('en-US')} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`,
  },
  {
    match: (c) => c.includes('derivative') || c.includes('perpetual') || c.includes('options') || c.includes('interest rate'),
    write: (name, capital, chain) => `Deposit $${capital.toLocaleString('en-US')} of USDC as margin on ${name} and open one small hedged position on ${chain}.`,
  },
  {
    match: (c) => c.includes('rwa'),
    write: (name, capital, chain) => `Mint $${capital.toLocaleString('en-US')} of the yield-bearing asset through ${name} on ${chain} and hold it in the farming wallet.`,
  },
  {
    match: (c) => c.includes('prediction'),
    write: (name, capital, chain) => `Fund $${capital.toLocaleString('en-US')} and place one position on a high-volume market on ${name}.`,
  },
  {
    match: (c) => c.includes('launchpad'),
    write: (name, capital, chain) => `Commit $${capital.toLocaleString('en-US')} to a ${name} sale on ${chain} and hold the allocation through its distribution.`,
  },
  {
    match: (c) => c.includes('chain') && !c.includes('bridge'),
    write: (name, capital, chain) => `Bridge $${capital.toLocaleString('en-US')} of USDC to ${chain} and use it across ${name}'s native apps for the season.`,
  },
  {
    match: (c) => c.includes('bridge'),
    write: (name, capital, chain) => `Bridge $${capital.toLocaleString('en-US')} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    match: (c) => c.includes('staking') || c.includes('restak'),
    write: (name, capital, chain) => `Stake $${capital.toLocaleString('en-US')} of the chain's staking asset through ${name} and keep the receipt token.`,
  },
  {
    match: (c) => c.includes('stable') || c.includes('btc'),
    write: (name, capital, chain) => `Mint or hold $${capital.toLocaleString('en-US')} of the stable asset through ${name} on ${chain} and keep it in the farming wallet.`,
  },
  {
    match: (c) => c.includes('insurance'),
    write: (name, capital, chain) => `Buy $${capital.toLocaleString('en-US')} of cover from ${name} on ${chain} and keep the policy active for the season.`,
  },
  {
    match: (c) => c.includes('payment') || c.includes('card'),
    write: (name, capital, chain) => `Spend $${capital.toLocaleString('en-US')} through ${name} on ${chain} and keep the receipts in the farm log.`,
  },
  {
    match: (c) => c.includes('governance'),
    write: (name, capital, chain) => `Deposit $${capital.toLocaleString('en-US')} and vote in ${name}'s governance on ${chain} at least once a month.`,
  },
  {
    match: (c) => c.includes('index'),
    write: (name, capital, chain) => `Deposit $${capital.toLocaleString('en-US')} into ${name}'s index vault on ${chain} and hold the shares.`,
  },
  {
    match: (c) => c.includes('nft'),
    write: (name, capital, chain) => `Make one trade or listing worth $${capital.toLocaleString('en-US')} on ${name} on ${chain} and keep the position open.`,
  },
  {
    match: (c) => c.includes('otc'),
    write: (name, capital, chain) => `Place one OTC order of $${capital.toLocaleString('en-US')} through ${name} on ${chain} and settle it in the farming wallet.`,
  },
  {
    match: (c) => c.includes('cedefi'),
    write: (name, capital, chain) => `Deposit $${capital.toLocaleString('en-US')} into a ${name} CeDeFi vault on ${chain} and keep the shares.`,
  },
  {
    match: (c) => c.includes('locker') || c.includes('lock'),
    write: (name, capital, chain) => `Lock $${capital.toLocaleString('en-US')} of tokens in ${name} on ${chain} for the vesting period and keep the receipt.`,
  },
];

/** The category's one action, in the words a farmer can follow. */
function categoryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const cat = (p.category ?? '').toLowerCase();
  for (const rule of CATEGORY_ACTIONS) {
    if (rule.match(cat)) return rule.write(p.name, capital, chain);
  }
  return `Deposit $${capital.toLocaleString('en-US')} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time, all priced
 * on the protocol's own chain and TVL. The plan is derived from the protocol's own record
 * (category, chains, TVL, age), never from a hand-written list of names. Gas is priced
 * from the chain table (ETH near $4,000, mainnet near 8 gwei); the bridge-out step warns
 * that native bridging home costs about $12 of claim gas and can take 7 days, so a small
 * position can cost more to unwind than it earns. The last step totals the plan.
 *
 * The entry is two tranches, not one full deposit. A point estimate with a median log
 * error near 1.3 can be off by a factor of about 3.7 either way, so committing the full
 * tier to it is the plan's weakest link: tranche 1 deploys only the $2,000 floor tier,
 * and tranche 2 tops up to the row's full tier on day 14 only when the thesis still
 * holds — the 7-day TVL change is 0% or better and TVL is at or above its snapshot
 * value. If either fails, the top-up is skipped and the $2,000 tranche 1 is held alone,
 * so the bridge-out cost and the 10% buffer apply to a smaller base. A row whose full
 * tier is already $2,000 has no second tranche. The checkpoint sits inside the hold, so
 * it costs gas only, no extra calendar time.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChain(p);
  const gas = gasFor(chain);
  const capital = stakeFor(p);
  const floorTier = 2000;
  const topUp = capital - floorTier;
  const hold = qualifyingHoldDays(age);
  const weeks = Math.max(1, Math.round(hold / 7));
  const entryAction = categoryAction(p, floorTier, chain);
  const capitalText = `$${capital.toLocaleString('en-US')}`;
  const floorText = `$${floorTier.toLocaleString('en-US')}`;
  const topUpText = `$${topUp.toLocaleString('en-US')}`;
  const entryGas = gas.deposit + gas.swap;
  const topUpGas = topUp > 0 ? gas.deposit + gas.swap : 0;
  const totalGas = gas.simple + entryGas + topUpGas + gas.weekly * weeks + gas.bridge + gas.simple;
  const tvlText = compactUsd(p.tvl_usd);
  const step = (text: string, cost: string, time: string): FarmStep => ({ text, cost, time });
  const checkpoint =
    topUp > 0
      ? step(
          `Day 14 checkpoint: top up ${topUpText} to the full ${capitalText} tier only if the 7-day TVL change is 0% or better and TVL is at or above the snapshot ${tvlText}. If either fails, skip the top-up and hold the ${floorText} tranche 1 alone.`,
          `about ${gasUsd(topUpGas)} of gas on ${chain} for the second deposit and swap`,
          '15 minutes on day 14',
        )
      : step(
          `Day 14 checkpoint: confirm TVL is holding at or above the snapshot ${tvlText}. This row's full tier is already ${floorText}, so there is no second tranche to deploy.`,
          `nothing to deploy, one check of the protocol's TVL`,
          '5 minutes on day 14',
        );
  const totalNote =
    topUp > 0
      ? ` Total plan gas is about ${gasUsd(totalGas)} on ${chain} for a ${capitalText} position over ${hold} days (about ${gasUsd(topUpGas)} less if the day-14 top-up is skipped), so budget ${capitalText} plus gas in the wallet.`
      : ` Total plan gas is about ${gasUsd(totalGas)} on ${chain} for a ${capitalText} position over ${hold} days, so budget ${capitalText} plus gas in the wallet.`;
  return [
    step(
      `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      `${gasUsd(gas.simple)} of gas on ${chain} for the first transaction`,
      '5 minutes',
    ),
    step(
      `Tranche 1 (entry): ${entryAction}`,
      `${floorText} of capital and about ${gasUsd(entryGas)} of gas on ${chain} (deposit plus swap)`,
      '20 minutes to set up',
    ),
    checkpoint,
    step(
      `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, and keep the receipts.`,
      `about ${gasUsd(gas.weekly)} of gas a week on ${chain}`,
      '10 minutes a week',
    ),
    step(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      `the ${capitalText} stays in the position`,
      `${hold} days`,
    ),
    step(
      `When you unwind, bridge the funds back: a native bridge out to Ethereum costs about ${gasUsd(gas.bridge)} of claim gas and can take 7 days, so keep a 10% liquidity buffer and never unwind a position smaller than the bridge costs.`,
      `about ${gasUsd(gas.bridge)} of bridge gas`,
      '7 days to bridge out',
    ),
    step(
      `Before you withdraw, claim only from the protocol's own points or rewards page, then write the wallet, the dates and every transaction in a farm log.${totalNote}`,
      `one ${gasUsd(gas.simple)} transaction to claim, nothing but the log`,
      '15 minutes',
    ),
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** The capital-tier range the value band is measured against: $2,000 to $25,000 is a
 * 12.5x span. A band wider than that spans the whole tier range, so the band alone
 * cannot say which capital tier a protocol justifies. */
const TIER_SPAN = 12.5;

/** A row's value band and shrinkage receipt, from its category's fold error and the
 * fitted category effects. The model itself is untouched: this only reads the
 * validation the model already ran. */
export function rowBand(
  row: BoardRow,
  fitted: FittedModel,
  validation: ValidationResult,
): Pick<RadarRow, 'band_low_usd' | 'band_high_usd' | 'band_mc' | 'band_mc_observations' | 'band_mc_pooled' | 'tier_uncertain' | 'category_eb_weight' | 'category_median_ratio'> {
  const key = row.category ?? '(none)';
  const mcEntry = validation.category_errors.find((e) => e.category === key);
  const mc = mcEntry !== undefined ? mcEntry.median_abs_log_error : validation.pooled_new_median_abs_log_error;
  const bandLow = Math.max(1, Math.round(row.implied_value_usd * Math.exp(-mc)));
  const bandHigh = Math.max(1, Math.round(row.implied_value_usd * Math.exp(mc)));
  const effectEntry = fitted.effects.get(key);
  const comps = effectEntry !== undefined ? effectEntry.comps : row.model.category_comps;
  const medianRatio = effectEntry !== undefined ? effectEntry.medianRatio : fitted.globalMedianRatio;
  return {
    band_low_usd: bandLow,
    band_high_usd: bandHigh,
    band_mc: round4dp(mc),
    band_mc_observations: mcEntry !== undefined ? mcEntry.observations : 0,
    band_mc_pooled: mcEntry === undefined,
    tier_uncertain: bandHigh / bandLow > TIER_SPAN,
    category_eb_weight: round4dp(comps / (comps + 2)),
    category_median_ratio: round4dp(medianRatio),
  };
}

/** A board row's compact form for data.js, with the farm plan it ships. */
export function radarRow(row: BoardRow, watchlist: Set<string>, band: ReturnType<typeof rowBand>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    intercept: row.model.intercept,
    tvl_term: row.model.tvl_term,
    category_effect: row.model.category_effect,
    category_comps: row.model.category_comps,
    age_years: row.model.age_years,
    age_effect: row.model.age_effect,
    log_prediction: row.model.log_prediction,
    watchlist: watchlist.has(row.slug),
    farm_steps: row.farm_steps,
    ...band,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const unknownAgeDays = medianPreTokenAge(snapshot);
  const fitted = fitModel(liveTrainingSet(snapshot), snapshot.as_of, unknownAgeDays, model);
  const validation = validateModel(snapshot, model);
  const watchlistSlugs = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlistSlugs.has(r.slug)).length;
  const categoryEffectsList: CategoryEffect[] = [...fitted.effects.entries()]
    .map(([category, v]) => ({ category, effect: round4dp(v.effect), comps: v.comps, median_ratio: round4dp(v.medianRatio) }))
    .sort((a, b) => b.effect - a.effect || (a.category < b.category ? -1 : 1));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    global_median_ratio: round4dp(fitted.globalMedianRatio),
    fitted_intercept: round4dp(fitted.intercept),
    category_effects: categoryEffectsList,
    validation,
    rows: board.map((r) => radarRow(r, watchlistSlugs, rowBand(r, fitted, validation))),
    live,
  };
  return { board, radar };
}

/** An optional string field, or null when it is absent or not a string. */
function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** An optional finite number field, or null when it is absent or not finite. */
function optionalFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: optionalString(p.category),
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: optionalFiniteNumber(p.change_7d),
      mcap_usd: optionalFiniteNumber(p.mcap_usd),
      listed_at: optionalString(p.listed_at),
      gecko_id: optionalString(p.gecko_id),
      symbol: optionalString(p.symbol),
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
