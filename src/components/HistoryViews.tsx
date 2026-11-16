import React, { useMemo, useState } from 'react';
import type { Language, SignalRecord, TradeRecord } from '../types/trading';
import { calculateUnrealizedPnl } from '../lib/strategy';
import { t } from '../lib/i18n';

interface HistoryViewsProps {
  mode: 'trades' | 'signals';
  trades: TradeRecord[];
  signals: SignalRecord[];
  language: Language;
  livePrices?: Record<string, number>;
}

function fmtPrice(val: number): string {
  if (!val) return '--';
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

export const HistoryViews: React.FC<HistoryViewsProps> = ({
  mode,
  trades,
  signals,
  language,
  livePrices = {}
}) => {
  const copy = t(language);
  const [sideFilter, setSideFilter] = useState<'ALL' | 'BUY' | 'SELL'>('ALL');
  const [pairFilter, setPairFilter] = useState('');

  const filteredTrades = useMemo(() => {
    const q = pairFilter.trim().toUpperCase();
    return trades.filter((tr) => {
      if (sideFilter !== 'ALL' && tr.side !== sideFilter) return false;
      if (q && !tr.pair.includes(q)) return false;
      return true;
    });
  }, [trades, sideFilter, pairFilter]);

  const filteredSignals = useMemo(() => {
    const q = pairFilter.trim().toUpperCase();
    return signals.filter((s) => {
      if (sideFilter === 'BUY' && !s.signalType.includes('BUY')) return false;
      if (sideFilter === 'SELL' && !s.signalType.includes('SELL')) return false;
      if (q && !s.pair.includes(q)) return false;
      return true;
    });
  }, [signals, sideFilter, pairFilter]);

  return (
    <div className="space-y-4">
      {/* Filter Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
          {(['ALL', 'BUY', 'SELL'] as const).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setSideFilter(f)}
              className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                sideFilter === f
                  ? 'bg-slate-800 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={pairFilter}
          onChange={(e) => setPairFilter(e.target.value)}
          placeholder="Filter pair (e.g. BTCUSDT)"
          className="w-full sm:w-56 min-h-[40px] px-3 py-1.5 text-sm bg-slate-900 border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
        />
      </div>

      {mode === 'trades' ? (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">{copy.navTrades}</h3>
            <span className="text-xs font-mono text-slate-400">{filteredTrades.length} records</span>
          </div>

          {filteredTrades.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">{copy.emptyTrades}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400">
                    <th className="text-left py-2.5 px-3 font-medium">Pair · TF</th>
                    <th className="text-left py-2.5 px-3 font-medium">Side</th>
                    <th className="text-right py-2.5 px-3 font-medium">Entry</th>
                    <th className="text-right py-2.5 px-3 font-medium">Exit / Mark</th>
                    <th className="text-right py-2.5 px-3 font-medium">Margin · Lev</th>
                    <th className="text-right py-2.5 px-3 font-medium">PnL (ROI)</th>
                    <th className="text-right py-2.5 px-3 font-medium">Opened Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {filteredTrades.map((tr) => {
                    const isBuy = tr.side === 'BUY';
                    const isOpen = tr.status === 'OPEN';
                    const mark = livePrices[tr.pair] || tr.entryPrice;
                    const liveStats = isOpen
                      ? calculateUnrealizedPnl(tr.side, tr.entryPrice, mark, tr.quantity, tr.marginUsdt)
                      : { pnl: tr.realizedPnl, roiPct: tr.realizedRoiPct };
                    const pnlVal = liveStats.pnl;
                    const roiVal = liveStats.roiPct;
                    const positive = pnlVal >= 0;

                    return (
                      <tr key={tr.id} className="hover:bg-slate-800/40">
                        <td className="py-3 px-3 font-mono whitespace-nowrap">
                          <span className="font-semibold text-slate-100">{tr.pair}</span>
                          <span className="text-slate-500 mx-1">·</span>
                          <span className="text-slate-400">{tr.timeframe}</span>
                        </td>
                        <td className="py-3 px-3 whitespace-nowrap">
                          <span
                            className={`font-mono font-semibold ${
                              isBuy ? 'text-emerald-400' : 'text-rose-400'
                            }`}
                          >
                            {tr.side}
                          </span>
                          <span className="text-slate-500 mx-1">·</span>
                          <span
                            className={`text-xs ${
                              tr.closeReason === 'STOP_LOSS'
                                ? 'text-amber-400 font-medium'
                                : tr.closeReason === 'RSI_CLOSE'
                                  ? 'text-cyan-400 font-medium'
                                  : isOpen
                                    ? 'text-sky-400 font-medium'
                                    : 'text-slate-400'
                            }`}
                          >
                            {tr.closeReason === 'STOP_LOSS'
                              ? 'SL'
                              : tr.closeReason === 'RSI_CLOSE'
                                ? 'RSI CLOSE'
                                : isOpen
                                  ? 'LIVE'
                                  : tr.status}
                          </span>
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-slate-200 whitespace-nowrap">
                          {fmtPrice(tr.entryPrice)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-slate-300 whitespace-nowrap">
                          {isOpen ? fmtPrice(mark) : fmtPrice(tr.exitPrice)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-slate-300 whitespace-nowrap">
                          ${tr.marginUsdt} · {tr.leverage}x
                        </td>
                        <td
                          className={`py-3 px-3 text-right font-mono font-semibold whitespace-nowrap ${
                            positive ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {`${positive ? '+' : '-'}$${Math.abs(pnlVal).toFixed(2)} (${
                            positive ? '+' : ''
                          }${roiVal.toFixed(1)}%)`}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-xs text-slate-400 whitespace-nowrap">
                          {new Date(tr.openedAtMs).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : (
        <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">{copy.navSignals}</h3>
            <span className="text-xs font-mono text-slate-400">{filteredSignals.length} signals</span>
          </div>

          {filteredSignals.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">{copy.emptySignals}</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs sm:text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-xs text-slate-400">
                    <th className="text-left py-2.5 px-3 font-medium">Signal</th>
                    <th className="text-left py-2.5 px-3 font-medium">Pair · TF</th>
                    <th className="text-right py-2.5 px-3 font-medium">Price</th>
                    <th className="text-right py-2.5 px-3 font-medium">RSI</th>
                    <th className="text-right py-2.5 px-3 font-medium">Ref Level</th>
                    <th className="text-left py-2.5 px-3 font-medium hidden lg:table-cell">Condition</th>
                    <th className="text-right py-2.5 px-3 font-medium">Time</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70">
                  {filteredSignals.map((sig) => {
                    const isBuy = sig.signalType.includes('BUY');
                    const isRsiClose = sig.signalType === 'RSI_CLOSE';
                    const isArmedOrSl =
                      sig.signalType.startsWith('ARMED') || sig.signalType === 'STOP_LOSS';
                    return (
                      <tr key={sig.id} className="hover:bg-slate-800/40">
                        <td className="py-3 px-3 font-mono font-semibold whitespace-nowrap">
                          <span
                            className={
                              isRsiClose
                                ? 'text-cyan-400'
                                : isArmedOrSl
                                  ? 'text-amber-400'
                                  : isBuy
                                    ? 'text-emerald-400'
                                    : 'text-rose-400'
                            }
                          >
                            {sig.signalType}
                          </span>
                        </td>
                        <td className="py-3 px-3 font-mono whitespace-nowrap text-slate-200">
                          {sig.pair} <span className="text-slate-500">·</span> {sig.timeframe}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-slate-200 whitespace-nowrap">
                          {fmtPrice(sig.price)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-sky-400 whitespace-nowrap">
                          {sig.rsi.toFixed(1)}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-slate-300 whitespace-nowrap">
                          {fmtPrice(sig.referenceLevel)}
                        </td>
                        <td className="py-3 px-3 text-xs text-slate-400 hidden lg:table-cell max-w-xs truncate">
                          {sig.note}
                        </td>
                        <td className="py-3 px-3 text-right font-mono text-xs text-slate-400 whitespace-nowrap">
                          {new Date(sig.candleTimeMs).toLocaleString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
