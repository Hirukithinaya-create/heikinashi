import React, { useEffect, useState } from 'react';
import { Check, ChevronDown, Cloud, Copy, KeyRound, Lock, Minus, Play, Plus, Square, RotateCcw } from 'lucide-react';
import type {
  BinanceCredentialsState,
  BoundaryMode,
  Language,
  MarginMode,
  Timeframe,
  TradeRecord,
  TradeSide
} from '../types/trading';
import { t } from '../lib/i18n';

const ALL_TIMEFRAMES: Timeframe[] = [
  '1m',
  '3m',
  '5m',
  '15m',
  '30m',
  '1h',
  '2h',
  '4h',
  '6h',
  '12h',
  '1d',
  '1w'
];

const QUICK_BOT_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

interface BotControlPanelProps {
  language: Language;
  pair: string;
  timeframe: Timeframe;
  leverage: number;
  marginUsdt: number;
  marginMode: MarginMode;
  boundaryMode: BoundaryMode;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  buyCloseRsiEnabled: boolean;
  buyCloseRsi: number;
  sellCloseRsiEnabled: boolean;
  sellCloseRsi: number;
  stopLossEnabled: boolean;
  botActive: boolean;
  armedSellRef: number;
  armedBuyRef: number;
  armedSellWick: number;
  armedBuyWick: number;
  slReentrySide: TradeSide | 'NONE';
  slReentryPrice: number;
  slReentryStopLoss?: number;
  paperBalanceUsdt: number;
  openTrade: TradeRecord | null;
  livePrice: number;
  livePnl: number;
  liveRoiPct: number;
  binanceCreds: BinanceCredentialsState;
  isSignedIn?: boolean;
  cloudWorkerStatus?: {
    registered: boolean;
    lastTickAt: number;
    lastAction: string;
    lastError: string | null;
  } | null;
  cloudWorkerToken?: string | null;
  onUpdateSettings: (patch: {
    timeframe?: Timeframe;
    leverage?: number;
    marginUsdt?: number;
    marginMode?: MarginMode;
    boundaryMode?: BoundaryMode;
    rsiPeriod?: number;
    rsiOverbought?: number;
    rsiOversold?: number;
    buyCloseRsiEnabled?: boolean;
    buyCloseRsi?: number;
    sellCloseRsiEnabled?: boolean;
    sellCloseRsi?: number;
    stopLossEnabled?: boolean;
  }) => void;
  onSetBotMode: (active: boolean) => void;
  onManualTrade: (side: TradeSide) => void;
  onClosePosition: () => void;
  onRunBacktest: () => void;
  onOpenApiModal: () => void;
  onOpenPairModal: () => void;
}

function fmtPrice(val: number): string {
  if (!val) return '--';
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

export const BotControlPanel: React.FC<BotControlPanelProps> = ({
  language,
  pair,
  timeframe,
  leverage,
  marginUsdt,
  marginMode,
  boundaryMode,
  rsiPeriod,
  rsiOverbought,
  rsiOversold,
  buyCloseRsiEnabled,
  buyCloseRsi,
  sellCloseRsiEnabled,
  sellCloseRsi,
  stopLossEnabled,
  botActive,
  armedSellRef,
  armedBuyRef,
  armedSellWick,
  armedBuyWick,
  slReentrySide,
  slReentryPrice,
  slReentryStopLoss = 0,
  paperBalanceUsdt,
  openTrade,
  livePrice,
  livePnl,
  liveRoiPct,
  binanceCreds,
  isSignedIn = false,
  cloudWorkerStatus = null,
  cloudWorkerToken = null,
  onUpdateSettings,
  onSetBotMode,
  onManualTrade,
  onClosePosition,
  onRunBacktest,
  onOpenApiModal,
  onOpenPairModal
}) => {
  const [copiedKeepAlive, setCopiedKeepAlive] = useState(false);
  const copy = t(language);
  const notional = marginUsdt * leverage;
  const isBuyOpen = openTrade?.side === 'BUY';
  const isSellOpen = openTrade?.side === 'SELL';
  const pnlText = `${livePnl >= 0 ? '+' : '-'}$${Math.abs(livePnl).toFixed(2)}`;

  const [periodDraft, setPeriodDraft] = useState(String(rsiPeriod));
  const [obDraft, setObDraft] = useState(String(rsiOverbought));
  const [osDraft, setOsDraft] = useState(String(rsiOversold));
  const [buyCloseDraft, setBuyCloseDraft] = useState(String(buyCloseRsi));
  const [sellCloseDraft, setSellCloseDraft] = useState(String(sellCloseRsi));

  useEffect(() => {
    setPeriodDraft(String(rsiPeriod));
  }, [rsiPeriod]);

  useEffect(() => {
    setObDraft(String(rsiOverbought));
  }, [rsiOverbought]);

  useEffect(() => {
    setOsDraft(String(rsiOversold));
  }, [rsiOversold]);

  useEffect(() => {
    setBuyCloseDraft(String(buyCloseRsi));
  }, [buyCloseRsi]);

  useEffect(() => {
    setSellCloseDraft(String(sellCloseRsi));
  }, [sellCloseRsi]);

  const commitPeriod = (raw: string) => {
    const num = Math.round(Number(raw));
    if (!Number.isFinite(num) || raw.trim() === '') {
      setPeriodDraft(String(rsiPeriod));
      return;
    }
    const clamped = Math.max(2, Math.min(50, num));
    setPeriodDraft(String(clamped));
    if (clamped !== rsiPeriod) onUpdateSettings({ rsiPeriod: clamped });
  };

  const commitOb = (raw: string) => {
    const num = Math.round(Number(raw));
    if (!Number.isFinite(num) || raw.trim() === '') {
      setObDraft(String(rsiOverbought));
      return;
    }
    const minOb = Math.max(50, rsiOversold + 1);
    const clamped = Math.max(minOb, Math.min(99, num));
    setObDraft(String(clamped));
    if (clamped !== rsiOverbought) onUpdateSettings({ rsiOverbought: clamped });
  };

  const commitOs = (raw: string) => {
    const num = Math.round(Number(raw));
    if (!Number.isFinite(num) || raw.trim() === '') {
      setOsDraft(String(rsiOversold));
      return;
    }
    const maxOs = Math.min(50, rsiOverbought - 1);
    const clamped = Math.max(1, Math.min(maxOs, num));
    setOsDraft(String(clamped));
    if (clamped !== rsiOversold) onUpdateSettings({ rsiOversold: clamped });
  };

  const commitBuyClose = (raw: string) => {
    const num = Math.round(Number(raw));
    if (!Number.isFinite(num) || raw.trim() === '') {
      setBuyCloseDraft(String(buyCloseRsi));
      return;
    }
    const clamped = Math.max(1, Math.min(99, num));
    setBuyCloseDraft(String(clamped));
    if (clamped !== buyCloseRsi) onUpdateSettings({ buyCloseRsi: clamped });
  };

  const commitSellClose = (raw: string) => {
    const num = Math.round(Number(raw));
    if (!Number.isFinite(num) || raw.trim() === '') {
      setSellCloseDraft(String(sellCloseRsi));
      return;
    }
    const clamped = Math.max(1, Math.min(99, num));
    setSellCloseDraft(String(clamped));
    if (clamped !== sellCloseRsi) onUpdateSettings({ sellCloseRsi: clamped });
  };

  const stepOb = (delta: number) => {
    const minOb = Math.max(50, rsiOversold + 1);
    const next = Math.max(minOb, Math.min(99, rsiOverbought + delta));
    if (next !== rsiOverbought) onUpdateSettings({ rsiOverbought: next });
  };

  const stepOs = (delta: number) => {
    const maxOs = Math.min(50, rsiOverbought - 1);
    const next = Math.max(1, Math.min(maxOs, rsiOversold + delta));
    if (next !== rsiOversold) onUpdateSettings({ rsiOversold: next });
  };

  const stepBuyClose = (delta: number) => {
    const next = Math.max(1, Math.min(99, buyCloseRsi + delta));
    if (next !== buyCloseRsi) onUpdateSettings({ buyCloseRsi: next });
  };

  const stepSellClose = (delta: number) => {
    const next = Math.max(1, Math.min(99, sellCloseRsi + delta));
    if (next !== sellCloseRsi) onUpdateSettings({ sellCloseRsi: next });
  };

  return (
    <div className="space-y-4">
      {/* Master Trading Mode & Execution Card */}
      <div className="bg-slate-900/75 border border-slate-800 rounded-xl p-4 space-y-4">
        <div className="flex items-center justify-between gap-2">
          <div>
            <div className="text-sm font-semibold text-slate-100">{copy.strategyTitle}</div>
            <div className="text-xs text-slate-400 font-mono mt-0.5">
              {pair} · {timeframe} · {leverage}x {marginMode}
            </div>
          </div>
          <span
            className={`text-xs font-mono font-semibold whitespace-nowrap ${
              botActive ? 'text-emerald-400' : 'text-amber-400'
            }`}
          >
            {botActive ? copy.botStatusRunning : copy.botStatusPaused}
          </span>
        </div>

        {/* Mode Switch: Manual Trade (Bot OFF) vs Auto-Trade Bot (ON) */}
        <div className="grid grid-cols-2 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-xl">
          <button
            type="button"
            onClick={() => onSetBotMode(false)}
            className={`min-h-[40px] px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
              !botActive
                ? 'bg-amber-500/20 border border-amber-500/40 text-amber-300'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            <Square className="w-3.5 h-3.5 fill-current shrink-0" />
            <span className="truncate">{copy.modeManual}</span>
          </button>
          <button
            type="button"
            onClick={() => onSetBotMode(true)}
            className={`min-h-[40px] px-2 py-1.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
              botActive
                ? 'bg-emerald-600 text-white border border-emerald-500'
                : 'text-slate-400 hover:text-slate-200 border border-transparent'
            }`}
          >
            <Play className="w-3.5 h-3.5 fill-current shrink-0" />
            <span className="truncate">{copy.modeAuto}</span>
          </button>
        </div>

        {/* Same-Button Manual Open & Close Controls */}
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => (isBuyOpen ? onClosePosition() : onManualTrade('BUY'))}
              className={`min-h-[48px] px-3 py-2 rounded-xl text-xs font-bold flex flex-col items-center justify-center gap-0.5 border transition-colors ${
                isBuyOpen
                  ? 'bg-emerald-600 hover:bg-emerald-500 border-emerald-400 text-white shadow-lg shadow-emerald-950/50'
                  : 'bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/40 text-emerald-300'
              }`}
            >
              <span>{isBuyOpen ? copy.closeBuyBtn : copy.manualBuy}</span>
              {isBuyOpen && (
                <span className="font-mono text-[11px] opacity-95">{pnlText}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => (isSellOpen ? onClosePosition() : onManualTrade('SELL'))}
              className={`min-h-[48px] px-3 py-2 rounded-xl text-xs font-bold flex flex-col items-center justify-center gap-0.5 border transition-colors ${
                isSellOpen
                  ? 'bg-rose-600 hover:bg-rose-500 border-rose-400 text-white shadow-lg shadow-rose-950/50'
                  : 'bg-rose-600/20 hover:bg-rose-600/30 border-rose-500/40 text-rose-300'
              }`}
            >
              <span>{isSellOpen ? copy.closeSellBtn : copy.manualSell}</span>
              {isSellOpen && (
                <span className="font-mono text-[11px] opacity-95">{pnlText}</span>
              )}
            </button>
          </div>
          {!botActive && (
            <div className="text-[11px] text-slate-400 leading-snug">
              {copy.manualTradeHint}
            </div>
          )}
        </div>

        {/* Armed Watch Telemetry */}
        <div className="pt-2 border-t border-slate-800/80 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-slate-400">{copy.armedSellLabel}</span>
            <span className={`font-mono font-semibold ${armedSellRef > 0 ? 'text-rose-400' : 'text-slate-500'}`}>
              {armedSellRef > 0
                ? `${fmtPrice(armedSellRef)}${armedSellWick > 0 ? ` (SL ${fmtPrice(armedSellWick)})` : ''}`
                : copy.watchingLabel}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-slate-400">{copy.armedBuyLabel}</span>
            <span className={`font-mono font-semibold ${armedBuyRef > 0 ? 'text-emerald-400' : 'text-slate-500'}`}>
              {armedBuyRef > 0
                ? `${fmtPrice(armedBuyRef)}${armedBuyWick > 0 ? ` (SL ${fmtPrice(armedBuyWick)})` : ''}`
                : copy.watchingLabel}
            </span>
          </div>
          {slReentrySide !== 'NONE' && (slReentryPrice > 0 || slReentryStopLoss > 0) && (
            <div className="space-y-1">
              {slReentryPrice > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-sky-400">{copy.slReentryWatchLabel}</span>
                  <span className="font-mono font-semibold text-sky-300">
                    {slReentrySide} {slReentrySide === 'SELL' ? '<' : '>'} {fmtPrice(slReentryPrice)}
                  </span>
                </div>
              )}
              {slReentryStopLoss > 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-amber-400">
                    {language === 'si' ? 'Stop සීමාව (↑BUY / ↓SELL)' : 'SL Cross (↑BUY / ↓SELL)'}
                  </span>
                  <span className="font-mono font-semibold text-amber-300">
                    {fmtPrice(slReentryStopLoss)}
                  </span>
                </div>
              )}
            </div>
          )}
          <div className="flex items-center justify-between">
            <span className="text-slate-400">{copy.paperBalance}</span>
            <span className="font-mono font-semibold text-slate-200">
              ${paperBalanceUsdt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        </div>

        {/* Owner-Isolated Binance API Key Status */}
        <div className="pt-2.5 border-t border-slate-800/80 flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-xs font-medium text-slate-200">{copy.binanceApiTitle}</div>
            <div className="text-[11px] font-mono truncate mt-0.5">
              {binanceCreds.hasKeys ? (
                <span className={binanceCreds.enabled ? 'text-emerald-400' : 'text-amber-400'}>
                  {binanceCreds.enabled
                    ? binanceCreds.testnet
                      ? copy.binanceApiConnectedTestnet
                      : copy.binanceApiConnectedLive
                    : copy.binanceApiPaused}{' '}
                  · {binanceCreds.keyPreview}
                </span>
              ) : (
                <span className="text-slate-500">{copy.binanceApiPaperOnly}</span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenApiModal}
            className="min-h-[36px] px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5 text-sky-400" />
            <span>{copy.binanceApiButton}</span>
          </button>
        </div>

        {/* 24/7 Server Worker Status */}
        <div className="pt-2.5 border-t border-slate-800/80 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-xs font-medium text-slate-200 flex items-center gap-1.5">
                <Cloud className={`w-3.5 h-3.5 ${isSignedIn && cloudWorkerStatus?.registered ? 'text-emerald-400' : 'text-amber-400'}`} />
                <span>{copy.cloud247Title}</span>
              </div>
              <div className="text-[11px] font-mono truncate mt-0.5">
                {!isSignedIn ? (
                  <span className="text-amber-400">{copy.cloud247Guest}</span>
                ) : cloudWorkerStatus?.registered ? (
                  <span className="text-emerald-400">
                    {copy.cloud247Active}
                    {cloudWorkerStatus.lastTickAt > 0
                      ? ` · ${new Date(cloudWorkerStatus.lastTickAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
                      : ''}
                  </span>
                ) : (
                  <span className="text-sky-400">{copy.cloud247Syncing}</span>
                )}
              </div>
              {isSignedIn && cloudWorkerStatus?.registered && cloudWorkerStatus.lastAction && (
                <div className="text-[10px] text-slate-400 truncate mt-0.5">{cloudWorkerStatus.lastAction}</div>
              )}
              {isSignedIn && cloudWorkerStatus?.lastError && (
                <div className="text-[10px] text-rose-400 truncate mt-0.5">{cloudWorkerStatus.lastError}</div>
              )}
            </div>
            {isSignedIn && (
              <button
                type="button"
                onClick={() => {
                  const keepAliveUrl = cloudWorkerToken
                    ? `${window.location.origin}/api/cron?w=${encodeURIComponent(cloudWorkerToken)}`
                    : `${window.location.origin}/api/health`;
                  navigator.clipboard?.writeText(keepAliveUrl).then(() => {
                    setCopiedKeepAlive(true);
                    setTimeout(() => setCopiedKeepAlive(false), 2000);
                  }).catch(() => {});
                }}
                className="min-h-[34px] px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-[11px] font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
                title={copy.cloud247CopyUrl}
              >
                {copiedKeepAlive ? (
                  <Check className="w-3 h-3 text-emerald-400" />
                ) : (
                  <Copy className="w-3 h-3 text-sky-400" />
                )}
                <span>{copiedKeepAlive ? copy.copied : 'Cron URL'}</span>
              </button>
            )}
          </div>
          {isSignedIn && (
            <div className="text-[10px] text-slate-400 leading-snug">{copy.cloud247Hint}</div>
          )}
        </div>
      </div>

      {/* Active Open Position */}
      {openTrade && (
        <div className="bg-slate-900/75 border border-slate-800 rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="text-xs text-slate-400">{copy.openPosition}</div>
            <div className="flex items-center gap-2 font-mono text-xs">
              <span className={openTrade.side === 'BUY' ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold'}>
                {openTrade.side}
              </span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-200">{openTrade.pair}</span>
              <span className="text-slate-500">·</span>
              <span className="text-slate-300">{openTrade.leverage}x</span>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className="text-slate-400">{copy.entryPrice}</div>
              <div className="font-mono text-sm font-semibold text-slate-100 mt-0.5">
                {fmtPrice(openTrade.entryPrice)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-slate-400">{copy.markPrice}</div>
              <div className="font-mono text-sm font-semibold text-slate-100 mt-0.5">
                {fmtPrice(livePrice)}
              </div>
            </div>
            <div>
              <div className="text-slate-400">{copy.margin}</div>
              <div className="font-mono text-sm text-slate-200 mt-0.5">
                ${openTrade.marginUsdt.toFixed(2)}
              </div>
            </div>
            <div className="text-right">
              <div className="text-slate-400">{copy.livePnl}</div>
              <div
                className={`font-mono text-sm font-bold mt-0.5 ${
                  livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)} ({livePnl >= 0 ? '+' : ''}
                {liveRoiPct.toFixed(1)}%)
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-xs">
            <span className="text-slate-400">{copy.openedTimeLabel}</span>
            <span className="font-mono text-slate-200">
              {new Date(openTrade.openedAtMs).toLocaleString()}
            </span>
          </div>

          {openTrade.stopLossPrice && openTrade.stopLossPrice > 0 ? (
            <div className="flex items-center justify-between pt-2 border-t border-slate-800/80 text-xs font-mono">
              <span className="text-amber-400">{copy.stopLossPriceLabel} (Wick)</span>
              <span className="text-amber-300 font-semibold">{fmtPrice(openTrade.stopLossPrice)}</span>
            </div>
          ) : null}

          <button
            type="button"
            onClick={onClosePosition}
            className="w-full min-h-[42px] px-3 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors"
          >
            {copy.closeManually}
          </button>
        </div>
      )}

      {/* Timeframe, Leverage & Margin Controls */}
      <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4 space-y-4">
        {botActive && (
          <div className="p-2.5 rounded-lg bg-amber-500/10 border border-amber-500/30 flex items-start gap-2 text-[11px] text-amber-200 leading-snug">
            <Lock className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
            <div>
              <div className="font-semibold text-amber-300">{copy.settingsLockedTitle}</div>
              <div className="text-amber-200/85 mt-0.5">{copy.settingsLockedHint}</div>
            </div>
          </div>
        )}

        <fieldset
          disabled={botActive}
          className={`space-y-4 transition-opacity ${botActive ? 'opacity-55 pointer-events-none select-none' : ''}`}
        >
        {/* Trading Pair Selector */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-400">{copy.pairLabel}</span>
            <span className="font-mono font-semibold text-sky-400">{pair}</span>
          </div>
          <button
            type="button"
            onClick={onOpenPairModal}
            className="w-full min-h-[42px] px-3 py-2 text-xs font-mono font-semibold bg-slate-950 border border-slate-800 hover:border-slate-700 rounded-lg text-slate-100 flex items-center justify-between transition-colors"
          >
            <span>{pair}</span>
            <ChevronDown className="w-4 h-4 text-slate-400" />
          </button>
        </div>

        {/* Timeframe Selector */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-400">{copy.timeframeLabel}</span>
            <span className="font-mono font-semibold text-sky-400">{timeframe}</span>
          </div>
          <div className="grid grid-cols-6 gap-1.5">
            {QUICK_BOT_TIMEFRAMES.map((tf) => (
              <button
                key={tf}
                type="button"
                onClick={() => onUpdateSettings({ timeframe: tf })}
                className={`min-h-[36px] text-xs font-mono rounded-md border transition-colors ${
                  timeframe === tf
                    ? 'border-sky-500 bg-sky-500/15 text-sky-300 font-semibold'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
          <select
            aria-label={copy.timeframeLabel}
            value={timeframe}
            onChange={(e) => onUpdateSettings({ timeframe: e.target.value as Timeframe })}
            className="w-full mt-2 min-h-[38px] px-3 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none focus:border-sky-500"
          >
            {ALL_TIMEFRAMES.map((tf) => (
              <option key={tf} value={tf}>
                {tf}
              </option>
            ))}
          </select>
        </div>

        {/* Margin Mode */}
        <div>
          <label className="block text-xs text-slate-400 mb-1.5">{copy.marginMode}</label>
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
            {(['ISOLATED', 'CROSSED'] as const).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => onUpdateSettings({ marginMode: m })}
                className={`min-h-[38px] text-xs font-medium rounded-md transition-colors ${
                  marginMode === m
                    ? 'bg-slate-800 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {m === 'ISOLATED' ? copy.isolated : copy.crossed}
              </button>
            ))}
          </div>
        </div>

        {/* Leverage */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-400">{copy.leverage}</span>
            <span className="font-mono font-semibold text-sky-400">{leverage}x</span>
          </div>
          <input
            type="range"
            min={1}
            max={125}
            value={leverage}
            onChange={(e) => onUpdateSettings({ leverage: Number(e.target.value) })}
            className="w-full accent-sky-500 cursor-pointer"
          />
          <div className="grid grid-cols-5 gap-1.5 mt-2">
            {[5, 10, 20, 50, 100].map((lv) => (
              <button
                key={lv}
                type="button"
                onClick={() => onUpdateSettings({ leverage: lv })}
                className={`min-h-[34px] text-xs font-mono rounded-md border transition-colors ${
                  leverage === lv
                    ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                }`}
              >
                {lv}x
              </button>
            ))}
          </div>
        </div>

        {/* Margin (USDT) */}
        <div>
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-400">{copy.margin}</span>
            <span className="font-mono text-slate-400">
              {copy.sizeUsdt}: ${notional.toLocaleString('en-US', { maximumFractionDigits: 0 })}
            </span>
          </div>
          <input
            type="number"
            min={1}
            max={1000000}
            value={marginUsdt}
            onChange={(e) =>
              onUpdateSettings({
                marginUsdt: Math.max(1, Math.min(1000000, Number(e.target.value) || 10))
              })
            }
            className="w-full min-h-[42px] px-3 py-2 text-sm font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
          />
          <div className="grid grid-cols-4 gap-1.5 mt-2">
            {[25, 100, 500, 1000].map((amt) => (
              <button
                key={amt}
                type="button"
                onClick={() => onUpdateSettings({ marginUsdt: amt })}
                className={`min-h-[34px] text-xs font-mono rounded-md border transition-colors ${
                  marginUsdt === amt
                    ? 'border-sky-500 bg-sky-500/15 text-sky-300'
                    : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                }`}
              >
                ${amt}
              </button>
            ))}
          </div>
        </div>

        {/* RSI, Boundary & Stop-Loss Rules */}
        <div className="pt-3 border-t border-slate-800/80 space-y-3">
          <div>
            <label className="block text-xs text-slate-400 mb-1.5">{copy.boundaryMode}</label>
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-950 border border-slate-800 rounded-lg">
              {(['wick', 'body'] as const).map((bm) => (
                <button
                  key={bm}
                  type="button"
                  onClick={() => onUpdateSettings({ boundaryMode: bm })}
                  className={`min-h-[36px] text-[11px] font-medium rounded-md px-2 transition-colors ${
                    boundaryMode === bm
                      ? 'bg-slate-800 text-white'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {bm === 'wick' ? copy.wickMode : copy.bodyMode}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-slate-300 font-medium">{copy.rsiThresholdsTitle}</span>
              <span className="font-mono text-[11px] text-sky-400">
                OS &lt;{rsiOversold} · OB &gt;{rsiOverbought}
              </span>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">{copy.rsiPeriod}</label>
                <input
                  type="number"
                  inputMode="numeric"
                  min={2}
                  max={50}
                  value={periodDraft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setPeriodDraft(val);
                    const n = Math.round(Number(val));
                    if (val.trim() !== '' && Number.isFinite(n) && n >= 2 && n <= 50) {
                      onUpdateSettings({ rsiPeriod: n });
                    }
                  }}
                  onBlur={() => commitPeriod(periodDraft)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitPeriod(periodDraft);
                  }}
                  className="w-full min-h-[38px] px-2.5 text-xs font-mono bg-slate-950 border border-slate-800 focus:border-sky-500 rounded-lg text-slate-100 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] text-rose-300 mb-1">OB (&gt; {rsiOverbought})</label>
                <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    aria-label="Decrease OB"
                    onClick={() => stepOb(-1)}
                    className="min-h-[38px] px-1.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={50}
                    max={99}
                    value={obDraft}
                    onChange={(e) => {
                      const val = e.target.value;
                      setObDraft(val);
                      const n = Math.round(Number(val));
                      if (
                        val.trim() !== '' &&
                        Number.isFinite(n) &&
                        n >= Math.max(50, rsiOversold + 1) &&
                        n <= 99
                      ) {
                        onUpdateSettings({ rsiOverbought: n });
                      }
                    }}
                    onBlur={() => commitOb(obDraft)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitOb(obDraft);
                    }}
                    className="w-full min-h-[38px] px-1 text-center text-xs font-mono bg-transparent text-rose-300 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="Increase OB"
                    onClick={() => stepOb(1)}
                    className="min-h-[38px] px-1.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[11px] text-emerald-300 mb-1">OS (&lt; {rsiOversold})</label>
                <div className="flex items-center bg-slate-950 border border-slate-800 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    aria-label="Decrease OS"
                    onClick={() => stepOs(-1)}
                    className="min-h-[38px] px-1.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <Minus className="w-3 h-3" />
                  </button>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={50}
                    value={osDraft}
                    onChange={(e) => {
                      const val = e.target.value;
                      setOsDraft(val);
                      const n = Math.round(Number(val));
                      if (
                        val.trim() !== '' &&
                        Number.isFinite(n) &&
                        n >= 1 &&
                        n <= Math.min(50, rsiOverbought - 1)
                      ) {
                        onUpdateSettings({ rsiOversold: n });
                      }
                    }}
                    onBlur={() => commitOs(osDraft)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitOs(osDraft);
                    }}
                    className="w-full min-h-[38px] px-1 text-center text-xs font-mono bg-transparent text-emerald-300 focus:outline-none"
                  />
                  <button
                    type="button"
                    aria-label="Increase OS"
                    onClick={() => stepOs(1)}
                    className="min-h-[38px] px-1.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              </div>
            </div>

            {/* Quick RSI Presets (OB / OS) */}
            <div>
              <div className="text-[11px] text-slate-400 mb-1.5">{copy.rsiPresetsLabel}</div>
              <div className="grid grid-cols-4 gap-1.5">
                {[
                  { ob: 80, os: 22 },
                  { ob: 75, os: 25 },
                  { ob: 70, os: 30 },
                  { ob: 65, os: 35 }
                ].map((preset) => {
                  const active = rsiOverbought === preset.ob && rsiOversold === preset.os;
                  return (
                    <button
                      key={`${preset.ob}_${preset.os}`}
                      type="button"
                      onClick={() =>
                        onUpdateSettings({ rsiOverbought: preset.ob, rsiOversold: preset.os })
                      }
                      className={`min-h-[32px] text-[11px] font-mono rounded-md border transition-colors ${
                        active
                          ? 'border-sky-500 bg-sky-500/15 text-sky-300 font-semibold'
                          : 'border-slate-800 bg-slate-950 text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {preset.os}/{preset.ob}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 2 Optional Close-RSI Switches */}
          <div className="pt-3 border-t border-slate-800/80 space-y-2.5">
            <div className="text-xs font-medium text-slate-300">{copy.closeRsiSectionTitle}</div>

            {/* Switch 1: Close BUY at target RSI */}
            <div className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 space-y-2">
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-xs text-emerald-300 font-medium">{copy.buyCloseRsiLabel}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={buyCloseRsiEnabled}
                  onClick={() => onUpdateSettings({ buyCloseRsiEnabled: !buyCloseRsiEnabled })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    buyCloseRsiEnabled ? 'bg-emerald-500' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      buyCloseRsiEnabled ? 'translate-x-4.5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <div
                className={`flex items-center bg-slate-900 border border-slate-800 rounded-lg overflow-hidden transition-opacity ${
                  buyCloseRsiEnabled ? 'opacity-100' : 'opacity-45 pointer-events-none'
                }`}
              >
                <button
                  type="button"
                  aria-label="Decrease BUY Close RSI"
                  onClick={() => stepBuyClose(-1)}
                  className="min-h-[36px] px-2.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  disabled={!buyCloseRsiEnabled}
                  value={buyCloseDraft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setBuyCloseDraft(val);
                    const n = Math.round(Number(val));
                    if (val.trim() !== '' && Number.isFinite(n) && n >= 1 && n <= 99) {
                      onUpdateSettings({ buyCloseRsi: n });
                    }
                  }}
                  onBlur={() => commitBuyClose(buyCloseDraft)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitBuyClose(buyCloseDraft);
                  }}
                  className="w-full min-h-[36px] px-2 text-center text-xs font-mono bg-transparent text-cyan-300 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label="Increase BUY Close RSI"
                  onClick={() => stepBuyClose(1)}
                  className="min-h-[36px] px-2.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Switch 2: Close SELL at target RSI */}
            <div className="p-2.5 rounded-lg bg-slate-950/80 border border-slate-800 space-y-2">
              <label className="flex items-center justify-between gap-2 cursor-pointer">
                <span className="text-xs text-rose-300 font-medium">{copy.sellCloseRsiLabel}</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={sellCloseRsiEnabled}
                  onClick={() => onUpdateSettings({ sellCloseRsiEnabled: !sellCloseRsiEnabled })}
                  className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${
                    sellCloseRsiEnabled ? 'bg-rose-500' : 'bg-slate-700'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      sellCloseRsiEnabled ? 'translate-x-4.5' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <div
                className={`flex items-center bg-slate-900 border border-slate-800 rounded-lg overflow-hidden transition-opacity ${
                  sellCloseRsiEnabled ? 'opacity-100' : 'opacity-45 pointer-events-none'
                }`}
              >
                <button
                  type="button"
                  aria-label="Decrease SELL Close RSI"
                  onClick={() => stepSellClose(-1)}
                  className="min-h-[36px] px-2.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <Minus className="w-3.5 h-3.5" />
                </button>
                <input
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  disabled={!sellCloseRsiEnabled}
                  value={sellCloseDraft}
                  onChange={(e) => {
                    const val = e.target.value;
                    setSellCloseDraft(val);
                    const n = Math.round(Number(val));
                    if (val.trim() !== '' && Number.isFinite(n) && n >= 1 && n <= 99) {
                      onUpdateSettings({ sellCloseRsi: n });
                    }
                  }}
                  onBlur={() => commitSellClose(sellCloseDraft)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitSellClose(sellCloseDraft);
                  }}
                  className="w-full min-h-[36px] px-2 text-center text-xs font-mono bg-transparent text-cyan-300 focus:outline-none"
                />
                <button
                  type="button"
                  aria-label="Increase SELL Close RSI"
                  onClick={() => stepSellClose(1)}
                  className="min-h-[36px] px-2.5 text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            <div className="text-[11px] text-slate-400 leading-snug">{copy.closeRsiHint}</div>
          </div>

          <label className="flex items-center justify-between gap-2 pt-1 cursor-pointer">
            <span className="text-xs text-slate-300">
              {copy.stopLossEnabledLabel} (RSI {rsiOverbought} / {rsiOversold})
            </span>
            <input
              type="checkbox"
              checked={stopLossEnabled}
              onChange={(e) => onUpdateSettings({ stopLossEnabled: e.target.checked })}
              className="w-4 h-4 accent-amber-500 rounded"
            />
          </label>
        </div>
        </fieldset>

        {/* Backtest Signal Preview */}
        <div className="pt-3 border-t border-slate-800/80">
          <button
            type="button"
            onClick={onRunBacktest}
            className="w-full min-h-[40px] px-3 py-2 rounded-lg text-xs font-medium bg-slate-800/70 hover:bg-slate-800 text-slate-300 flex items-center justify-center gap-1.5 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>{copy.runBacktest}</span>
          </button>
        </div>
      </div>

      {/* Strategy Rule Reference (Dynamic to chosen RSI levels) */}
      <div className="bg-slate-900/40 border border-slate-800/80 rounded-xl p-4 space-y-2.5 text-xs text-slate-400 leading-relaxed">
        <div>
          <span className="font-semibold text-rose-400">SELL (&gt; {rsiOverbought}): </span>
          {language === 'si'
            ? `කොළ HA candle එක RSI ${rsiOverbought} පසුකර ගිය පසු එහි පතුල සලකුණු වේ. රතු HA candle body එකක් එම පතුලට පහළින් close වූ විට Buy close කර Sell අරඹයි.`
            : `Green HA candle passes RSI > ${rsiOverbought} -> Watch its bottom. When a Red HA body closes below that bottom, close Buy & open Sell.`}
        </div>
        <div>
          <span className="font-semibold text-emerald-400">BUY (&lt; {rsiOversold}): </span>
          {language === 'si'
            ? `රතු HA candle එක RSI ${rsiOversold} පසුකර ගිය පසු එහි ඉහළ සලකුණු වේ. කොළ HA candle body එකක් එම ඉහළට උඩින් close වූ විට Sell close කර Buy අරඹයි.`
            : `Red HA candle passes RSI < ${rsiOversold} -> Watch its top. When a Green HA body closes above that top, close Sell & open Buy.`}
        </div>
        <div>
          <span className="font-semibold text-amber-400">SL &amp; Re-Entry: </span>
          {language === 'si'
            ? `Wick Stop-Loss: RSI ${rsiOverbought}/${rsiOversold} wick සීමාව පසුකළහොත් Stop වේ. Stop වූ පසු HA Body එකක් පෙර Entry price හෝ Stop සීමාව (ඉහළට BUY / පහළට SELL) පසුකර close වුවහොත් එම දිශාවට trade open වේ.`
            : `Wick Stop-Loss closes on wick breach. Afterward, if a Heikin Ashi body closes across the previous entry OR crosses the Stop level again (up -> BUY, down -> SELL), a trade opens in that direction.`}
        </div>
      </div>
    </div>
  );
};
