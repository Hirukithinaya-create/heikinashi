import React, { useMemo } from 'react';
import type { Language, TradeRecord } from '../types/trading';
import { t } from '../lib/i18n';

interface PnlAnalyticsViewProps {
  trades: TradeRecord[];
  language: Language;
  paperBalanceUsdt: number;
  openTrade?: TradeRecord | null;
  livePnl?: number;
  liveRoiPct?: number;
  liveMarkPrice?: number;
}

function formatUsd(val: number): string {
  const sign = val > 0 ? '+' : val < 0 ? '-' : '';
  return `${sign}$${Math.abs(val).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })}`;
}

export const PnlAnalyticsView: React.FC<PnlAnalyticsViewProps> = ({
  trades,
  language,
  paperBalanceUsdt,
  openTrade = null,
  livePnl = 0,
  liveRoiPct = 0,
  liveMarkPrice = 0
}) => {
  const copy = t(language);

  const stats = useMemo(() => {
    const now = Date.now();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const dayStartMs = startOfDay.getTime();
    const weekStartMs = now - 7 * 86_400_000;
    const monthStartMs = now - 30 * 86_400_000;
    const yearStartMs = now - 365 * 86_400_000;

    const closed = trades.filter((tr) => tr.status === 'CLOSED');
    let daily = 0;
    let weekly = 0;
    let monthly = 0;
    let yearly = 0;
    let grossProfit = 0;
    let grossLoss = 0;
    let wins = 0;

    for (const tr of closed) {
      const ts = tr.closedAtMs || tr.openedAtMs;
      const pnl = tr.realizedPnl;
      if (ts >= dayStartMs) daily += pnl;
      if (ts >= weekStartMs) weekly += pnl;
      if (ts >= monthStartMs) monthly += pnl;
      if (ts >= yearStartMs) yearly += pnl;

      if (pnl > 0) {
        wins += 1;
        grossProfit += pnl;
      } else if (pnl < 0) {
        grossLoss += Math.abs(pnl);
      }
    }

    const total = closed.length;
    const winRate = total > 0 ? (wins / total) * 100 : 0;
    const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9.99 : 0;

    // Group last 14 days for daily bar breakdown
    const dailyBuckets = new Map<string, number>();
    for (let d = 13; d >= 0; d--) {
      const date = new Date(now - d * 86_400_000);
      const key = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      dailyBuckets.set(key, 0);
    }
    for (const tr of closed) {
      const ts = tr.closedAtMs || tr.openedAtMs;
      if (now - ts <= 14 * 86_400_000) {
        const key = new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        if (dailyBuckets.has(key)) {
          dailyBuckets.set(key, (dailyBuckets.get(key) || 0) + tr.realizedPnl);
        }
      }
    }

    const bars = Array.from(dailyBuckets.entries()).map(([label, pnl]) => ({ label, pnl }));
    const maxAbs = Math.max(10, ...bars.map((b) => Math.abs(b.pnl)));

    // Group by pair
    const pairBreakdown = new Map<string, { trades: number; wins: number; pnl: number }>();
    for (const tr of closed) {
      const curr = pairBreakdown.get(tr.pair) || { trades: 0, wins: 0, pnl: 0 };
      curr.trades += 1;
      if (tr.realizedPnl > 0) curr.wins += 1;
      curr.pnl += tr.realizedPnl;
      pairBreakdown.set(tr.pair, curr);
    }

    return {
      daily,
      weekly,
      monthly,
      yearly,
      total,
      wins,
      winRate,
      profitFactor,
      bars,
      maxAbs,
      pairs: Array.from(pairBreakdown.entries()).map(([pair, data]) => ({ pair, ...data }))
    };
  }, [trades]);

  const periodCards = [
    { label: copy.dailyPnl, sub: '24H / Today', value: stats.daily },
    { label: copy.weeklyPnl, sub: '7 Days', value: stats.weekly },
    { label: copy.monthlyPnl, sub: '30 Days', value: stats.monthly },
    { label: copy.yearlyPnl, sub: '365 Days', value: stats.yearly }
  ];

  return (
    <div className="space-y-6">
      {/* Live Open Trade Unrealized PnL Banner */}
      {openTrade && (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
          <div className="space-y-0.5">
            <div className="text-xs text-slate-400">
              {copy.openPosition} · <span className="font-mono text-slate-200">{openTrade.pair}</span>
            </div>
            <div className="font-mono text-xs sm:text-sm text-slate-200">
              <span className={openTrade.side === 'BUY' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {openTrade.side}
              </span>
              <span className="text-slate-500 mx-1.5">·</span>
              <span>Entry {openTrade.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>
              <span className="text-slate-500 mx-1.5">→</span>
              <span>Mark {(liveMarkPrice || openTrade.entryPrice).toLocaleString('en-US', { maximumFractionDigits: 6 })}</span>
              <span className="text-slate-500 mx-1.5">·</span>
              <span>{openTrade.leverage}x</span>
            </div>
          </div>
          <div className="text-right font-mono">
            <div className="text-[11px] text-slate-400">{copy.livePnl}</div>
            <div
              className={`text-xl sm:text-2xl font-bold ${
                livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)}{' '}
              <span className="text-sm">
                ({livePnl >= 0 ? '+' : ''}{liveRoiPct.toFixed(2)}%)
              </span>
            </div>
          </div>
        </div>
      )}

      {/* 4-Period PnL Summary Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        {periodCards.map((item) => (
          <div
            key={item.label}
            className="bg-slate-900/70 border border-slate-800 rounded-xl p-4"
          >
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
              <span>{item.label}</span>
              <span className="font-mono text-slate-500">{item.sub}</span>
            </div>
            <div
              className={`text-xl sm:text-2xl font-bold font-mono ${
                item.value > 0
                  ? 'text-emerald-400'
                  : item.value < 0
                    ? 'text-rose-400'
                    : 'text-slate-200'
              }`}
            >
              {formatUsd(item.value)}
            </div>
          </div>
        ))}
      </div>

      {/* Portfolio Efficiency Metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">{copy.paperBalance}</div>
          <div className="text-lg font-semibold font-mono text-slate-100">
            ${paperBalanceUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">{copy.totalTrades}</div>
          <div className="text-lg font-semibold font-mono text-slate-100">{stats.total}</div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">{copy.winRate}</div>
          <div className="text-lg font-semibold font-mono text-sky-400">
            {stats.winRate.toFixed(1)}%
          </div>
        </div>
        <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-4">
          <div className="text-xs text-slate-400 mb-1">{copy.profitFactor}</div>
          <div className="text-lg font-semibold font-mono text-slate-100">
            {stats.profitFactor.toFixed(2)}
          </div>
        </div>
      </div>

      {/* 14-Day Daily Realized PnL Bar Chart */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 sm:p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-slate-100">14-Day Realized PnL</h3>
          <span className="text-xs text-slate-400 font-mono">USDT</span>
        </div>

        <div className="h-44 flex items-end justify-between gap-1.5 sm:gap-2 pt-4 border-b border-slate-800">
          {stats.bars.map((bar) => {
            const pct = Math.max(4, Math.round((Math.abs(bar.pnl) / stats.maxAbs) * 100));
            const positive = bar.pnl >= 0;
            return (
              <div key={bar.label} className="flex-1 flex flex-col items-center justify-end h-full group">
                <div className="text-[10px] font-mono text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity mb-1 whitespace-nowrap">
                  {bar.pnl !== 0 ? formatUsd(bar.pnl) : '0'}
                </div>
                <div
                  style={{ height: `${bar.pnl === 0 ? 3 : pct}%` }}
                  className={`w-full max-w-[28px] rounded-t transition-all ${
                    bar.pnl === 0
                      ? 'bg-slate-800'
                      : positive
                        ? 'bg-emerald-500/80 hover:bg-emerald-400'
                        : 'bg-rose-500/80 hover:bg-rose-400'
                  }`}
                />
              </div>
            );
          })}
        </div>
        <div className="flex items-center justify-between gap-1 pt-2 overflow-x-auto">
          {stats.bars.map((bar, idx) => (
            <span
              key={bar.label}
              className={`flex-1 text-center text-[10px] font-mono text-slate-500 ${
                idx % 2 !== 0 ? 'hidden sm:block' : ''
              }`}
            >
              {bar.label}
            </span>
          ))}
        </div>
      </div>

      {/* Pair Breakdown Table */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-100">Performance by Pair</h3>
          <span className="text-xs text-slate-400 font-mono">{stats.pairs.length} pairs</span>
        </div>
        {stats.pairs.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-500">{copy.emptyTrades}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="text-left py-2.5 px-4 font-medium">Pair</th>
                  <th className="text-right py-2.5 px-4 font-medium">Trades</th>
                  <th className="text-right py-2.5 px-4 font-medium">Win Rate</th>
                  <th className="text-right py-2.5 px-4 font-medium">{copy.netPnl}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {stats.pairs.map((row) => (
                  <tr key={row.pair} className="hover:bg-slate-800/40">
                    <td className="py-2.5 px-4 font-mono font-semibold text-slate-100">{row.pair}</td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-300">{row.trades}</td>
                    <td className="py-2.5 px-4 text-right font-mono text-slate-300">
                      {((row.wins / row.trades) * 100).toFixed(1)}%
                    </td>
                    <td
                      className={`py-2.5 px-4 text-right font-mono font-semibold ${
                        row.pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {formatUsd(row.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
