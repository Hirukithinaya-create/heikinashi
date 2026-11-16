import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshCw, ArrowUpRight } from 'lucide-react';
import type { Language, Timeframe } from '../types/trading';
import { t } from '../lib/i18n';

interface ScannerEntry {
  symbol: string;
  interval: string;
  price: number;
  priceChangePercent: number;
  quoteVolume: number;
  rsi: number;
  closedRsi: number;
  haColor: 'GREEN' | 'RED';
  zone: 'OVERBOUGHT' | 'OVERSOLD' | 'NEAR_OB' | 'NEAR_OS' | 'NEUTRAL';
  armedSignal: 'SELL_WATCH' | 'BUY_WATCH' | 'NONE';
}

interface RsiScannerViewProps {
  language: Language;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  activeTimeframe: Timeframe;
  onSelectPairAndTimeframe: (symbol: string, interval: Timeframe) => void;
}

const ALL_1M_TO_1D_TFS: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];

const SCANNER_TIMEFRAMES: Array<{ id: string; label: string }> = [
  { id: 'MULTI', label: '1m – 1d' },
  { id: '1m', label: '1m' },
  { id: '3m', label: '3m' },
  { id: '5m', label: '5m' },
  { id: '15m', label: '15m' },
  { id: '30m', label: '30m' },
  { id: '1h', label: '1h' },
  { id: '2h', label: '2h' },
  { id: '4h', label: '4h' },
  { id: '6h', label: '6h' },
  { id: '12h', label: '12h' },
  { id: '1d', label: '1d' },
  { id: '1w', label: '1w' }
];

function fmtPrice(val: number): string {
  if (!val) return '--';
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

export const RsiScannerView: React.FC<RsiScannerViewProps> = ({
  language,
  rsiPeriod,
  rsiOverbought,
  rsiOversold,
  activeTimeframe,
  onSelectPairAndTimeframe
}) => {
  const copy = t(language);
  const [selectedTf, setSelectedTf] = useState<string>('MULTI');
  const [multiViewMode, setMultiViewMode] = useState<'MATRIX' | 'LIST'>('MATRIX');
  const [zoneFilter, setZoneFilter] = useState<'HITS' | 'OVERSOLD' | 'OVERBOUGHT' | 'ALL'>('HITS');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<ScannerEntry[]>([]);
  const [scannedAt, setScannedAt] = useState<number>(0);

  const runScan = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const params = new URLSearchParams({
          interval: selectedTf,
          rsiPeriod: String(rsiPeriod),
          overbought: String(rsiOverbought),
          oversold: String(rsiOversold),
          refresh: force ? '1' : '0'
        });
        const res = await fetch(`/api/binance/scanner?${params.toString()}`);
        if (res.ok) {
          const data = (await res.json()) as { items?: ScannerEntry[]; scannedAt?: number };
          setItems(Array.isArray(data.items) ? data.items : []);
          setScannedAt(data.scannedAt || Date.now());
        }
      } catch {
        // Ignore transient network errors
      } finally {
        setLoading(false);
      }
    },
    [selectedTf, rsiPeriod, rsiOverbought, rsiOversold]
  );

  useEffect(() => {
    runScan(false);
  }, [runScan]);

  const counts = useMemo(() => {
    let ob = 0;
    let os = 0;
    for (const item of items) {
      if (item.zone === 'OVERBOUGHT') ob += 1;
      if (item.zone === 'OVERSOLD') os += 1;
    }
    return { ob, os, totalHits: ob + os };
  }, [items]);

  const matrixRows = useMemo(() => {
    const q = search.trim().toUpperCase();
    const map = new Map<
      string,
      {
        symbol: string;
        price: number;
        priceChangePercent: number;
        quoteVolume: number;
        byTf: Record<string, ScannerEntry>;
        hasOs: boolean;
        hasOb: boolean;
      }
    >();

    for (const item of items) {
      if (q && !item.symbol.includes(q)) continue;
      let row = map.get(item.symbol);
      if (!row) {
        row = {
          symbol: item.symbol,
          price: item.price,
          priceChangePercent: item.priceChangePercent,
          quoteVolume: item.quoteVolume,
          byTf: {},
          hasOs: false,
          hasOb: false
        };
        map.set(item.symbol, row);
      }
      row.byTf[item.interval] = item;
      if (item.zone === 'OVERSOLD') row.hasOs = true;
      if (item.zone === 'OVERBOUGHT') row.hasOb = true;
    }

    let rows = Array.from(map.values());
    if (zoneFilter === 'OVERSOLD') {
      const filtered = rows.filter((r) => r.hasOs);
      if (filtered.length > 0) rows = filtered;
    } else if (zoneFilter === 'OVERBOUGHT') {
      const filtered = rows.filter((r) => r.hasOb);
      if (filtered.length > 0) rows = filtered;
    }

    rows.sort((a, b) => {
      const aHit = a.hasOb || a.hasOs ? 0 : 1;
      const bHit = b.hasOb || b.hasOs ? 0 : 1;
      if (aHit !== bHit) return aHit - bHit;
      return b.quoteVolume - a.quoteVolume;
    });
    return rows;
  }, [items, search, zoneFilter]);

  const { displayedItems, showingFallbackNearest } = useMemo(() => {
    const q = search.trim().toUpperCase();
    const bySearch = q ? items.filter((i) => i.symbol.includes(q)) : items;

    if (zoneFilter === 'ALL') {
      return { displayedItems: bySearch, showingFallbackNearest: false };
    }
    if (zoneFilter === 'OVERSOLD') {
      const strict = bySearch.filter((i) => i.zone === 'OVERSOLD');
      if (strict.length > 0) return { displayedItems: strict, showingFallbackNearest: false };
      return {
        displayedItems: [...bySearch].sort((a, b) => a.rsi - b.rsi).slice(0, 15),
        showingFallbackNearest: true
      };
    }
    if (zoneFilter === 'OVERBOUGHT') {
      const strict = bySearch.filter((i) => i.zone === 'OVERBOUGHT');
      if (strict.length > 0) return { displayedItems: strict, showingFallbackNearest: false };
      return {
        displayedItems: [...bySearch].sort((a, b) => b.rsi - a.rsi).slice(0, 15),
        showingFallbackNearest: true
      };
    }

    // Default 'HITS' (both <=22 and >=80)
    const strictHits = bySearch.filter((i) => i.zone === 'OVERBOUGHT' || i.zone === 'OVERSOLD');
    if (strictHits.length > 0) {
      return { displayedItems: strictHits, showingFallbackNearest: false };
    }
    return {
      displayedItems: bySearch.slice(0, 18),
      showingFallbackNearest: true
    };
  }, [items, zoneFilter, search]);

  const isMatrixMode = selectedTf === 'MULTI' && multiViewMode === 'MATRIX';

  return (
    <div className="space-y-4">
      {/* Scanner Header */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-100">{copy.scannerTitle}</h2>
          <p className="text-xs text-slate-400 mt-0.5">{copy.scannerSubtitle}</p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <div className="text-xs font-mono text-slate-400">
            <span className="text-emerald-400 font-semibold">{counts.os}</span> ≤{rsiOversold}
            <span className="mx-1.5 text-slate-600">·</span>
            <span className="text-rose-400 font-semibold">{counts.ob}</span> ≥{rsiOverbought}
          </div>
          <button
            type="button"
            onClick={() => runScan(true)}
            disabled={loading}
            className="min-h-[40px] px-3.5 py-2 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-white flex items-center gap-1.5 whitespace-nowrap transition-colors"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span>{loading ? copy.scannerScanning : copy.scannerRefresh}</span>
          </button>
        </div>
      </div>

      {/* Timeframe Tabs */}
      <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl p-2 flex items-center gap-1 overflow-x-auto">
        {SCANNER_TIMEFRAMES.map((tf) => {
          const active = selectedTf === tf.id;
          return (
            <button
              key={tf.id}
              type="button"
              onClick={() => setSelectedTf(tf.id)}
              className={`min-h-[38px] px-3 py-1.5 rounded-lg text-xs font-mono whitespace-nowrap shrink-0 transition-colors ${
                active
                  ? 'bg-sky-600 text-white font-semibold'
                  : tf.id === activeTimeframe
                    ? 'bg-slate-800/70 text-sky-300 hover:bg-slate-800'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {tf.id === 'MULTI' ? `${copy.scannerAllTf} (${tf.label})` : tf.label}
            </button>
          );
        })}
      </div>

      {/* Zone Filters + View Mode Switch + Search */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {selectedTf === 'MULTI' && (
            <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
              <button
                type="button"
                onClick={() => setMultiViewMode('MATRIX')}
                className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap transition-colors ${
                  multiViewMode === 'MATRIX'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {copy.scannerViewMatrix}
              </button>
              <button
                type="button"
                onClick={() => setMultiViewMode('LIST')}
                className={`min-h-[36px] px-3 py-1.5 text-xs font-semibold rounded-md whitespace-nowrap transition-colors ${
                  multiViewMode === 'LIST'
                    ? 'bg-sky-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {copy.scannerViewList}
              </button>
            </div>
          )}

          <div className="flex items-center gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg overflow-x-auto">
            {(
              [
                { id: 'HITS', label: `RSI ≤${rsiOversold} & ≥${rsiOverbought}` },
                { id: 'OVERSOLD', label: `RSI ≤ ${rsiOversold} (Buy)` },
                { id: 'OVERBOUGHT', label: `RSI ≥ ${rsiOverbought} (Sell)` },
                { id: 'ALL', label: copy.scannerFilterAll }
              ] as const
            ).map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setZoneFilter(f.id)}
                className={`min-h-[36px] px-3 py-1.5 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                  zoneFilter === f.id
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>

        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Filter pair (e.g. BTC, SOL)..."
          className="w-full sm:w-56 min-h-[40px] px-3 py-1.5 text-sm bg-slate-900 border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
        />
      </div>

      {!isMatrixMode && showingFallbackNearest && !loading && (
        <div className="bg-slate-900/50 border border-slate-800 rounded-xl px-4 py-2.5 text-xs text-slate-300">
          {copy.scannerEmptyStrict}
        </div>
      )}

      {/* Results Table */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between text-xs text-slate-400">
          <span className="font-semibold text-slate-200">
            {isMatrixMode ? `${matrixRows.length} pairs · 1m – 1d` : `${displayedItems.length} pairs`}
          </span>
          {scannedAt > 0 && (
            <span className="font-mono">
              Updated {new Date(scannedAt).toLocaleTimeString()}
            </span>
          )}
        </div>

        {loading && items.length === 0 ? (
          <div className="divide-y divide-slate-800/70">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="h-12 px-4 flex items-center justify-between animate-pulse">
                <div className="h-3.5 w-28 bg-slate-800 rounded" />
                <div className="h-3.5 w-20 bg-slate-800 rounded" />
                <div className="h-3.5 w-16 bg-slate-800 rounded" />
              </div>
            ))}
          </div>
        ) : isMatrixMode ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] text-slate-400">
                  <th className="text-left py-2.5 px-3 font-medium sticky left-0 bg-slate-900 z-10">Pair</th>
                  <th className="text-right py-2.5 px-2.5 font-medium">Price</th>
                  {ALL_1M_TO_1D_TFS.map((tf) => (
                    <th key={tf} className="text-center py-2.5 px-2 font-mono font-medium whitespace-nowrap">
                      {tf}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {matrixRows.map((row) => (
                  <tr key={row.symbol} className="hover:bg-slate-800/35">
                    <td className="py-2.5 px-3 font-mono whitespace-nowrap sticky left-0 bg-slate-900/95 z-10 border-r border-slate-800/70">
                      <div className="font-semibold text-white">{row.symbol}</div>
                      <div
                        className={`text-[10px] ${
                          row.priceChangePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {row.priceChangePercent >= 0 ? '+' : ''}
                        {row.priceChangePercent.toFixed(2)}%
                      </div>
                    </td>
                    <td className="py-2.5 px-2.5 text-right font-mono text-slate-200 whitespace-nowrap">
                      {fmtPrice(row.price)}
                    </td>
                    {ALL_1M_TO_1D_TFS.map((tf) => {
                      const cell = row.byTf[tf];
                      if (!cell) {
                        return (
                          <td key={tf} className="py-2 px-2 text-center font-mono text-slate-600">
                            --
                          </td>
                        );
                      }
                      const isOb = cell.zone === 'OVERBOUGHT';
                      const isOs = cell.zone === 'OVERSOLD';
                      const cellCls = isOb
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/40 font-bold'
                        : isOs
                          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
                          : cell.zone === 'NEAR_OB'
                            ? 'bg-rose-500/10 text-rose-300/90 border-rose-500/20'
                            : cell.zone === 'NEAR_OS'
                              ? 'bg-emerald-500/10 text-emerald-300/90 border-emerald-500/20'
                              : 'bg-slate-950/60 text-slate-300 border-slate-800/70';
                      return (
                        <td key={tf} className="py-1.5 px-1 text-center font-mono">
                          <button
                            type="button"
                            onClick={() => onSelectPairAndTimeframe(row.symbol, tf)}
                            title={`${row.symbol} ${tf}: RSI ${cell.rsi.toFixed(1)} (${cell.haColor})`}
                            className={`min-w-[46px] px-1.5 py-1 rounded border text-[11px] transition-colors hover:border-sky-400 ${cellCls}`}
                          >
                            {cell.rsi.toFixed(1)}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs sm:text-sm">
              <thead>
                <tr className="border-b border-slate-800 text-xs text-slate-400">
                  <th className="text-left py-2.5 px-3 font-medium">Pair · TF</th>
                  <th className="text-right py-2.5 px-3 font-medium">Price</th>
                  <th className="text-right py-2.5 px-3 font-medium">24h</th>
                  <th className="text-right py-2.5 px-3 font-medium">Live RSI</th>
                  <th className="text-right py-2.5 px-3 font-medium hidden sm:table-cell">Closed RSI</th>
                  <th className="text-left py-2.5 px-3 font-medium">HA · Watch</th>
                  <th className="text-right py-2.5 px-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {displayedItems.map((item) => {
                  const isOb = item.zone === 'OVERBOUGHT';
                  const isOs = item.zone === 'OVERSOLD';
                  const rsiColor = isOb
                    ? 'text-rose-400 font-bold'
                    : isOs
                      ? 'text-emerald-400 font-bold'
                      : item.zone === 'NEAR_OB'
                        ? 'text-rose-300'
                        : item.zone === 'NEAR_OS'
                          ? 'text-emerald-300'
                          : 'text-slate-300';

                  return (
                    <tr
                      key={`${item.symbol}_${item.interval}`}
                      onClick={() =>
                        onSelectPairAndTimeframe(item.symbol, item.interval as Timeframe)
                      }
                      className="hover:bg-slate-800/50 cursor-pointer transition-colors"
                    >
                      <td className="py-3 px-3 font-mono whitespace-nowrap">
                        <span className="font-semibold text-white">{item.symbol}</span>
                        <span className="text-slate-500 mx-1">·</span>
                        <span className="text-sky-400">{item.interval}</span>
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-slate-200 whitespace-nowrap">
                        {fmtPrice(item.price)}
                      </td>
                      <td
                        className={`py-3 px-3 text-right font-mono whitespace-nowrap ${
                          item.priceChangePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {item.priceChangePercent >= 0 ? '+' : ''}
                        {item.priceChangePercent.toFixed(2)}%
                      </td>
                      <td className={`py-3 px-3 text-right font-mono whitespace-nowrap ${rsiColor}`}>
                        {item.rsi.toFixed(1)}
                      </td>
                      <td className="py-3 px-3 text-right font-mono text-slate-400 hidden sm:table-cell whitespace-nowrap">
                        {item.closedRsi.toFixed(1)}
                      </td>
                      <td className="py-3 px-3 font-mono text-xs whitespace-nowrap">
                        <span
                          className={
                            item.haColor === 'GREEN' ? 'text-emerald-400' : 'text-rose-400'
                          }
                        >
                          {item.haColor}
                        </span>
                        {item.armedSignal !== 'NONE' && (
                          <>
                            <span className="text-slate-500 mx-1">·</span>
                            <span
                              className={
                                item.armedSignal === 'SELL_WATCH'
                                  ? 'text-rose-400 font-semibold'
                                  : 'text-emerald-400 font-semibold'
                              }
                            >
                              {item.armedSignal === 'SELL_WATCH' ? 'SELL WATCH' : 'BUY WATCH'}
                            </span>
                          </>
                        )}
                      </td>
                      <td className="py-3 px-3 text-right whitespace-nowrap">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onSelectPairAndTimeframe(item.symbol, item.interval as Timeframe);
                          }}
                          className="min-h-[34px] px-2.5 py-1 rounded-md bg-slate-800 hover:bg-sky-600 text-xs font-medium text-slate-100 inline-flex items-center gap-1 transition-colors"
                        >
                          <span>{copy.scannerOpenPair}</span>
                          <ArrowUpRight className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
