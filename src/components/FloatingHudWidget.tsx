import React, { useEffect, useRef, useState } from 'react';
import { Activity, GripVertical, Maximize2, Minimize2 } from 'lucide-react';
import type { TradeRecord } from '../types/trading';

interface FloatingHudWidgetProps {
  pair: string;
  latestRsi: number | null;
  rsiOverbought: number;
  rsiOversold: number;
  openTrade: TradeRecord | null;
  livePnl: number;
  liveRoiPct: number;
  dragHint: string;
}

const STORAGE_KEY = 'heikinpulse_floating_hud_pos_v1';

export const FloatingHudWidget: React.FC<FloatingHudWidgetProps> = ({
  pair,
  latestRsi,
  rsiOverbought,
  rsiOversold,
  openTrade,
  livePnl,
  liveRoiPct,
  dragHint
}) => {
  const widgetRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);

  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    if (typeof window === 'undefined') return { x: 16, y: 80 };
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved) as { x: number; y: number };
        if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) {
          return {
            x: Math.max(8, Math.min(window.innerWidth - 150, parsed.x)),
            y: Math.max(56, Math.min(window.innerHeight - 120, parsed.y))
          };
        }
      }
    } catch {
      // Ignore storage error
    }
    return {
      x: Math.max(12, window.innerWidth - 172),
      y: 66
    };
  });

  const dragState = useRef<{
    active: boolean;
    moved: boolean;
    startPointerX: number;
    startPointerY: number;
    startX: number;
    startY: number;
  }>({
    active: false,
    moved: false,
    startPointerX: 0,
    startPointerY: 0,
    startX: 0,
    startY: 0
  });

  // Clamp position inside viewport when window resizes or widget expands
  useEffect(() => {
    const clamp = () => {
      const w = widgetRef.current?.offsetWidth || 156;
      const h = widgetRef.current?.offsetHeight || 48;
      setPos((prev) => ({
        x: Math.max(8, Math.min(window.innerWidth - w - 8, prev.x)),
        y: Math.max(8, Math.min(window.innerHeight - h - 8, prev.y))
      }));
    };
    clamp();
    window.addEventListener('resize', clamp);
    return () => window.removeEventListener('resize', clamp);
  }, [expanded]);

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Allow button click inside widget without starting drag immediately unless moved
    dragState.current = {
      active: true,
      moved: false,
      startPointerX: e.clientX,
      startPointerY: e.clientY,
      startX: pos.x,
      startY: pos.y
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.active) return;
    const dx = e.clientX - dragState.current.startPointerX;
    const dy = e.clientY - dragState.current.startPointerY;
    if (Math.hypot(dx, dy) > 4) {
      dragState.current.moved = true;
    }
    const w = widgetRef.current?.offsetWidth || 156;
    const h = widgetRef.current?.offsetHeight || 48;
    const nextX = Math.max(8, Math.min(window.innerWidth - w - 8, dragState.current.startX + dx));
    const nextY = Math.max(8, Math.min(window.innerHeight - h - 8, dragState.current.startY + dy));
    setPos({ x: nextX, y: nextY });
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragState.current.active) return;
    dragState.current.active = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(pos));
    } catch {
      // Ignore storage error
    }
  };

  const rsiColor =
    latestRsi === null
      ? 'text-slate-300'
      : latestRsi > rsiOverbought
        ? 'text-rose-400'
        : latestRsi < rsiOversold
          ? 'text-emerald-400'
          : 'text-sky-400';

  const rsiTag =
    latestRsi === null
      ? ''
      : latestRsi > rsiOverbought
        ? 'OB'
        : latestRsi < rsiOversold
          ? 'OS'
          : '';

  const pnlColor = !openTrade
    ? 'text-slate-400'
    : livePnl >= 0
      ? 'text-emerald-400'
      : 'text-rose-400';

  const pnlText = !openTrade
    ? '$0.00'
    : `${livePnl >= 0 ? '+' : '-'}$${Math.abs(livePnl).toFixed(2)}`;

  return (
    <div
      ref={widgetRef}
      style={{
        transform: `translate3d(${pos.x}px, ${pos.y}px, 0)`,
        left: 0,
        top: 0
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      title={dragHint}
      className="fixed z-50 touch-none select-none cursor-grab active:cursor-grabbing bg-slate-900/95 backdrop-blur-md border border-slate-700/90 rounded-2xl shadow-2xl text-xs"
    >
      {!expanded ? (
        <div className="flex items-center gap-2 px-2.5 py-2">
          <GripVertical className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <Activity className={`w-3.5 h-3.5 shrink-0 ${rsiColor}`} />
          <div className="flex items-center gap-1.5 font-mono whitespace-nowrap">
            <span className={`font-bold ${rsiColor}`}>
              {latestRsi !== null ? latestRsi.toFixed(1) : '--'}
            </span>
            {rsiTag && <span className={`text-[10px] font-semibold ${rsiColor}`}>{rsiTag}</span>}
            <span className="text-slate-600">·</span>
            {openTrade ? (
              <span className={`font-bold ${pnlColor}`}>
                {openTrade.side} {pnlText} ({livePnl >= 0 ? '+' : ''}{liveRoiPct.toFixed(1)}%)
              </span>
            ) : (
              <span className={`font-bold ${pnlColor}`}>{pnlText}</span>
            )}
          </div>
          <button
            type="button"
            aria-label="Expand RSI & PnL HUD"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={() => setExpanded(true)}
            className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        </div>
      ) : (
        <div className="w-52 p-3 space-y-2">
          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5">
            <div className="flex items-center gap-1 text-slate-300 font-mono font-semibold">
              <GripVertical className="w-3.5 h-3.5 text-slate-500" />
              <span>{openTrade ? `${openTrade.pair} (${openTrade.side})` : pair}</span>
            </div>
            <button
              type="button"
              aria-label="Minimize RSI & PnL HUD"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setExpanded(false)}
              className="p-1 rounded-md text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <Minimize2 className="w-3 h-3" />
            </button>
          </div>

          <div className="flex items-center justify-between font-mono">
            <span className="text-slate-400 text-[11px]">RSI</span>
            <span className={`font-bold ${rsiColor}`}>
              {latestRsi !== null ? latestRsi.toFixed(1) : '--'} {rsiTag}
            </span>
          </div>

          <div className="flex items-center justify-between font-mono">
            <span className="text-slate-400 text-[11px]">Live PnL</span>
            <span className={`font-bold ${pnlColor}`}>
              {pnlText}
              {openTrade ? ` (${livePnl >= 0 ? '+' : ''}${liveRoiPct.toFixed(1)}%)` : ''}
            </span>
          </div>

          {openTrade && (
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-slate-400">Entry</span>
              <span className="text-slate-200">{openTrade.entryPrice.toFixed(4)}</span>
            </div>
          )}

          {openTrade && openTrade.stopLossPrice && openTrade.stopLossPrice > 0 ? (
            <div className="flex items-center justify-between font-mono text-[11px]">
              <span className="text-amber-400">SL Wick</span>
              <span className="text-amber-300">{openTrade.stopLossPrice.toFixed(4)}</span>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
};
