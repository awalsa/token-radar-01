// Token Radar's scoring model, version radar-2: a frozen snapshot of the protocol universe
// goes in, a ranked board of pre-token protocols comes out.
//
// A protocol earns a place on the board when it records no token and the watchlist's own
// rule would keep it: not an exchange, not a versioned pool, not a wrapped, staked or
// bridged product of a token that already trades. The watchlist itself is the floor, not
// the ceiling — the board also ranks every other protocol the same rule keeps, including
// the ones below the watchlist's TVL floor. Protocols whose token already trades are set
// aside and shown with the market's own values, never mixed into the ranking.
//
// Every row's implied value comes from one formula over the snapshot's own figures:
//
//   implied = round( tvl_usd x category_multiple x growth_multiplier x maturity_multiplier )
//
//   category_multiple: the median market-cap / TVL of the live-token protocols in the
//     row's category, pulled toward the snapshot-wide median with a prior weight of 8 and
//     clamped to [0.08, 0.80]. A category with no live protocol to learn from takes the
//     snapshot-wide median. No name is ever special-cased: two protocols in one category
//     with the same figures get the same multiple.
//   growth_multiplier: 1 + 0.8 x clamp(change_7d, -50, 100) / 100, so a protocol whose
//     TVL doubled in a week scores 1.8x and one that halved scores 0.6x.
//   maturity_multiplier: 0.7 + 0.3 x min(age_days, 1095) / 1095, so a protocol that has
//     run three years with no token scores 1.0x and a brand-new one 0.7x. Age is the days
//     since DefiLlama first listed the protocol; a protocol with no listing date takes the
//     median age of the snapshot's pre-token protocols, computed from the snapshot itself.

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

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  multiple_floor: number;
  multiple_cap: number;
  shrink_prior: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.8,
  growth_floor: -50,
  growth_cap: 100,
  maturity_floor: 0.7,
  maturity_range: 0.3,
  maturity_days: 1095,
  multiple_floor: 0.08,
  multiple_cap: 0.8,
  shrink_prior: 8,
  unknown_age_days: 516,
};

/** The model's version label: the dashboard names it. */
export const MODEL_VERSION = 'radar-2';

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
    category_multiple: number;
    category_comps: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
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
  category_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  watchlist: boolean;
  farm_steps: string[];
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

/** One category's learned multiple, for the dashboard's model panel. */
export interface CategoryMultiple {
  category: string;
  multiple: number;
  comps: number;
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
  global_multiple: number;
  category_multiples: CategoryMultiple[];
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

/**
 * The category multiples the snapshot's own live market teaches: for each category, the median
 * market-cap / TVL of its live-token protocols, shrunk toward the global median with the prior
 * weight, then clamped. A category with no live protocol to learn from takes the global median.
 */
export function categoryMultiples(snapshot: Snapshot, model: ModelConstants = MODEL): { global: number; byCategory: Map<string, { multiple: number; comps: number }> } {
  const liveRatios = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => p.mcap_usd! / p.tvl_usd)
    .sort((a, b) => a - b);
  const global = lowerMedian(liveRatios, 0.2);
  const byCategoryRatios = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const key = p.category ?? '(none)';
    const list = byCategoryRatios.get(key) ?? [];
    list.push(p.mcap_usd / p.tvl_usd);
    byCategoryRatios.set(key, list);
  }
  const byCategory = new Map<string, { multiple: number; comps: number }>();
  for (const [category, ratios] of byCategoryRatios) {
    ratios.sort((a, b) => a - b);
    const med = lowerMedian(ratios, global);
    const shrunk = (ratios.length * med + model.shrink_prior * global) / (ratios.length + model.shrink_prior);
    const multiple = Math.min(model.multiple_cap, Math.max(model.multiple_floor, shrunk));
    byCategory.set(category, { multiple, comps: ratios.length });
  }
  return { global, byCategory };
}

/** The three multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  multiples: { global: number; byCategory: Map<string, { multiple: number; comps: number }> },
  unknownAgeDays: number,
  model: ModelConstants = MODEL,
): { implied: number; categoryMultiple: number; categoryComps: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const entry = multiples.byCategory.get(protocol.category ?? '(none)');
  const categoryMultiple = entry !== undefined ? entry.multiple : multiples.global;
  const categoryComps = entry !== undefined ? entry.comps : 0;
  const rawGrowth = finiteOr(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? unknownAgeDays;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * categoryMultiple * growthMult * maturityMult));
  return { implied, categoryMultiple, categoryComps, growthPct, growthMult, maturityMult, age };
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = indexBySlug(snapshot.protocols);
  const multiples = categoryMultiples(snapshot, model);
  const unknownAgeDays = medianPreTokenAge(snapshot);
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
    const v = impliedValue(p, snapshot.as_of, multiples, unknownAgeDays, model);
    return { p, ...v };
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
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      // Full precision, not rounded: the dashboard recomputes this row from these very numbers,
      // and a rounded multiple would make its recompute differ from the board by a few dollars.
      category_multiple: s.categoryMultiple,
      category_comps: s.categoryComps,
      growth_pct: s.growthPct,
      growth_multiplier: s.growthMult,
      maturity_multiplier: s.maturityMult,
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
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

/** How much capital one farm position needs, from the protocol's own TVL. */
function stakeFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function qualifyingHoldDays(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
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
    write: (name, capital, chain) => `Deposit $${capital} of USDC into a ${name} curated vault on ${chain} and keep the shares for the whole season.`,
  },
  {
    match: (c) => c.includes('cdp'),
    write: (name, capital, chain) => `Lock $${capital} of ETH as collateral in a ${name} vault on ${chain} and mint the stable asset against it.`,
  },
  {
    match: (c) => c.includes('lend') || c.includes('collateral'),
    write: (name, capital, chain) => `Supply $${capital} of USDC to ${name} on ${chain}, borrow a small amount against it, and keep both legs open.`,
  },
  {
    match: (c) => c.includes('basis'),
    write: (name, capital, chain) => `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the position through one funding cycle.`,
  },
  {
    match: (c) => c.includes('dex'),
    write: (name, capital, chain) => `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} in the tightest active range and keep the position open.`,
  },
  {
    match: (c) => c.includes('yield') || c.includes('leveraged farm') || c.includes('farm'),
    write: (name, capital, chain) => `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`,
  },
  {
    match: (c) => c.includes('derivative') || c.includes('perpetual') || c.includes('options') || c.includes('interest rate'),
    write: (name, capital, chain) => `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position on ${chain}.`,
  },
  {
    match: (c) => c.includes('rwa'),
    write: (name, capital, chain) => `Mint $${capital} of the yield-bearing asset through ${name} on ${chain} and hold it in the farming wallet.`,
  },
  {
    match: (c) => c.includes('prediction'),
    write: (name, capital, chain) => `Fund $${capital} and place one position on a high-volume market on ${name}.`,
  },
  {
    match: (c) => c.includes('launchpad'),
    write: (name, capital, chain) => `Commit $${capital} to a ${name} sale on ${chain} and hold the allocation through its distribution.`,
  },
  {
    match: (c) => c.includes('chain') && !c.includes('bridge'),
    write: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} and use it across ${name}'s native apps for the season.`,
  },
  {
    match: (c) => c.includes('bridge'),
    write: (name, capital, chain) => `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`,
  },
  {
    match: (c) => c.includes('staking') || c.includes('restak'),
    write: (name, capital, chain) => `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`,
  },
  {
    match: (c) => c.includes('stable') || c.includes('btc'),
    write: (name, capital, chain) => `Mint or hold $${capital} of the stable asset through ${name} on ${chain} and keep it in the farming wallet.`,
  },
  {
    match: (c) => c.includes('insurance'),
    write: (name, capital, chain) => `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active for the season.`,
  },
  {
    match: (c) => c.includes('payment') || c.includes('card'),
    write: (name, capital, chain) => `Spend $${capital} through ${name} on ${chain} and keep the receipts in the farm log.`,
  },
  {
    match: (c) => c.includes('governance'),
    write: (name, capital, chain) => `Deposit $${capital} and vote in ${name}'s governance on ${chain} at least once a month.`,
  },
  {
    match: (c) => c.includes('index'),
    write: (name, capital, chain) => `Deposit $${capital} into ${name}'s index vault on ${chain} and hold the shares.`,
  },
  {
    match: (c) => c.includes('nft'),
    write: (name, capital, chain) => `Make one trade or listing worth $${capital} on ${name} on ${chain} and keep the position open.`,
  },
  {
    match: (c) => c.includes('otc'),
    write: (name, capital, chain) => `Place one OTC order of $${capital} through ${name} on ${chain} and settle it in the farming wallet.`,
  },
  {
    match: (c) => c.includes('cedefi'),
    write: (name, capital, chain) => `Deposit $${capital} into a ${name} CeDeFi vault on ${chain} and keep the shares.`,
  },
  {
    match: (c) => c.includes('locker') || c.includes('lock'),
    write: (name, capital, chain) => `Lock $${capital} of tokens in ${name} on ${chain} for the vesting period and keep the receipt.`,
  },
];

/** The category's one action, in the words a farmer can follow. */
function categoryAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const cat = (p.category ?? '').toLowerCase();
  for (const rule of CATEGORY_ACTIONS) {
    if (rule.match(cat)) return rule.write(p.name, capital, chain);
  }
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age), never from a hand-written list of
 * names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = primaryChain(p);
  const capital = stakeFor(p);
  const hold = qualifyingHoldDays(age);
  const action = categoryAction(p, capital, chain);
  const step = (text: string, cost: string, time: string): FarmStep => ({ text, cost, time });
  return [
    step(
      `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    step(
      action,
      `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      '15 minutes to set up',
    ),
    step(
      `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote, and keep the receipts.`,
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    step(
      `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    step(
      `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      'no fee to check, and never pay to claim',
      '10 minutes',
    ),
    step(
      `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      'nothing but the log',
      '5 minutes',
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

/** A board row's compact form for data.js, with the farm plan it ships. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
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
    category_multiple: row.model.category_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    watchlist: watchlist.has(row.slug),
    farm_steps: row.farm_steps,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const multiples = categoryMultiples(snapshot, model);
  const watchlistSlugs = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlistSlugs.has(r.slug)).length;
  const categoryMultiplesList: CategoryMultiple[] = [...multiples.byCategory.entries()]
    .map(([category, v]) => ({ category, multiple: round4dp(v.multiple), comps: v.comps }))
    .sort((a, b) => b.multiple - a.multiple || (a.category < b.category ? -1 : 1));
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
    global_multiple: round4dp(multiples.global),
    category_multiples: categoryMultiplesList,
    rows: board.map((r) => radarRow(r, watchlistSlugs)),
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
