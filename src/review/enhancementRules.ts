import { formatClockTime, istClock } from '../strategy/clock.js';
import { PARAM_LIMITS, type StrategyParams, type TunableParam } from '../strategy/params.js';
import { MISSED_WINNER_PCT, type AnalyzedTrade, type SkipEpisode } from './tradeAnalysis.js';

/** Fixed reference list. Peer-reviewed work where it exists; no URLs, so links cannot rot. */
export const CITATIONS = {
  'kaminski-lo-2014':
    'Kaminski, K. M., & Lo, A. W. (2014). When do stop-loss rules stop losses? Journal of Financial Markets.',
  'han-zhou-zhu-2016':
    'Han, Y., Zhou, G., & Zhu, Y. (2016). Taming momentum crashes: A simple stop-loss strategy. SSRN Working Paper 2407199.',
  'shefrin-statman-1985':
    'Shefrin, H., & Statman, M. (1985). The disposition to sell winners too early and ride losers too long: Theory and evidence. Journal of Finance.',
  'muravyev-ni-2020':
    'Muravyev, D., & Ni, X. (2020). Why do option returns change sign from day to night? Journal of Financial Economics.',
  'hull-options':
    'Hull, J. C. Options, Futures, and Other Derivatives (chapter on the Greeks and time decay). Pearson.',
  'moskowitz-ooi-pedersen-2012':
    'Moskowitz, T. J., Ooi, Y. H., & Pedersen, L. H. (2012). Time series momentum. Journal of Financial Economics.',
  'harvey-liu-zhu-2016':
    'Harvey, C. R., Liu, Y., & Zhu, H. (2016). … and the cross-section of expected returns. Review of Financial Studies.',
  'bailey-et-al-2017':
    'Bailey, D. H., Borwein, J. M., López de Prado, M., & Zhu, Q. J. (2017). The probability of backtest overfitting. Journal of Computational Finance.',
  'sullivan-timmermann-white-1999':
    'Sullivan, R., Timmermann, A., & White, H. (1999). Data-snooping, technical trading rule performance, and the bootstrap. Journal of Finance.',
  'pan-poteshman-2006':
    'Pan, J., & Poteshman, A. M. (2006). The information in option volume for future stock prices. Review of Financial Studies.',
  'easley-ohara-srinivas-1998':
    "Easley, D., O'Hara, M., & Srinivas, P. S. (1998). Option volume and stock prices: Evidence on where informed traders trade. Journal of Finance.",
  'berkman-et-al-2012':
    'Berkman, H., Koch, P. D., Tuttle, L., & Zhang, Y. J. (2012). Paying attention: Overnight returns and the hidden cost of buying at the open. Journal of Financial and Quantitative Analysis.',
  'andersen-bollerslev-1997':
    'Andersen, T. G., & Bollerslev, T. (1997). Intraday periodicity and volatility persistence in financial markets. Journal of Empirical Finance.',
  'gao-han-li-zhou-2018':
    'Gao, L., Han, Y., Li, S. Z., & Zhou, G. (2018). Market intraday momentum. Journal of Financial Economics.',
  'coval-shumway-2005':
    'Coval, J. D., & Shumway, T. (2005). Do behavioral biases affect prices? Journal of Finance.',
  'barber-odean-2000':
    'Barber, B. M., & Odean, T. (2000). Trading is hazardous to your wealth: The common stock investment performance of individual investors. Journal of Finance.',
  'sebi-fo-studies':
    'SEBI (2023, 2024, 2025). Studies of profit and loss of individual traders in the equity derivatives (F&O) segment: about 9 in 10 individual traders lost money.',
  'whaley-2000': 'Whaley, R. E. (2000). The investor fear gauge. Journal of Portfolio Management.',
  'goyal-saretto-2009':
    'Goyal, A., & Saretto, A. (2009). Cross-section of option returns and volatility. Journal of Financial Economics.',
  'wilder-1978': 'Wilder, J. W. (1978). New Concepts in Technical Trading Systems. Trend Research.',
  'brock-lakonishok-lebaron-1992':
    'Brock, W., Lakonishok, J., & LeBaron, B. (1992). Simple technical trading rules and the stochastic properties of stock returns. Journal of Finance.',
  'savor-wilson-2013':
    'Savor, P., & Wilson, M. (2013). How much do investors care about macroeconomic risk? Evidence from scheduled economic announcements. Journal of Financial and Quantitative Analysis.',
  'lucca-moench-2015':
    'Lucca, D. O., & Moench, E. (2015). The pre-FOMC announcement drift. Journal of Finance.',
} as const;

export type CitationKey = keyof typeof CITATIONS;

export type Direction = 'increase' | 'decrease';

export type RuleFinding = {
  direction: Direction;
  sample: number;
  minSample: number;
  /** Strength of the evidence on a 0–1 scale (ranked together with the sample size). */
  effect: number;
  evidence: string;
};

export type ReviewData = {
  trades: readonly AnalyzedTrade[];
  episodes: readonly SkipEpisode[];
};

export type EnhancementRule = {
  key: string;
  param: TunableParam;
  /** Smallest sample for a finding; also the sample needed to judge an applied change. */
  minSample: number;
  why: Partial<Record<Direction, string>>;
  expectedEffect: Partial<Record<Direction, string>>;
  citations: CitationKey[];
  evaluate: (data: ReviewData, params: StrategyParams) => RuleFinding | null;
};

export type RuleHit = {
  ruleKey: string;
  param: TunableParam;
  direction: Direction;
  fromValue: number;
  toValue: number;
  sample: number;
  minSample: number;
  effect: number;
  evidence: string;
  what: string;
  why: string;
  expectedEffect: string;
  citations: CitationKey[];
};

const WILSON_Z = 1.645;

/** 90% Wilson score interval for a success rate. */
export function wilsonInterval(successes: number, total: number): { low: number; high: number } {
  if (total === 0) {
    return { low: 0, high: 1 };
  }
  const rate = successes / total;
  const z2 = WILSON_Z ** 2;
  const denominator = 1 + z2 / total;
  const centre = (rate + z2 / (2 * total)) / denominator;
  const margin =
    (WILSON_Z * Math.sqrt((rate * (1 - rate)) / total + z2 / (4 * total * total))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function isWin(trade: AnalyzedTrade): boolean {
  return (trade.pnlPct ?? 0) > 0;
}

function isLoss(trade: AnalyzedTrade): boolean {
  return (trade.pnlPct ?? 0) < 0;
}

function winRate(trades: readonly AnalyzedTrade[]): number {
  return trades.length === 0 ? 0 : trades.filter(isWin).length / trades.length;
}

function missedWinners(episodes: readonly SkipEpisode[]): number {
  return episodes.filter((episode) => episode.outcome === 'missed-winner').length;
}

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function finding(
  direction: Direction,
  sample: number,
  minSample: number,
  effect: number,
  evidence: string,
): RuleFinding {
  return { direction, sample, minSample, effect: Math.max(0, Math.min(1, effect)), evidence };
}

/** The better-supported of two opposite findings, ignoring any below its minimum sample. */
function strongest(...findings: Array<RuleFinding | null>): RuleFinding | null {
  return (
    findings
      .filter((item): item is RuleFinding => item !== null && item.sample >= item.minSample)
      .sort(
        (left, right) =>
          right.effect * Math.sqrt(right.sample) - left.effect * Math.sqrt(left.sample),
      )[0] ?? null
  );
}

function blockedOnlyBy(episodes: readonly SkipEpisode[], gate: string): SkipEpisode[] {
  return episodes.filter(
    (episode) => episode.blockedBy.length === 1 && episode.blockedBy[0] === gate,
  );
}

function blockedBy(episodes: readonly SkipEpisode[], gate: string): SkipEpisode[] {
  return episodes.filter((episode) => episode.blockedBy.includes(gate));
}

/** "Gate X mostly blocked winners" finding shared by several rules. */
function gateBlockedWinners(
  episodes: readonly SkipEpisode[],
  direction: Direction,
  minSample: number,
  what: string,
): RuleFinding | null {
  const missed = missedWinners(episodes);
  return episodes.length > 0 && missed / episodes.length >= 0.6
    ? finding(
        direction,
        episodes.length,
        minSample,
        missed / episodes.length,
        `${missed} of ${episodes.length} setups ${what} would have won (estimated).`,
      )
    : null;
}

export const RULES: readonly EnhancementRule[] = [
  {
    key: 'stop-loss-width',
    param: 'stopLossPct',
    minSample: 8,
    why: {
      increase:
        'Many stop-loss exits were followed by a recovery the same day, so the stop sits inside normal price swings.',
      decrease:
        'Losses at the stop are much larger than typical wins and most stopped trades never showed a profit, so the stop gives back too much on bad entries.',
    },
    expectedEffect: {
      increase:
        'Fewer trades shaken out by normal swings; slightly larger losses when the stop does trigger.',
      decrease: 'Smaller losses on bad entries, at the cost of a few more early exits.',
    },
    citations: ['kaminski-lo-2014', 'han-zhou-zhu-2016'],
    evaluate: ({ trades }) => {
      const stops = trades.filter((trade) => trade.exitReason === 'stop-loss');
      const recovered = stops.filter(
        (trade) => (trade.afterExitBestPct ?? -Infinity) >= MISSED_WINNER_PCT,
      ).length;
      const looser =
        stops.length > 0 && recovered / stops.length >= 0.5
          ? finding(
              'increase',
              stops.length,
              8,
              recovered / stops.length,
              `${recovered} of ${stops.length} stop-loss exits would have recovered to +10% or more later that day (estimated).`,
            )
          : null;
      const averageWin = mean(trades.filter(isWin).map((trade) => trade.pnlPct ?? 0));
      const averageStopLoss = mean(stops.map((trade) => -(trade.pnlPct ?? 0)));
      const neverUp = stops.filter((trade) => (trade.bestPct ?? 0) < 5).length;
      const tighter =
        averageWin !== null &&
        averageWin > 0 &&
        averageStopLoss !== null &&
        averageStopLoss >= 1.5 * averageWin &&
        neverUp / stops.length >= 0.5
          ? finding(
              'decrease',
              stops.length,
              8,
              averageStopLoss / averageWin / 3,
              `Stop-loss exits lost ${averageStopLoss.toFixed(1)}% on average versus ${averageWin.toFixed(1)}% gained by winners; ${neverUp} of ${stops.length} never reached +5%.`,
            )
          : null;
      return strongest(looser, tighter);
    },
  },
  {
    key: 'trail-keep',
    param: 'trailKeepFraction',
    minSample: 8,
    why: {
      increase:
        'Winning trades gave back most of their best gain before the trailing stop sold them.',
      decrease:
        'The trailing stop often sold just before the move continued, cutting winners short.',
    },
    expectedEffect: {
      increase: 'More of each winning move is kept; some trades are sold earlier on small dips.',
      decrease: 'Winners get more room to run; a bit more profit is given back when a move ends.',
    },
    citations: ['shefrin-statman-1985', 'kaminski-lo-2014'],
    evaluate: ({ trades }, params) => {
      const winners = trades.filter(
        (trade) =>
          (trade.bestPct ?? 0) >= params.trailActivatePct &&
          isWin(trade) &&
          trade.keptShare !== null,
      );
      const averageKept = mean(winners.map((trade) => trade.keptShare ?? 0));
      const raise =
        averageKept !== null && averageKept < 0.45
          ? finding(
              'increase',
              winners.length,
              8,
              (0.45 - averageKept) / 0.45,
              `Winning trades kept only ${percent(averageKept)} of their best gain on average.`,
            )
          : null;
      const trailExits = trades.filter((trade) => trade.exitReason === 'trailing-stop');
      const ranOn = trailExits.filter(
        (trade) =>
          trade.afterExitBestPct !== null &&
          trade.pnlPct !== null &&
          trade.afterExitBestPct - trade.pnlPct >= 15,
      ).length;
      const lower =
        trailExits.length > 0 && ranOn / trailExits.length >= 0.5
          ? finding(
              'decrease',
              trailExits.length,
              8,
              ranOn / trailExits.length,
              `${ranOn} of ${trailExits.length} trailing-stop exits kept running at least 15% further (estimated).`,
            )
          : null;
      return strongest(raise, lower);
    },
  },
  {
    key: 'time-stop',
    param: 'timeStopMinutes',
    minSample: 8,
    why: {
      increase: 'Trades closed for lack of progress often made their move shortly afterwards.',
      decrease:
        'Stalled trades kept losing value after the time stop, so waiting longer only adds time decay.',
    },
    expectedEffect: {
      increase:
        'Slow starters get time to work; a little more time decay on trades that never move.',
      decrease: 'Less money lost to time decay on trades that are not working.',
    },
    citations: ['muravyev-ni-2020', 'hull-options'],
    evaluate: ({ trades }) => {
      const timed = trades.filter((trade) => trade.exitReason === 'time-stop');
      const movedLater = timed.filter(
        (trade) => (trade.afterExitBestPct ?? -Infinity) >= 15,
      ).length;
      const longer =
        timed.length > 0 && movedLater / timed.length >= 0.5
          ? finding(
              'increase',
              timed.length,
              8,
              movedLater / timed.length,
              `${movedLater} of ${timed.length} time-stop exits would later have reached +15% (estimated).`,
            )
          : null;
      const averageEnd = mean(
        timed.flatMap((trade) => (trade.afterExitEndPct === null ? [] : [trade.afterExitEndPct])),
      );
      const shorter =
        averageEnd !== null && averageEnd <= -8 && movedLater / timed.length < 0.2
          ? finding(
              'decrease',
              timed.length,
              8,
              -averageEnd / 20,
              `After time-stop exits the option would have ended the day ${averageEnd.toFixed(1)}% from the entry price on average (estimated).`,
            )
          : null;
      return strongest(longer, shorter);
    },
  },
  {
    key: 'entry-score',
    param: 'minEntryScore',
    minSample: 10,
    why: {
      increase:
        'Trades taken with the minimum number of agreeing signals lost more often than they won.',
      decrease: 'Setups just one signal short of the threshold would mostly have been profitable.',
    },
    expectedEffect: {
      increase: 'Fewer but better-confirmed trades.',
      decrease: 'More trades from setups that have been working, with a small risk of more noise.',
    },
    citations: ['moskowitz-ooi-pedersen-2012', 'harvey-liu-zhu-2016'],
    evaluate: ({ trades, episodes }, params) => {
      const atMinimum = trades.filter(
        (trade) => trade.entry !== null && Math.abs(trade.entry.score) === params.minEntryScore,
      );
      const wins = atMinimum.filter(isWin).length;
      const averagePnl = mean(atMinimum.map((trade) => trade.pnlPct ?? 0));
      const raise =
        averagePnl !== null && averagePnl < 0 && wilsonInterval(wins, atMinimum.length).high < 0.5
          ? finding(
              'increase',
              atMinimum.length,
              10,
              0.5 - wins / atMinimum.length,
              `Trades with exactly ${params.minEntryScore} agreeing signals won ${wins} of ${atMinimum.length} (average ${averagePnl.toFixed(1)}%).`,
            )
          : null;
      const justBelow = blockedOnlyBy(episodes, 'weak-signal').filter(
        (episode) => Math.abs(episode.score) === params.minEntryScore - 1,
      );
      const missed = missedWinners(justBelow);
      const gains = justBelow.reduce(
        (sum, episode) => sum + Math.max(episode.estPnlPct ?? 0, 0),
        0,
      );
      const losses = justBelow.reduce(
        (sum, episode) => sum + Math.max(-(episode.estPnlPct ?? 0), 0),
        0,
      );
      const profitFactor = losses > 0 ? gains / losses : gains > 0 ? Infinity : 0;
      const lower =
        justBelow.length > 0 &&
        wilsonInterval(missed, justBelow.length).low > 0.5 &&
        profitFactor >= 1.2
          ? finding(
              'decrease',
              justBelow.length,
              12,
              missed / justBelow.length - 0.5,
              `${missed} of ${justBelow.length} setups one signal short of the threshold would have won (estimated).`,
            )
          : null;
      return strongest(raise, lower);
    },
  },
  {
    key: 'opposing-votes',
    param: 'maxOpposingVotes',
    minSample: 8,
    why: {
      decrease:
        'Trades bought while one signal pointed the other way won clearly less often than fully agreeing setups.',
    },
    expectedEffect: {
      decrease: 'Only buy when no signal disagrees: fewer trades, cleaner setups.',
    },
    citations: ['pan-poteshman-2006', 'easley-ohara-srinivas-1998'],
    evaluate: ({ trades }) => {
      const withOne = trades.filter((trade) => trade.entry?.opposingVotes === 1);
      const withNone = trades.filter((trade) => trade.entry?.opposingVotes === 0);
      if (withOne.length === 0 || withNone.length === 0) {
        return null;
      }
      const gap = winRate(withNone) - winRate(withOne);
      return gap >= 0.15
        ? finding(
            'decrease',
            Math.min(withOne.length, withNone.length),
            8,
            gap,
            `Win rate was ${percent(winRate(withNone))} with no opposing signal versus ${percent(winRate(withOne))} with one.`,
          )
        : null;
    },
  },
  {
    key: 'entry-start',
    param: 'entryStartMinute',
    minSample: 8,
    why: {
      increase:
        'Trades opened in the first half hour of the trading window lost more often than they won; early prices are noisy.',
    },
    expectedEffect: {
      increase: 'Skips the noisiest part of the morning; may miss some early breakouts.',
    },
    citations: ['berkman-et-al-2012', 'andersen-bollerslev-1997'],
    evaluate: ({ trades }, params) => {
      const early = trades.filter(
        (trade) => trade.entry !== null && trade.entry.minute < params.entryStartMinute + 30,
      );
      const wins = early.filter(isWin).length;
      return early.length > 0 && wilsonInterval(wins, early.length).high < 0.45
        ? finding(
            'increase',
            early.length,
            8,
            0.45 - wins / early.length,
            `Trades opened before ${formatClockTime(params.entryStartMinute + 30)} won ${wins} of ${early.length}.`,
          )
        : null;
    },
  },
  {
    key: 'entry-cutoff',
    param: 'lastEntryMinute',
    minSample: 8,
    why: {
      decrease:
        'Late trades lost money on average and mostly ended at the time stop or the 3:15 PM sell-off, without enough time to work.',
      increase: 'Setups that appeared after the entry cutoff would mostly have been profitable.',
    },
    expectedEffect: {
      decrease: 'Avoids late trades that run out of time.',
      increase: 'Captures more late-day moves, with less time before the 3:15 PM exit.',
    },
    citations: ['gao-han-li-zhou-2018', 'hull-options'],
    evaluate: ({ trades, episodes }, params) => {
      const late = trades.filter(
        (trade) => trade.entry !== null && trade.entry.minute >= params.lastEntryMinute - 60,
      );
      const ranOutOfTime = late.filter(
        (trade) => trade.exitReason === 'time-stop' || trade.exitReason === 'square-off',
      ).length;
      const averagePnl = mean(late.map((trade) => trade.pnlPct ?? 0));
      const earlier =
        averagePnl !== null && averagePnl < 0 && ranOutOfTime / late.length >= 0.6
          ? finding(
              'decrease',
              late.length,
              8,
              ranOutOfTime / late.length,
              `Trades opened in the last hour of the window averaged ${averagePnl.toFixed(1)}%, and ${ranOutOfTime} of ${late.length} ended by the time stop or the 3:15 PM sell-off.`,
            )
          : null;
      const afterCutoff = blockedOnlyBy(episodes, 'entry-window').filter(
        (episode) => istClock(episode.startAt).minute > params.lastEntryMinute,
      );
      return strongest(
        earlier,
        gateBlockedWinners(afterCutoff, 'increase', 10, 'after the cutoff'),
      );
    },
  },
  {
    key: 'daily-loss-limit',
    param: 'maxLosingTradesPerDay',
    minSample: 8,
    why: {
      decrease: 'Trades taken after a losing trade on the same day lost most of the time.',
      increase: 'The daily loss limit mostly blocked setups that would have won.',
    },
    expectedEffect: {
      decrease: 'Stops trading sooner on bad days, protecting capital.',
      increase: 'Allows one more attempt on days when the market turns.',
    },
    citations: ['coval-shumway-2005', 'barber-odean-2000', 'sebi-fo-studies'],
    evaluate: ({ trades, episodes }) => {
      const afterLoss = trades.filter((trade) => trade.afterLossSameDay);
      const losses = afterLoss.filter(isLoss).length;
      const lower =
        afterLoss.length > 0 && losses / afterLoss.length >= 0.65
          ? finding(
              'decrease',
              afterLoss.length,
              8,
              losses / afterLoss.length,
              `${losses} of ${afterLoss.length} trades taken after a same-day loss also lost.`,
            )
          : null;
      return strongest(
        lower,
        gateBlockedWinners(
          blockedBy(episodes, 'daily-loss-limit'),
          'increase',
          10,
          'blocked by the daily loss limit',
        ),
      );
    },
  },
  {
    key: 'fear-spike',
    param: 'maxVixRiseForCallsPct',
    minSample: 8,
    why: {
      decrease:
        'Calls bought while the fear index was already rising lost more often than they won.',
      increase: 'The fear-index block mostly stopped call trades that would have won.',
    },
    expectedEffect: {
      decrease: 'Fewer call trades into rising fear.',
      increase: 'More call trades on days with moderate fear.',
    },
    citations: ['whaley-2000'],
    evaluate: ({ trades, episodes }, params) => {
      const calls = trades.filter(
        (trade) =>
          trade.entry?.side === 'CE' &&
          trade.entry.vixPct !== null &&
          trade.entry.vixPct > params.maxVixRiseForCallsPct / 2,
      );
      const wins = calls.filter(isWin).length;
      const lower =
        calls.length > 0 && wilsonInterval(wins, calls.length).high < 0.5
          ? finding(
              'decrease',
              calls.length,
              8,
              0.5 - wins / calls.length,
              `Calls bought with the fear index up more than ${params.maxVixRiseForCallsPct / 2}% won ${wins} of ${calls.length}.`,
            )
          : null;
      return strongest(
        lower,
        gateBlockedWinners(
          blockedBy(episodes, 'fear-spike'),
          'increase',
          8,
          'blocked by the fear-index rule',
        ),
      );
    },
  },
  {
    key: 'iv-rich',
    param: 'maxIvToHv',
    minSample: 8,
    why: {
      decrease:
        'Options bought when they were expensive compared with normal market swings won clearly less often.',
    },
    expectedEffect: {
      decrease: 'Avoids overpriced options; slightly fewer trades on volatile days.',
    },
    citations: ['goyal-saretto-2009'],
    evaluate: ({ trades }) => {
      const priced = trades.filter(
        (trade) => trade.entry?.ivToHv !== null && trade.entry?.ivToHv !== undefined,
      );
      const rich = priced.filter((trade) => (trade.entry?.ivToHv ?? 0) > 1.15);
      const fair = priced.filter((trade) => (trade.entry?.ivToHv ?? 0) <= 1.15);
      if (rich.length === 0 || fair.length === 0) {
        return null;
      }
      const gap = winRate(fair) - winRate(rich);
      return gap >= 0.1
        ? finding(
            'decrease',
            Math.min(rich.length, fair.length),
            8,
            gap,
            `Win rate was ${percent(winRate(fair))} for fairly priced options versus ${percent(winRate(rich))} for expensive ones.`,
          )
        : null;
    },
  },
  {
    key: 'chase-limit',
    param: 'rsiChaseLimit',
    minSample: 8,
    why: {
      decrease:
        'Trades bought after a steep run-up, close to the chasing limit, lost most of the time.',
      increase: 'The chasing rule mostly blocked strong moves that kept going.',
    },
    expectedEffect: {
      decrease: 'Avoids buying late into stretched moves.',
      increase: 'Allows buying into strong trends a little longer.',
    },
    citations: ['wilder-1978', 'brock-lakonishok-lebaron-1992'],
    evaluate: ({ trades, episodes }, params) => {
      const stretched = trades.filter((trade) => {
        const rsi = trade.entry?.rsi;
        if (rsi === null || rsi === undefined) {
          return false;
        }
        return trade.entry?.side === 'CE'
          ? rsi >= params.rsiChaseLimit - 5
          : rsi <= 100 - params.rsiChaseLimit + 5;
      });
      const losses = stretched.filter(isLoss).length;
      const tighter =
        stretched.length > 0 && losses / stretched.length >= 0.65
          ? finding(
              'decrease',
              stretched.length,
              8,
              losses / stretched.length,
              `${losses} of ${stretched.length} trades bought close to the chasing limit lost.`,
            )
          : null;
      return strongest(
        tighter,
        gateBlockedWinners(blockedBy(episodes, 'chasing'), 'increase', 10, 'blocked as chasing'),
      );
    },
  },
  {
    key: 'news-window',
    param: 'newsLookbackMinutes',
    minSample: 8,
    why: {
      decrease:
        'Setups blocked by recent headlines mostly turned out profitable, so headlines block trades for too long.',
    },
    expectedEffect: { decrease: 'Headlines block new trades for a shorter time.' },
    citations: ['savor-wilson-2013', 'lucca-moench-2015'],
    evaluate: ({ episodes }) =>
      strongest(
        gateBlockedWinners(
          blockedBy(episodes, 'high-news'),
          'decrease',
          8,
          'blocked by major headlines',
        ),
      ),
  },
];

export function formatParamValue(param: TunableParam, value: number): string {
  if (param === 'entryStartMinute' || param === 'lastEntryMinute') {
    return formatClockTime(value);
  }
  if (param === 'trailKeepFraction') {
    return `${Math.round(value * 100)}%`;
  }
  if (param === 'maxIvToHv') {
    return value.toFixed(1);
  }
  return String(value);
}

/** Every rule whose evidence clears its minimum sample, as a one-step change within limits. */
export function evaluateRules(data: ReviewData, params: StrategyParams): RuleHit[] {
  const hits: RuleHit[] = [];
  for (const rule of RULES) {
    const result = rule.evaluate(data, params);
    if (!result || result.sample < result.minSample) {
      continue;
    }
    const limit = PARAM_LIMITS[rule.param];
    const fromValue = params[rule.param];
    const stepped =
      result.direction === 'increase' ? fromValue + limit.step : fromValue - limit.step;
    const toValue = Number(Math.min(limit.max, Math.max(limit.min, stepped)).toFixed(4));
    if (toValue === fromValue) {
      continue;
    }
    hits.push({
      ruleKey: rule.key,
      param: rule.param,
      direction: result.direction,
      fromValue,
      toValue,
      sample: result.sample,
      minSample: result.minSample,
      effect: result.effect,
      evidence: result.evidence,
      what: `${limit.label}: ${formatParamValue(rule.param, fromValue)} → ${formatParamValue(rule.param, toValue)}`,
      why: rule.why[result.direction] ?? '',
      expectedEffect: rule.expectedEffect[result.direction] ?? '',
      citations: rule.citations,
    });
  }
  return hits;
}

export function ruleMinSamples(): Record<string, number> {
  return Object.fromEntries(RULES.map((rule) => [rule.key, rule.minSample]));
}
