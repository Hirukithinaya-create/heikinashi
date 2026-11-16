import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { PairInfo } from '../types/trading';

interface PairSelectorModalProps {
  open: boolean;
  pairs: PairInfo[];
  selectedPair: string;
  placeholder: string;
  onSelect: (symbol: string) => void;
  onClose: () => void;
}

export const PairSelectorModal: React.FC<PairSelectorModalProps> = ({
  open,
  pairs,
  selectedPair,
  placeholder,
  onSelect,
  onClose
}) => {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toUpperCase();
    if (!q) return pairs.slice(0, 80);
    return pairs
      .filter((p) => p.symbol.includes(q) || p.baseAsset.includes(q))
      .slice(0, 80);
  }, [pairs, query]);

  const customCandidate = query.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  const showCustomAdd =
    customCandidate.length >= 5 &&
    !filtered.some((p) => p.symbol === customCandidate);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/70 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-slate-900 border border-slate-800 rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl max-h-[82vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-100">Select Binance Pair</h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 border-b border-slate-800">
          <div className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={placeholder}
              className="w-full pl-9 pr-3 py-2.5 text-sm bg-slate-950 border border-slate-800 rounded-lg text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-sky-500"
            />
          </div>
        </div>

        <div className="overflow-y-auto flex-1 divide-y divide-slate-800/60">
          {showCustomAdd && (
            <button
              type="button"
              onClick={() => {
                onSelect(customCandidate);
                onClose();
              }}
              className="w-full min-h-[48px] px-4 py-2.5 flex items-center justify-between text-left hover:bg-slate-800/60 transition-colors"
            >
              <div>
                <div className="text-sm font-semibold text-sky-400 font-mono">{customCandidate}</div>
                <div className="text-xs text-slate-400">Load custom Binance symbol</div>
              </div>
              <span className="text-xs text-sky-400 font-medium">Select</span>
            </button>
          )}

          {filtered.map((p) => {
            const active = p.symbol === selectedPair;
            return (
              <button
                key={p.symbol}
                type="button"
                onClick={() => {
                  onSelect(p.symbol);
                  onClose();
                }}
                className={`w-full min-h-[48px] px-4 py-2.5 flex items-center justify-between text-left transition-colors ${
                  active ? 'bg-sky-500/10 text-sky-300' : 'hover:bg-slate-800/60 text-slate-200'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-semibold">{p.symbol}</span>
                  <span className="text-xs text-slate-500">·</span>
                  <span className="text-xs text-slate-400">{p.baseAsset}/{p.quoteAsset}</span>
                </div>
                <span className="text-xs text-slate-400 uppercase font-mono">
                  {p.market}
                </span>
              </button>
            );
          })}

          {filtered.length === 0 && !showCustomAdd && (
            <div className="p-6 text-center text-sm text-slate-500">
              No matching Binance pairs found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
