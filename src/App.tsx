import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { signInWithPopup, signOut, onAuthStateChanged, type User } from 'firebase/auth';
import {
  Activity,
  BarChart3,
  ChevronDown,
  Globe,
  History,
  KeyRound,
  Lock,
  LogIn,
  LogOut,
  QrCode,
  Radar,
  SlidersHorizontal
} from 'lucide-react';
import { auth, googleProvider, testFirestoreConnection } from './lib/firebase';
import { decryptForUser } from './lib/cryptoVault';
import {
  closeExistingTrade,
  createOpenTrade,
  deleteUserBinanceCredentials,
  ensureUserProfile,
  recordSignal,
  saveUserBinanceCredentials,
  subscribeUserBinanceCredentials,
  subscribeUserProfile,
  subscribeUserSignals,
  subscribeUserTrades,
  updateUserConfig
} from './lib/firestoreService';
import { t } from './lib/i18n';
import {
  calculateUnrealizedPnl,
  computeHeikinAshiAndRsi,
  evaluateClosedCandle,
  scanHistoricalSignals,
  type StrategyState
} from './lib/strategy';
import type {
  BinanceCredentialsState,
  BoundaryMode,
  ChartSignalMarker,
  Language,
  MarginMode,
  PairInfo,
  RawCandle,
  SignalRecord,
  TickerInfo,
  Timeframe,
  TradeRecord,
  TradeSide,
  UserBotProfile
} from './types/trading';
import { HeikinAshiChart } from './components/HeikinAshiChart';
import { PairSelectorModal } from './components/PairSelectorModal';
import { BotControlPanel } from './components/BotControlPanel';
import { PnlAnalyticsView } from './components/PnlAnalyticsView';
import { HistoryViews } from './components/HistoryViews';
import { ShareAppModal } from './components/ShareAppModal';
import { FloatingHudWidget } from './components/FloatingHudWidget';
import { RsiScannerView } from './components/RsiScannerView';
import { BinanceApiModal } from './components/BinanceApiModal';

type DesktopTab = 'terminal' | 'scanner' | 'pnl' | 'trades' | 'signals';
type MobileTab = 'chart' | 'scanner' | 'bot' | 'pnl' | 'logs';

const TIMEFRAMES: Timeframe[] = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w'];
const QUICK_TIMEFRAMES: Timeframe[] = ['1m', '5m', '15m', '1h', '4h', '1d'];

function fmtPrice(val: number): string {
  if (!val || !Number.isFinite(val)) return '--';
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

function timeframeToMs(tf: Timeframe): number {
  const map: Record<Timeframe, number> = {
    '1m': 60_000,
    '3m': 180_000,
    '5m': 300_000,
    '15m': 900_000,
    '30m': 1_800_000,
    '1h': 3_600_000,
    '2h': 7_200_000,
    '4h': 14_400_000,
    '6h': 21_600_000,
    '12h': 43_200_000,
    '1d': 86_400_000,
    '1w': 604_800_000
  };
  return map[tf] ?? 900_000;
}

export default function App() {
  // Auth & Firestore profile state
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [profile, setProfile] = useState<UserBotProfile | null>(null);
  const [trades, setTrades] = useState<TradeRecord[]>([]);
  const [signals, setSignals] = useState<SignalRecord[]>([]);

  // Local guest / optimistic config state (mirrors Firestore when signed in)
  const [language, setLanguage] = useState<Language>('en');
  const [pair, setPair] = useState<string>('BTCUSDT');
  const [timeframe, setTimeframe] = useState<Timeframe>('15m');
  const [leverage, setLeverage] = useState<number>(20);
  const [marginUsdt, setMarginUsdt] = useState<number>(100);
  const [marginMode, setMarginMode] = useState<MarginMode>('ISOLATED');
  const [boundaryMode, setBoundaryMode] = useState<BoundaryMode>('wick');
  const [rsiPeriod, setRsiPeriod] = useState<number>(14);
  const [rsiOverbought, setRsiOverbought] = useState<number>(80);
  const [rsiOversold, setRsiOversold] = useState<number>(22);
  const [buyCloseRsiEnabled, setBuyCloseRsiEnabled] = useState<boolean>(false);
  const [buyCloseRsi, setBuyCloseRsi] = useState<number>(70);
  const [sellCloseRsiEnabled, setSellCloseRsiEnabled] = useState<boolean>(false);
  const [sellCloseRsi, setSellCloseRsi] = useState<number>(30);
  const [botActive, setBotActive] = useState<boolean>(false);
  const [stopLossEnabled, setStopLossEnabled] = useState<boolean>(true);
  const [paperBalanceUsdt, setPaperBalanceUsdt] = useState<number>(10000);
  const [armedSellRef, setArmedSellRef] = useState<number>(0);
  const [armedBuyRef, setArmedBuyRef] = useState<number>(0);
  const [armedSellWick, setArmedSellWick] = useState<number>(0);
  const [armedBuyWick, setArmedBuyWick] = useState<number>(0);
  const [armedSellCandleTime, setArmedSellCandleTime] = useState<number>(0);
  const [armedBuyCandleTime, setArmedBuyCandleTime] = useState<number>(0);
  const [slReentrySide, setSlReentrySide] = useState<TradeSide | 'NONE'>('NONE');
  const [slReentryPrice, setSlReentryPrice] = useState<number>(0);
  const [slReentryStopLoss, setSlReentryStopLoss] = useState<number>(0);
  const [lastEvaluatedTime, setLastEvaluatedTime] = useState<number>(0);

  // Market data state
  const [pairs, setPairs] = useState<PairInfo[]>([]);
  const [rawCandles, setRawCandles] = useState<RawCandle[]>([]);
  const [candlesSeriesKey, setCandlesSeriesKey] = useState<string>('');
  const [pairAllTfRsi, setPairAllTfRsi] = useState<
    Array<{ interval: Timeframe; liveRsi: number; closedRsi: number; haColor: 'GREEN' | 'RED' }>
  >([]);
  const [ticker, setTicker] = useState<TickerInfo | null>(null);
  const [livePrices, setLivePrices] = useState<Record<string, number>>({});
  const [dataSource, setDataSource] = useState<string>('binance-futures');
  const [previewBacktest, setPreviewBacktest] = useState<boolean>(false);

  // Navigation & UI state
  const [desktopTab, setDesktopTab] = useState<DesktopTab>('terminal');
  const [mobileTab, setMobileTab] = useState<MobileTab>('chart');
  const [mobileLogMode, setMobileLogMode] = useState<'trades' | 'signals'>('trades');
  const [pairModalOpen, setPairModalOpen] = useState<boolean>(false);
  const [shareModalOpen, setShareModalOpen] = useState<boolean>(false);
  const [apiModalOpen, setApiModalOpen] = useState<boolean>(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [binanceCreds, setBinanceCreds] = useState<BinanceCredentialsState>({
    hasKeys: false,
    apiKey: '',
    apiSecret: '',
    keyPreview: '',
    testnet: true,
    enabled: false
  });
  const [serverWorkerStatus, setServerWorkerStatus] = useState<{
    registered: boolean;
    lastTickAt: number;
    lastAction: string;
    lastError: string | null;
  } | null>(null);
  const [serverWorkerToken, setServerWorkerToken] = useState<string | null>(null);

  const processingRef = useRef<boolean>(false);
  const slTriggeredCandleTimeRef = useRef<number>(0);
  const closedTradeIdsRef = useRef<Set<string>>(new Set());

  const copy = t(language);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
  }, []);

  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  const syncServerWorker = useCallback(async (targetUser: User | null) => {
    if (!targetUser || !targetUser.refreshToken) {
      setServerWorkerStatus(null);
      setServerWorkerToken(null);
      return;
    }
    try {
      const res = await fetch('/api/bot/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          uid: targetUser.uid,
          refreshToken: targetUser.refreshToken
        })
      });
      if (res.ok) {
        const data = (await res.json()) as {
          ok?: boolean;
          workerToken?: string;
          status?: {
            registered: boolean;
            lastTickAt: number;
            lastAction: string;
            lastError: string | null;
          };
        };
        if (data.status) {
          setServerWorkerStatus(data.status);
        }
        if (data.workerToken) {
          setServerWorkerToken(data.workerToken);
        }
      }
    } catch {
      // Non-blocking fallback: client watchers run automatically if server registration is unreachable
    }
  }, []);

  // Keep 24/7 server worker synced and poll its status every 20s while signed in
  useEffect(() => {
    if (!authReady || !user) {
      setServerWorkerStatus(null);
      setServerWorkerToken(null);
      return;
    }
    syncServerWorker(user);
    const statusTimer = setInterval(async () => {
      try {
        const res = await fetch(`/api/bot/status?uid=${encodeURIComponent(user.uid)}`);
        if (!res.ok) return;
        const st = (await res.json()) as {
          registered: boolean;
          lastTickAt: number;
          lastAction: string;
          lastError: string | null;
        };
        setServerWorkerStatus(st);
        if (!st.registered && user.refreshToken) {
          syncServerWorker(user);
        }
      } catch {
        // Ignore transient poll errors
      }
    }, 20_000);
    return () => clearInterval(statusTimer);
  }, [authReady, user, syncServerWorker]);

  // Boot Firestore connection check & Auth listener
  useEffect(() => {
    testFirestoreConnection();
    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      setAuthReady(true);
      if (currentUser) {
        try {
          await ensureUserProfile(currentUser);
        } catch (err) {
          console.error(err);
        }
      } else {
        setProfile(null);
        setTrades([]);
        setSignals([]);
        setServerWorkerStatus(null);
        setBinanceCreds({
          hasKeys: false,
          apiKey: '',
          apiSecret: '',
          keyPreview: '',
          testnet: true,
          enabled: false
        });
      }
    });
    return () => unsub();
  }, []);

  // Subscribe to user profile, trades, signals, and owner-isolated encrypted Binance credentials
  useEffect(() => {
    if (!authReady || !user) return;
    const unsubProfile = subscribeUserProfile(user.uid, (p) => {
      if (!p) return;
      setProfile(p);
      setLanguage(p.language);
      setPair(p.selectedPair);
      setTimeframe(p.timeframe);
      setLeverage(p.leverage);
      setMarginUsdt(p.marginUsdt);
      setMarginMode(p.marginMode);
      setBoundaryMode(p.boundaryMode);
      setRsiPeriod(p.rsiPeriod);
      setRsiOverbought(p.rsiOverbought);
      setRsiOversold(p.rsiOversold);
      setBuyCloseRsiEnabled(p.buyCloseRsiEnabled ?? false);
      setBuyCloseRsi(p.buyCloseRsi ?? 70);
      setSellCloseRsiEnabled(p.sellCloseRsiEnabled ?? false);
      setSellCloseRsi(p.sellCloseRsi ?? 30);
      setBotActive(p.botActive);
      setStopLossEnabled(p.stopLossEnabled ?? true);
      setPaperBalanceUsdt(p.paperBalanceUsdt);
      setArmedSellRef(p.armedSellRef);
      setArmedBuyRef(p.armedBuyRef);
      setArmedSellWick(p.armedSellWick ?? 0);
      setArmedBuyWick(p.armedBuyWick ?? 0);
      setArmedSellCandleTime(p.armedSellCandleTime);
      setArmedBuyCandleTime(p.armedBuyCandleTime);
      setSlReentrySide(p.slReentrySide ?? 'NONE');
      setSlReentryPrice(p.slReentryPrice ?? 0);
      setSlReentryStopLoss(p.slReentryStopLoss ?? 0);
      setLastEvaluatedTime(p.lastEvaluatedTime);
    });
    const unsubTrades = subscribeUserTrades(user.uid, setTrades);
    const unsubSignals = subscribeUserSignals(user.uid, setSignals);
    const unsubCreds = subscribeUserBinanceCredentials(user.uid, async (docData) => {
      if (!docData) {
        setBinanceCreds({
          hasKeys: false,
          apiKey: '',
          apiSecret: '',
          keyPreview: '',
          testnet: true,
          enabled: false
        });
        return;
      }
      try {
        const [decryptedKey, decryptedSecret] = await Promise.all([
          decryptForUser(user.uid, docData.encryptedKey),
          decryptForUser(user.uid, docData.encryptedSecret)
        ]);
        setBinanceCreds({
          hasKeys: true,
          apiKey: decryptedKey,
          apiSecret: decryptedSecret,
          keyPreview: docData.keyPreview,
          testnet: docData.testnet,
          enabled: docData.enabled
        });
      } catch (err) {
        console.error('Credential decryption failed:', err);
      }
    });
    return () => {
      unsubProfile();
      unsubTrades();
      unsubSignals();
      unsubCreds();
    };
  }, [authReady, user]);

  // Load Binance trading pairs once
  useEffect(() => {
    fetch('/api/binance/pairs')
      .then((r) => r.json())
      .then((data: { pairs?: PairInfo[] }) => {
        if (Array.isArray(data.pairs) && data.pairs.length > 0) {
          setPairs(data.pairs);
        }
      })
      .catch(() => {
        // Ignore transient network errors
      });
  }, []);

  // Fetch klines & ticker for active pair & timeframe, poll every 4 seconds
  const activeSeriesKey = `${pair}_${timeframe}`;
  const activeSeriesKeyRef = useRef<string>(activeSeriesKey);
  activeSeriesKeyRef.current = activeSeriesKey;

  const fetchMarketData = useCallback(async () => {
    const reqPair = pair;
    const reqTf = timeframe;
    const reqKey = `${reqPair}_${reqTf}`;
    try {
      const [klinesRes, tickerRes] = await Promise.all([
        fetch(`/api/binance/klines?symbol=${encodeURIComponent(reqPair)}&interval=${encodeURIComponent(reqTf)}&limit=500`),
        fetch(`/api/binance/ticker?symbol=${encodeURIComponent(reqPair)}`)
      ]);
      if (activeSeriesKeyRef.current !== reqKey) return;
      if (klinesRes.ok) {
        const kData = (await klinesRes.json()) as { candles: RawCandle[]; source: string };
        if (activeSeriesKeyRef.current !== reqKey) return;
        if (Array.isArray(kData.candles) && kData.candles.length > 0) {
          setRawCandles(kData.candles);
          setDataSource(kData.source);
          setCandlesSeriesKey(reqKey);
        }
      }
      if (tickerRes.ok) {
        const tData = (await tickerRes.json()) as TickerInfo;
        if (activeSeriesKeyRef.current !== reqKey) return;
        setTicker(tData);
        if (tData.lastPrice > 0) {
          setLivePrices((prev) => ({ ...prev, [reqPair]: tData.lastPrice }));
        }
      }
    } catch {
      // Keep last known candles on transient errors
    }
  }, [pair, timeframe]);

  useEffect(() => {
    fetchMarketData();
    const timer = setInterval(fetchMarketData, 4000);
    return () => clearInterval(timer);
  }, [fetchMarketData]);

  // Fetch all 1m -> 1d RSI values for the currently selected pair (every 15s)
  useEffect(() => {
    let cancelled = false;
    const reqPair = pair;
    const loadPairRsi = async () => {
      try {
        const res = await fetch(
          `/api/binance/pair-rsi?symbol=${encodeURIComponent(reqPair)}&rsiPeriod=${encodeURIComponent(String(rsiPeriod))}`
        );
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as {
          timeframes?: Array<{ interval: Timeframe; liveRsi: number; closedRsi: number; haColor: 'GREEN' | 'RED' }>;
        };
        if (!cancelled && Array.isArray(data.timeframes)) {
          setPairAllTfRsi(data.timeframes);
        }
      } catch {
        // Ignore transient network errors
      }
    };
    loadPairRsi();
    const timer = setInterval(loadPairRsi, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [pair, rsiPeriod]);

  // Active open trade for current user/pair (or overall open trade)
  const openTrade = useMemo(
    () => trades.find((tr) => tr.status === 'OPEN' && tr.pair === pair) || trades.find((tr) => tr.status === 'OPEN') || null,
    [trades, pair]
  );

  // Fast 1.5s ticker refresh + 1s Binance Futures WebSocket for real-time live PnL ticks
  useEffect(() => {
    let cancelled = false;
    const symbolsToTrack = Array.from(
      new Set([pair, ...trades.filter((tr) => tr.status === 'OPEN').map((tr) => tr.pair)])
    );

    const pollTickers = async () => {
      try {
        const results = await Promise.all(
          symbolsToTrack.map(async (sym) => {
            const r = await fetch(`/api/binance/ticker?symbol=${encodeURIComponent(sym)}`);
            if (!r.ok) return null;
            return (await r.json()) as TickerInfo;
          })
        );
        if (cancelled) return;
        const updates: Record<string, number> = {};
        for (const tData of results) {
          if (tData && tData.lastPrice > 0) {
            updates[tData.symbol] = tData.lastPrice;
            if (tData.symbol === pair) {
              setTicker(tData);
            }
          }
        }
        if (Object.keys(updates).length > 0) {
          setLivePrices((prev) => ({ ...prev, ...updates }));
        }
      } catch {
        // Ignore transient poll failure
      }
    };

    const fastTimer = setInterval(pollTickers, 1500);

    // Optional live Binance Futures WebSocket stream for 1-second mark/trade updates
    const streams = symbolsToTrack.map((s) => `${s.toLowerCase()}@markPrice@1s`).join('/');
    let ws: WebSocket | null = null;
    try {
      ws = new WebSocket(`wss://fstream.binance.com/stream?streams=${streams}`);
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data) as { data?: { s?: string; p?: string } };
          const sym = msg?.data?.s;
          const p = Number(msg?.data?.p);
          if (sym && Number.isFinite(p) && p > 0) {
            setLivePrices((prev) => ({ ...prev, [sym]: p }));
            if (sym === pair) {
              setTicker((prev) => (prev ? { ...prev, lastPrice: p } : prev));
              setRawCandles((prev) => {
                if (prev.length === 0) return prev;
                const copyArr = prev.slice();
                const last = copyArr[copyArr.length - 1];
                copyArr[copyArr.length - 1] = {
                  ...last,
                  close: p,
                  high: Math.max(last.high, p),
                  low: Math.min(last.low, p)
                };
                return copyArr;
              });
            }
          }
        } catch {
          // Ignore malformed WS message
        }
      };
    } catch {
      // Fallback to 1.5s REST poll
    }

    return () => {
      cancelled = true;
      clearInterval(fastTimer);
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        ws.close();
      }
    };
  }, [pair, trades]);

  // Compute Heikin Ashi & Wilder RSI
  const haCandles = useMemo(
    () => computeHeikinAshiAndRsi(rawCandles, rsiPeriod),
    [rawCandles, rsiPeriod]
  );

  // Historical scan for chart markers
  const historicalScan = useMemo(
    () =>
      scanHistoricalSignals(haCandles, {
        boundaryMode,
        rsiOverbought,
        rsiOversold,
        buyCloseRsiEnabled,
        buyCloseRsi,
        sellCloseRsiEnabled,
        sellCloseRsi,
        stopLossEnabled
      }),
    [
      haCandles,
      boundaryMode,
      rsiOverbought,
      rsiOversold,
      buyCloseRsiEnabled,
      buyCloseRsi,
      sellCloseRsiEnabled,
      sellCloseRsi,
      stopLossEnabled
    ]
  );

  const chartMarkers: ChartSignalMarker[] = useMemo(() => {
    const baseMarkers = previewBacktest ? historicalScan.markers : [];
    const liveMarkers: ChartSignalMarker[] = signals
      .filter((s) => s.pair === pair && s.timeframe === timeframe)
      .map((s) => ({
        candleTimeMs: s.candleTimeMs,
        type: s.signalType,
        price: s.price,
        haOpen: s.haOpen,
        haHigh: s.haHigh,
        haLow: s.haLow,
        haClose: s.haClose,
        rsi: s.rsi,
        referenceLevel: s.referenceLevel,
        note: s.note
      }));

    const dedup = new Map<string, ChartSignalMarker>();
    for (const m of [...baseMarkers, ...liveMarkers]) {
      dedup.set(`${m.candleTimeMs}_${m.type}`, m);
    }
    return Array.from(dedup.values());
  }, [previewBacktest, historicalScan.markers, signals, pair, timeframe]);

  const livePrice =
    livePrices[pair] ||
    ticker?.lastPrice ||
    (haCandles.length > 0 ? haCandles[haCandles.length - 1].close : 0);
  const latestRsi = haCandles.length > 0 ? haCandles[haCandles.length - 1].rsi : null;

  const openTradeMarkPrice = useMemo(() => {
    if (!openTrade) return 0;
    return livePrices[openTrade.pair] || (openTrade.pair === pair ? livePrice : openTrade.entryPrice);
  }, [openTrade, livePrices, pair, livePrice]);

  const { pnl: livePnl, roiPct: liveRoiPct } = useMemo(() => {
    if (!openTrade || openTradeMarkPrice <= 0) return { pnl: 0, roiPct: 0 };
    return calculateUnrealizedPnl(
      openTrade.side,
      openTrade.entryPrice,
      openTradeMarkPrice,
      openTrade.quantity,
      openTrade.marginUsdt
    );
  }, [openTrade, openTradeMarkPrice]);

  // Helper to update config both locally and in Firestore
  const handleUpdateSettings = useCallback(
    async (
      patch: Partial<{
        selectedPair: string;
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
        language: Language;
      }>
    ) => {
      const isBotSettingChange =
        patch.selectedPair !== undefined ||
        patch.timeframe !== undefined ||
        patch.leverage !== undefined ||
        patch.marginUsdt !== undefined ||
        patch.marginMode !== undefined ||
        patch.boundaryMode !== undefined ||
        patch.rsiPeriod !== undefined ||
        patch.rsiOverbought !== undefined ||
        patch.rsiOversold !== undefined ||
        patch.buyCloseRsiEnabled !== undefined ||
        patch.buyCloseRsi !== undefined ||
        patch.sellCloseRsiEnabled !== undefined ||
        patch.sellCloseRsi !== undefined ||
        patch.stopLossEnabled !== undefined;

      if (botActive && isBotSettingChange) {
        showToast(copy.settingsLockedHint);
        return;
      }

      const pairOrTfChanged =
        (patch.selectedPair && patch.selectedPair !== pair) ||
        (patch.timeframe && patch.timeframe !== timeframe);

      const rsiChanged =
        (patch.rsiPeriod !== undefined && patch.rsiPeriod !== rsiPeriod) ||
        (patch.rsiOverbought !== undefined && patch.rsiOverbought !== rsiOverbought) ||
        (patch.rsiOversold !== undefined && patch.rsiOversold !== rsiOversold);

      if (patch.selectedPair !== undefined) setPair(patch.selectedPair);
      if (patch.timeframe !== undefined) setTimeframe(patch.timeframe);
      if (patch.leverage !== undefined) setLeverage(patch.leverage);
      if (patch.marginUsdt !== undefined) setMarginUsdt(patch.marginUsdt);
      if (patch.marginMode !== undefined) setMarginMode(patch.marginMode);
      if (patch.boundaryMode !== undefined) setBoundaryMode(patch.boundaryMode);
      if (patch.rsiPeriod !== undefined) setRsiPeriod(patch.rsiPeriod);
      if (patch.rsiOverbought !== undefined) setRsiOverbought(patch.rsiOverbought);
      if (patch.rsiOversold !== undefined) setRsiOversold(patch.rsiOversold);
      if (patch.buyCloseRsiEnabled !== undefined) setBuyCloseRsiEnabled(patch.buyCloseRsiEnabled);
      if (patch.buyCloseRsi !== undefined) setBuyCloseRsi(patch.buyCloseRsi);
      if (patch.sellCloseRsiEnabled !== undefined) setSellCloseRsiEnabled(patch.sellCloseRsiEnabled);
      if (patch.sellCloseRsi !== undefined) setSellCloseRsi(patch.sellCloseRsi);
      if (patch.stopLossEnabled !== undefined) setStopLossEnabled(patch.stopLossEnabled);
      if (patch.language !== undefined) setLanguage(patch.language);

      if (pairOrTfChanged) {
        setCandlesSeriesKey('');
        setRawCandles([]);
        slTriggeredCandleTimeRef.current = 0;
        setSlReentrySide('NONE');
        setSlReentryPrice(0);
        setSlReentryStopLoss(0);
      }

      if (pairOrTfChanged || rsiChanged) {
        setArmedSellRef(0);
        setArmedBuyRef(0);
        setArmedSellWick(0);
        setArmedBuyWick(0);
        setArmedSellCandleTime(0);
        setArmedBuyCandleTime(0);
        setLastEvaluatedTime(0);
      }

      if (rsiChanged) {
        const nextPeriod = patch.rsiPeriod ?? rsiPeriod;
        const nextOb = patch.rsiOverbought ?? rsiOverbought;
        const nextOs = patch.rsiOversold ?? rsiOversold;
        showToast(`${copy.rsiUpdatedToast}: RSI(${nextPeriod}) OS<${nextOs} / OB>${nextOb}`);
      }

      if (user) {
        try {
          if (pairOrTfChanged) {
            await updateUserConfig(user.uid, {
              ...patch,
              armedSellRef: 0,
              armedBuyRef: 0,
              armedSellWick: 0,
              armedBuyWick: 0,
              armedSellCandleTime: 0,
              armedBuyCandleTime: 0,
              slReentrySide: 'NONE',
              slReentryPrice: 0,
              slReentryStopLoss: 0,
              lastEvaluatedTime: 0
            });
          } else if (rsiChanged) {
            await updateUserConfig(user.uid, {
              ...patch,
              armedSellRef: 0,
              armedBuyRef: 0,
              armedSellWick: 0,
              armedBuyWick: 0,
              armedSellCandleTime: 0,
              armedBuyCandleTime: 0,
              lastEvaluatedTime: 0
            });
          } else {
            await updateUserConfig(user.uid, patch);
          }
          syncServerWorker(user);
        } catch (err) {
          console.error(err);
        }
      }
    },
    [
      botActive,
      pair,
      timeframe,
      rsiPeriod,
      rsiOverbought,
      rsiOversold,
      user,
      showToast,
      copy.settingsLockedHint,
      copy.rsiUpdatedToast
    ]
  );

  // Execute trade helper (works for both auto-bot and manual override, Firestore + Guest fallback)
  const executePositionChange = useCallback(
    async (
      newSide: TradeSide | null,
      execPrice: number,
      execRsi: number,
      candleTimeMs: number,
      closeReason: 'REVERSAL_SIGNAL' | 'MANUAL_CLOSE' | 'STOP_LOSS' | 'RSI_CLOSE',
      currentOpen: TradeRecord | null,
      currentBalance: number,
      stopLossPrice = 0
    ): Promise<{ createdTrade: TradeRecord | null; updatedBalance: number }> => {
      let nextBalance = currentBalance;

      if (currentOpen) {
        const { pnl, roiPct } = calculateUnrealizedPnl(
          currentOpen.side,
          currentOpen.entryPrice,
          execPrice,
          currentOpen.quantity,
          currentOpen.marginUsdt
        );
        nextBalance = Math.max(0, Number((nextBalance + pnl).toFixed(2)));

        if (binanceCreds.hasKeys && binanceCreds.enabled && binanceCreds.apiKey && binanceCreds.apiSecret) {
          const closeSide: TradeSide = currentOpen.side === 'BUY' ? 'SELL' : 'BUY';
          fetch('/api/binance/order', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              symbol: currentOpen.pair,
              side: closeSide,
              quantity: currentOpen.quantity,
              leverage: currentOpen.leverage,
              marginType: marginMode,
              reduceOnly: true,
              apiKey: binanceCreds.apiKey,
              apiSecret: binanceCreds.apiSecret,
              testnet: binanceCreds.testnet
            })
          })
            .then(async (res) => {
              const payload = (await res.json().catch(() => ({}))) as { order?: { msg?: string }; error?: string };
              if (!res.ok) {
                showToast(`Binance Close Error: ${payload.order?.msg || payload.error || res.statusText}`);
              }
            })
            .catch(() => {});
        }

        if (user) {
          await closeExistingTrade(user.uid, currentOpen.id, {
            exitPrice: execPrice,
            realizedPnl: pnl,
            realizedRoiPct: roiPct,
            exitRsi: execRsi,
            closeReason,
            closedAtMs: candleTimeMs
          });
        } else {
          setTrades((prev) =>
            prev.map((tr) =>
              tr.id === currentOpen.id
                ? {
                    ...tr,
                    status: 'CLOSED',
                    exitPrice: execPrice,
                    realizedPnl: Number(pnl.toFixed(4)),
                    realizedRoiPct: Number(roiPct.toFixed(2)),
                    exitRsi: execRsi,
                    closeReason,
                    closedAtMs: candleTimeMs
                  }
                : tr
            )
          );
        }
      }

      if (!newSide) {
        if (user) {
          await updateUserConfig(user.uid, { paperBalanceUsdt: nextBalance });
        } else {
          setPaperBalanceUsdt(nextBalance);
        }
        return { createdTrade: null, updatedBalance: nextBalance };
      }

      const quantity = Number(((marginUsdt * leverage) / execPrice).toFixed(6));

      // Notify backend proxy (executes live order using owner's Binance API keys if enabled, else paper)
      fetch('/api/binance/order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: pair,
          side: newSide,
          quantity,
          leverage,
          marginType: marginMode,
          ...(binanceCreds.hasKeys && binanceCreds.enabled && binanceCreds.apiKey && binanceCreds.apiSecret
            ? {
                apiKey: binanceCreds.apiKey,
                apiSecret: binanceCreds.apiSecret,
                testnet: binanceCreds.testnet
              }
            : {})
        })
      })
        .then(async (res) => {
          if (binanceCreds.hasKeys && binanceCreds.enabled && !res.ok) {
            const payload = (await res.json().catch(() => ({}))) as { order?: { msg?: string }; error?: string };
            showToast(`Binance Order Error: ${payload.order?.msg || payload.error || res.statusText}`);
          }
        })
        .catch(() => {
          // Non-blocking fallback to tracked execution
        });

      let createdTrade: TradeRecord;
      if (user) {
        const tradeId = await createOpenTrade(user.uid, {
          ownerId: user.uid,
          pair,
          timeframe,
          side: newSide,
          status: 'OPEN',
          entryPrice: execPrice,
          exitPrice: 0,
          stopLossPrice,
          leverage,
          marginUsdt,
          quantity,
          realizedPnl: 0,
          realizedRoiPct: 0,
          entryRsi: execRsi,
          exitRsi: 0,
          closeReason: 'NONE',
          openedAtMs: candleTimeMs,
          closedAtMs: 0
        });
        await updateUserConfig(user.uid, { paperBalanceUsdt: nextBalance });
        createdTrade = {
          id: tradeId,
          ownerId: user.uid,
          pair,
          timeframe,
          side: newSide,
          status: 'OPEN',
          entryPrice: execPrice,
          exitPrice: 0,
          stopLossPrice,
          leverage,
          marginUsdt,
          quantity,
          realizedPnl: 0,
          realizedRoiPct: 0,
          entryRsi: execRsi,
          exitRsi: 0,
          closeReason: 'NONE',
          openedAtMs: candleTimeMs,
          closedAtMs: 0
        };
      } else {
        createdTrade = {
          id: `guest_${candleTimeMs}_${newSide}`,
          ownerId: 'guest',
          pair,
          timeframe,
          side: newSide,
          status: 'OPEN',
          entryPrice: execPrice,
          exitPrice: 0,
          stopLossPrice,
          leverage,
          marginUsdt,
          quantity,
          realizedPnl: 0,
          realizedRoiPct: 0,
          entryRsi: execRsi,
          exitRsi: 0,
          closeReason: 'NONE',
          openedAtMs: candleTimeMs,
          closedAtMs: 0
        };
        setTrades((prev) => [createdTrade, ...prev]);
        setPaperBalanceUsdt(nextBalance);
      }

      return { createdTrade, updatedBalance: nextBalance };
    },
    [user, pair, timeframe, leverage, marginUsdt, marginMode, binanceCreds, showToast]
  );

  // Deterministic Closed-Candle Auto-Trade Engine (fallback when Guest OR Server 24/7 worker not yet registered)
  useEffect(() => {
    if (!botActive || haCandles.length < rsiPeriod + 5 || processingRef.current) return;
    // When signed in and 24/7 Server Engine is active, let the server execute authoritatively to prevent duplicate orders
    if (user && serverWorkerStatus?.registered) return;
    // Never execute on stale candles from a previous pair/timeframe or synthetic fallback candles
    if (candlesSeriesKey !== activeSeriesKey || dataSource === 'simulated') return;
    // Wait for profile to load if signed in
    if (user && !profile) return;

    const nowMs = Date.now();
    const closedCandles = haCandles
      .slice(0, Math.max(0, haCandles.length - 1))
      .filter((c) => c.closeTime <= nowMs && c.rsi !== null);
    const latestClosed = closedCandles[closedCandles.length - 1];
    if (!latestClosed) return;

    // On initial activation, initialize cursor at the latest closed candle
    if (lastEvaluatedTime === 0) {
      const initTime = latestClosed.openTime;
      setLastEvaluatedTime(initTime);
      if (user) {
        updateUserConfig(user.uid, { lastEvaluatedTime: initTime }).catch(console.error);
      }
      return;
    }

    const pendingCandles = closedCandles.filter((c) => c.openTime > lastEvaluatedTime);

    // Check live intra-candle Wick Stop-Loss if no pending closed candles yet
    const liveBar = haCandles[haCandles.length - 1];
    if (
      pendingCandles.length === 0 &&
      stopLossEnabled &&
      openTrade &&
      openTrade.pair === pair &&
      openTrade.timeframe === timeframe &&
      openTrade.stopLossPrice &&
      openTrade.stopLossPrice > 0 &&
      liveBar
    ) {
      const sl = openTrade.stopLossPrice;
      const breachedSell = openTrade.side === 'SELL' && (livePrice > sl || liveBar.high > sl);
      const breachedBuy = openTrade.side === 'BUY' && (livePrice < sl || liveBar.low < sl);
      if (breachedSell || breachedBuy) {
        processingRef.current = true;
        (async () => {
          try {
            const rsiVal = liveBar.rsi ?? latestRsi ?? 50;
            await executePositionChange(
              null,
              sl,
              rsiVal,
              Date.now(),
              'STOP_LOSS',
              openTrade,
              paperBalanceUsdt
            );
            const stoppedSide = openTrade.side;
            const stoppedEntry = openTrade.entryPrice;
            const stoppedSl = sl;
            slTriggeredCandleTimeRef.current = liveBar.openTime;
            setSlReentrySide(stoppedSide);
            setSlReentryPrice(stoppedEntry);
            setSlReentryStopLoss(stoppedSl);
            if (user) {
              await updateUserConfig(user.uid, {
                slReentrySide: stoppedSide,
                slReentryPrice: stoppedEntry,
                slReentryStopLoss: stoppedSl
              });
            }
            const note = `Live Stop-Loss triggered on ${openTrade.side} @ ${fmtPrice(sl)} (wick exceeded). Re-entry watch @ ${fmtPrice(stoppedEntry)} / SL Cross ${fmtPrice(stoppedSl)}`;
            if (user) {
              await recordSignal(user.uid, {
                ownerId: user.uid,
                pair,
                timeframe,
                signalType: 'STOP_LOSS',
                candleTimeMs: liveBar.openTime,
                price: sl,
                haOpen: liveBar.haOpen,
                haHigh: liveBar.haHigh,
                haLow: liveBar.haLow,
                haClose: liveBar.haClose,
                rsi: rsiVal,
                referenceLevel: sl,
                executed: true,
                note
              });
            }
            showToast(`STOP-LOSS ${openTrade.side} ${pair} @ ${fmtPrice(sl)}`);
          } finally {
            processingRef.current = false;
          }
        })();
        return;
      }
    }

    if (pendingCandles.length === 0) return;

    processingRef.current = true;
    (async () => {
      try {
        const firstPendingIdx = closedCandles.findIndex(
          (c) => c.openTime === pendingCandles[0].openTime
        );
        const initialPrevHaClose = firstPendingIdx > 0 ? closedCandles[firstPendingIdx - 1].haClose : 0;

        let state: StrategyState = {
          armedSellRef,
          armedBuyRef,
          armedSellWick,
          armedBuyWick,
          armedSellCandleTime,
          armedBuyCandleTime,
          openSide: openTrade && openTrade.pair === pair ? openTrade.side : null,
          openEntryPrice: openTrade && openTrade.pair === pair ? openTrade.entryPrice : 0,
          activeStopLoss: openTrade && openTrade.pair === pair ? (openTrade.stopLossPrice || 0) : 0,
          slReentrySide: slReentrySide === 'NONE' ? null : slReentrySide,
          slReentryPrice,
          slReentryStopLoss,
          lastHaClose: initialPrevHaClose
        };
        let activeOpen = openTrade && openTrade.pair === pair ? openTrade : null;
        let activeBalance = paperBalanceUsdt;
        let newestTime = lastEvaluatedTime;

        // If the tab slept across multiple historical bars, silently sync armed/indicator state up to the bar before latest,
        // and only evaluate live orders on the freshly closed candle so trades never replay at stale historical bars.
        const tfWindowMs = Math.max(180_000, timeframeToMs(timeframe) * 1.5);
        const latestPendingIdx = pendingCandles.length - 1;
        let pendingCatchupCloseReason: 'STOP_LOSS' | 'RSI_CLOSE' | 'REVERSAL_SIGNAL' | null = null;
        let pendingCatchupCloseRsi = 0;

        for (let idx = 0; idx < pendingCandles.length; idx++) {
          const candle = pendingCandles[idx];
          const isLiveSlBar =
            slTriggeredCandleTimeRef.current > 0 && candle.openTime === slTriggeredCandleTimeRef.current;
          const savedSlWatch = isLiveSlBar
            ? {
                slReentrySide: state.slReentrySide,
                slReentryPrice: state.slReentryPrice,
                slReentryStopLoss: state.slReentryStopLoss
              }
            : null;
          const evalInputState = isLiveSlBar ? { ...state, slReentrySide: null } : state;
          const { nextState, events } = evaluateClosedCandle(candle, evalInputState, {
            boundaryMode,
            rsiOverbought,
            rsiOversold,
            buyCloseRsiEnabled,
            buyCloseRsi,
            sellCloseRsiEnabled,
            sellCloseRsi,
            stopLossEnabled
          });
          if (savedSlWatch && nextState.openSide === null) {
            nextState.slReentrySide = savedSlWatch.slReentrySide;
            nextState.slReentryPrice = savedSlWatch.slReentryPrice;
            nextState.slReentryStopLoss = savedSlWatch.slReentryStopLoss;
          }
          if (candle.openTime > slTriggeredCandleTimeRef.current) {
            slTriggeredCandleTimeRef.current = 0;
          }
          state = nextState;
          newestTime = candle.openTime;

          const isLatestClosed = idx === latestPendingIdx;
          const isFreshClose = Date.now() - (candle.closeTime || candle.openTime) <= tfWindowMs;
          if (!isLatestClosed || !isFreshClose) {
            for (const ev of events) {
              if (activeOpen && !pendingCatchupCloseReason) {
                if (ev.type === 'STOP_LOSS') {
                  pendingCatchupCloseReason = 'STOP_LOSS';
                  pendingCatchupCloseRsi = ev.rsi;
                } else if (ev.type === 'RSI_CLOSE') {
                  pendingCatchupCloseReason = 'RSI_CLOSE';
                  pendingCatchupCloseRsi = ev.rsi;
                } else if ((ev.type === 'BUY' || ev.type === 'SELL') && ev.type !== activeOpen.side) {
                  pendingCatchupCloseReason = 'REVERSAL_SIGNAL';
                  pendingCatchupCloseRsi = ev.rsi;
                }
              }
            }
            continue;
          }

          if (activeOpen && pendingCatchupCloseReason) {
            const closeRes = await executePositionChange(
              null,
              livePrice || candle.close,
              pendingCatchupCloseRsi,
              Date.now(),
              pendingCatchupCloseReason,
              activeOpen,
              activeBalance
            );
            activeOpen = closeRes.createdTrade;
            activeBalance = closeRes.updatedBalance;
            pendingCatchupCloseReason = null;
          }

          for (const ev of events) {
            if (ev.type === 'STOP_LOSS' && activeOpen) {
              const res = await executePositionChange(
                null,
                ev.execPrice,
                ev.rsi,
                Date.now(),
                'STOP_LOSS',
                activeOpen,
                activeBalance
              );
              activeOpen = res.createdTrade;
              activeBalance = res.updatedBalance;
              showToast(`STOP-LOSS ${pair} @ ${fmtPrice(ev.execPrice)}`);
            }

            if (ev.type === 'RSI_CLOSE' && activeOpen) {
              const closedSide = activeOpen.side;
              const res = await executePositionChange(
                null,
                ev.execPrice,
                ev.rsi,
                Date.now(),
                'RSI_CLOSE',
                activeOpen,
                activeBalance
              );
              activeOpen = res.createdTrade;
              activeBalance = res.updatedBalance;
              showToast(`RSI CLOSE ${closedSide} ${pair} @ ${fmtPrice(ev.execPrice)} (RSI ${ev.rsi.toFixed(1)})`);
            }

            const isTradeEntry = ev.type === 'BUY' || ev.type === 'SELL';
            if (isTradeEntry) {
              const res = await executePositionChange(
                ev.type as TradeSide,
                ev.execPrice,
                ev.rsi,
                Date.now(),
                'REVERSAL_SIGNAL',
                activeOpen,
                activeBalance,
                ev.stopLossPrice || 0
              );
              activeOpen = res.createdTrade;
              activeBalance = res.updatedBalance;
              showToast(`${ev.type} ${pair} @ ${fmtPrice(ev.execPrice)} (${timeframe} RSI ${ev.rsi.toFixed(1)})`);
            }

            if (user) {
              await recordSignal(user.uid, {
                ownerId: user.uid,
                pair,
                timeframe,
                signalType: ev.type,
                candleTimeMs: candle.openTime,
                price: ev.execPrice,
                haOpen: candle.haOpen,
                haHigh: candle.haHigh,
                haLow: candle.haLow,
                haClose: candle.haClose,
                rsi: ev.rsi,
                referenceLevel: ev.referenceLevel,
                executed: isTradeEntry || ev.type === 'STOP_LOSS' || ev.type === 'RSI_CLOSE',
                note: ev.note
              });
            } else {
              const sigId = `gsig_${candle.openTime}_${ev.type}`;
              setSignals((prev) => {
                if (prev.some((s) => s.id === sigId)) return prev;
                return [
                  {
                    id: sigId,
                    ownerId: 'guest',
                    pair,
                    timeframe,
                    signalType: ev.type,
                    candleTimeMs: candle.openTime,
                    price: ev.execPrice,
                    haOpen: candle.haOpen,
                    haHigh: candle.haHigh,
                    haLow: candle.haLow,
                    haClose: candle.haClose,
                    rsi: ev.rsi,
                    referenceLevel: ev.referenceLevel,
                    executed: isTradeEntry || ev.type === 'STOP_LOSS' || ev.type === 'RSI_CLOSE',
                    note: ev.note
                  },
                  ...prev
                ];
              });
            }
          }
        }

        if (activeOpen && pendingCatchupCloseReason) {
          const closeRes = await executePositionChange(
            null,
            livePrice || activeOpen.entryPrice,
            pendingCatchupCloseRsi,
            Date.now(),
            pendingCatchupCloseReason,
            activeOpen,
            activeBalance
          );
          activeOpen = closeRes.createdTrade;
          activeBalance = closeRes.updatedBalance;
          showToast(`Catch-up closed ${pair} (${pendingCatchupCloseReason})`);
        }

        const nextReentrySide: TradeSide | 'NONE' = state.slReentrySide ?? 'NONE';
        setArmedSellRef(state.armedSellRef);
        setArmedBuyRef(state.armedBuyRef);
        setArmedSellWick(state.armedSellWick);
        setArmedBuyWick(state.armedBuyWick);
        setArmedSellCandleTime(state.armedSellCandleTime);
        setArmedBuyCandleTime(state.armedBuyCandleTime);
        setSlReentrySide(nextReentrySide);
        setSlReentryPrice(state.slReentryPrice);
        setSlReentryStopLoss(state.slReentryStopLoss);
        setLastEvaluatedTime(newestTime);

        if (user) {
          await updateUserConfig(user.uid, {
            lastEvaluatedTime: newestTime,
            armedSellRef: state.armedSellRef,
            armedBuyRef: state.armedBuyRef,
            armedSellWick: state.armedSellWick,
            armedBuyWick: state.armedBuyWick,
            armedSellCandleTime: state.armedSellCandleTime,
            armedBuyCandleTime: state.armedBuyCandleTime,
            slReentrySide: nextReentrySide,
            slReentryPrice: state.slReentryPrice,
            slReentryStopLoss: state.slReentryStopLoss,
            paperBalanceUsdt: activeBalance
          });
        }
      } catch (err) {
        console.error('Strategy evaluation error:', err);
      } finally {
        processingRef.current = false;
      }
    })();
  }, [
    botActive,
    haCandles,
    candlesSeriesKey,
    activeSeriesKey,
    dataSource,
    rsiPeriod,
    user,
    profile,
    lastEvaluatedTime,
    armedSellRef,
    armedBuyRef,
    armedSellWick,
    armedBuyWick,
    armedSellCandleTime,
    armedBuyCandleTime,
    slReentrySide,
    slReentryPrice,
    slReentryStopLoss,
    openTrade,
    pair,
    timeframe,
    paperBalanceUsdt,
    boundaryMode,
    rsiOverbought,
    rsiOversold,
    buyCloseRsiEnabled,
    buyCloseRsi,
    sellCloseRsiEnabled,
    sellCloseRsi,
    stopLossEnabled,
    livePrice,
    latestRsi,
    serverWorkerStatus?.registered,
    executePositionChange,
    showToast
  ]);

  // Manual Trade Close-RSI Watcher (fallback when Guest OR Server 24/7 worker not yet registered)
  useEffect(() => {
    if (botActive || !openTrade || openTrade.status !== 'OPEN' || processingRef.current) return;
    if (user && serverWorkerStatus?.registered) return;
    if (closedTradeIdsRef.current.has(openTrade.id)) return;
    if (openTrade.pair !== pair || openTrade.timeframe !== timeframe) return;
    if (candlesSeriesKey !== activeSeriesKey || dataSource === 'simulated') return;
    if (haCandles.length < rsiPeriod + 5) return;

    const exitMark = openTradeMarkPrice || livePrice;
    if (exitMark <= 0) return;

    const watchBuy = openTrade.side === 'BUY' && buyCloseRsiEnabled;
    const watchSell = openTrade.side === 'SELL' && sellCloseRsiEnabled;
    if (!watchBuy && !watchSell) return;

    const nowMs = Date.now();
    const liveBar = haCandles[haCandles.length - 1];
    const postEntryClosedCandles = haCandles
      .slice(0, Math.max(0, haCandles.length - 1))
      .filter((c) => c.closeTime <= nowMs && c.closeTime > openTrade.openedAtMs && c.rsi !== null);
    const latestPostEntryClosed = postEntryClosedCandles[postEntryClosedCandles.length - 1];

    const hitLiveBuy = watchBuy && latestRsi !== null && openTrade.entryRsi < buyCloseRsi && latestRsi >= buyCloseRsi;
    const hitClosedBuy =
      watchBuy &&
      latestPostEntryClosed?.rsi !== null &&
      latestPostEntryClosed?.rsi !== undefined &&
      latestPostEntryClosed.rsi >= buyCloseRsi;
    const hitLiveSell = watchSell && latestRsi !== null && openTrade.entryRsi > sellCloseRsi && latestRsi <= sellCloseRsi;
    const hitClosedSell =
      watchSell &&
      latestPostEntryClosed?.rsi !== null &&
      latestPostEntryClosed?.rsi !== undefined &&
      latestPostEntryClosed.rsi <= sellCloseRsi;

    if (!hitLiveBuy && !hitClosedBuy && !hitLiveSell && !hitClosedSell) return;

    const isLiveHit = hitLiveBuy || hitLiveSell;
    const exitRsiVal = isLiveHit ? (latestRsi as number) : (latestPostEntryClosed!.rsi as number);
    const triggerBar = isLiveHit ? liveBar : latestPostEntryClosed!;
    const targetTrade = openTrade;
    const targetThreshold = targetTrade.side === 'BUY' ? buyCloseRsi : sellCloseRsi;
    const note = `Manual ${targetTrade.side} closed at Close RSI ${exitRsiVal.toFixed(1)} (target ${targetTrade.side === 'BUY' ? '≥' : '≤'} ${targetThreshold})`;

    closedTradeIdsRef.current.add(targetTrade.id);
    processingRef.current = true;
    (async () => {
      try {
        await executePositionChange(
          null,
          exitMark,
          exitRsiVal,
          nowMs,
          'RSI_CLOSE',
          targetTrade,
          paperBalanceUsdt
        );
        if (user) {
          await recordSignal(user.uid, {
            ownerId: user.uid,
            pair,
            timeframe,
            signalType: 'RSI_CLOSE',
            candleTimeMs: triggerBar?.openTime ?? nowMs,
            price: exitMark,
            haOpen: triggerBar?.haOpen ?? exitMark,
            haHigh: triggerBar?.haHigh ?? exitMark,
            haLow: triggerBar?.haLow ?? exitMark,
            haClose: triggerBar?.haClose ?? exitMark,
            rsi: exitRsiVal,
            referenceLevel: targetThreshold,
            executed: true,
            note
          });
        } else {
          const sigId = `gsig_manual_rsiclose_${targetTrade.id}`;
          setSignals((prev) => {
            if (prev.some((s) => s.id === sigId)) return prev;
            return [
              {
                id: sigId,
                ownerId: 'guest',
                pair,
                timeframe,
                signalType: 'RSI_CLOSE',
                candleTimeMs: triggerBar?.openTime ?? nowMs,
                price: exitMark,
                haOpen: triggerBar?.haOpen ?? exitMark,
                haHigh: triggerBar?.haHigh ?? exitMark,
                haLow: triggerBar?.haLow ?? exitMark,
                haClose: triggerBar?.haClose ?? exitMark,
                rsi: exitRsiVal,
                referenceLevel: targetThreshold,
                executed: true,
                note
              },
              ...prev
            ];
          });
        }
        showToast(`RSI CLOSE ${targetTrade.side} ${pair} @ ${fmtPrice(exitMark)} (RSI ${exitRsiVal.toFixed(1)})`);
      } catch (err) {
        closedTradeIdsRef.current.delete(targetTrade.id);
        console.error('Manual Close-RSI execution error:', err);
      } finally {
        processingRef.current = false;
      }
    })();
  }, [
    botActive,
    openTrade,
    pair,
    timeframe,
    candlesSeriesKey,
    activeSeriesKey,
    dataSource,
    haCandles,
    rsiPeriod,
    openTradeMarkPrice,
    livePrice,
    latestRsi,
    buyCloseRsiEnabled,
    buyCloseRsi,
    sellCloseRsiEnabled,
    sellCloseRsi,
    paperBalanceUsdt,
    user,
    serverWorkerStatus?.registered,
    executePositionChange,
    showToast
  ]);

  const handleSetBotActive = async (nextActive: boolean) => {
    if (nextActive === botActive) return;
    const nowMs = Date.now();
    const closedCandles = haCandles
      .slice(0, Math.max(0, haCandles.length - 1))
      .filter((c) => c.closeTime <= nowMs && c.rsi !== null);
    const latestClosed = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : null;
    const latestClosedTime = latestClosed ? latestClosed.openTime : nowMs;

    // Only arm if the LATEST closed candle on this exact timeframe strictly satisfies RSI > OB or RSI < OS
    let seedSellRef = 0;
    let seedBuyRef = 0;
    let seedSellWick = 0;
    let seedBuyWick = 0;
    let seedSellTime = 0;
    let seedBuyTime = 0;

    if (nextActive && latestClosed && latestClosed.rsi !== null && candlesSeriesKey === activeSeriesKey) {
      if (latestClosed.isGreen && latestClosed.rsi > rsiOverbought) {
        seedSellRef = boundaryMode === 'wick' ? latestClosed.haLow : latestClosed.haOpen;
        seedSellWick = Math.max(latestClosed.high, latestClosed.haHigh);
        seedSellTime = latestClosed.openTime;
      } else if (latestClosed.isRed && latestClosed.rsi < rsiOversold) {
        seedBuyRef = boundaryMode === 'wick' ? latestClosed.haHigh : latestClosed.haOpen;
        seedBuyWick = Math.min(latestClosed.low, latestClosed.haLow);
        seedBuyTime = latestClosed.openTime;
      }
    }

    setBotActive(nextActive);
    if (nextActive) {
      setLastEvaluatedTime(latestClosedTime);
      setArmedSellRef(seedSellRef);
      setArmedBuyRef(seedBuyRef);
      setArmedSellWick(seedSellWick);
      setArmedBuyWick(seedBuyWick);
      setArmedSellCandleTime(seedSellTime);
      setArmedBuyCandleTime(seedBuyTime);
      showToast(`${copy.botStatusRunning}: ${pair} (${timeframe})`);
    } else {
      showToast(copy.modeManual);
    }

    if (user) {
      try {
        await updateUserConfig(user.uid, {
          botActive: nextActive,
          lastEvaluatedTime: nextActive ? latestClosedTime : lastEvaluatedTime,
          armedSellRef: seedSellRef,
          armedBuyRef: seedBuyRef,
          armedSellWick: seedSellWick,
          armedBuyWick: seedBuyWick,
          armedSellCandleTime: seedSellTime,
          armedBuyCandleTime: seedBuyTime
        });
        syncServerWorker(user);
      } catch (err) {
        console.error(err);
      }
    }
  };

  const handleClosePosition = async () => {
    const exitMark = openTradeMarkPrice || livePrice;
    if (!openTrade || exitMark <= 0) return;
    const rsiVal = latestRsi ?? 50;
    await executePositionChange(
      null,
      exitMark,
      rsiVal,
      Date.now(),
      'MANUAL_CLOSE',
      openTrade,
      paperBalanceUsdt
    );
    if (user) syncServerWorker(user);
    showToast(`Closed ${openTrade.side} ${openTrade.pair} @ ${fmtPrice(exitMark)}`);
  };

  const handleManualTrade = async (side: TradeSide) => {
    // Same-button toggle: clicking BUY while BUY is open (or SELL while SELL is open) closes that trade
    if (openTrade && openTrade.side === side) {
      await handleClosePosition();
      return;
    }

    if (livePrice <= 0) return;
    const rsiVal = latestRsi ?? 50;
    const wasBotActive = botActive;
    if (wasBotActive) {
      setBotActive(false);
    }
    setSlReentrySide('NONE');
    setSlReentryPrice(0);
    setSlReentryStopLoss(0);
    if (user) {
      await updateUserConfig(user.uid, {
        ...(wasBotActive ? { botActive: false } : {}),
        slReentrySide: 'NONE',
        slReentryPrice: 0,
        slReentryStopLoss: 0
      }).catch(console.error);
    }
    await executePositionChange(
      side,
      livePrice,
      rsiVal,
      Date.now(),
      'MANUAL_CLOSE',
      openTrade,
      paperBalanceUsdt
    );
    if (user) syncServerWorker(user);
    showToast(`Manual ${side} opened on ${pair} @ ${fmtPrice(livePrice)}`);
  };

  const handleSignIn = async () => {
    setSigningIn(true);
    setAuthError(null);
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Sign-in cancelled or failed');
    } finally {
      setSigningIn(false);
    }
  };

  const handleSignOut = async () => {
    if (user) {
      fetch('/api/bot/unregister', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ uid: user.uid })
      }).catch(() => {});
    }
    setServerWorkerStatus(null);
    setServerWorkerToken(null);
    await signOut(auth);
  };

  const rsiStatusLabel =
    latestRsi === null
      ? '--'
      : latestRsi > rsiOverbought
        ? 'OB'
        : latestRsi < rsiOversold
          ? 'OS'
          : 'OK';

  const rsiTextColor =
    latestRsi === null
      ? 'text-slate-400'
      : latestRsi > rsiOverbought
        ? 'text-rose-400'
        : latestRsi < rsiOversold
          ? 'text-emerald-400'
          : 'text-sky-400';

  return (
    <div className="min-h-screen bg-[#090D16] text-slate-100 flex flex-col">
      {/* MOBILE PERSISTENT TOP HUD (<= 48px, always shows live RSI & Live Trade PnL on phone) */}
      <header className="md:hidden sticky top-0 z-40 h-12 px-3 bg-slate-950/95 backdrop-blur-md border-b border-slate-800/90 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => {
            if (botActive) {
              showToast(copy.settingsLockedHint);
              return;
            }
            setPairModalOpen(true);
          }}
          className="min-h-[40px] flex items-center gap-1.5 text-left truncate"
        >
          <span className="font-mono text-xs font-bold text-white truncate">{pair}</span>
          <span className="font-mono text-[11px] text-slate-400">{timeframe}</span>
          {botActive ? (
            <Lock className="w-3 h-3 text-amber-400 shrink-0" />
          ) : (
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0" />
          )}
        </button>

        {/* Always-visible Mobile RSI & Live Trade PnL Readouts */}
        <div className="flex items-center gap-3 shrink-0 font-mono text-xs">
          <div className="flex items-center gap-1">
            <span className="text-slate-400 text-[10px]">RSI</span>
            <span className={`font-bold ${rsiTextColor}`}>
              {latestRsi !== null ? latestRsi.toFixed(1) : '--'}
            </span>
            <span className={`text-[10px] ${rsiTextColor}`}>{rsiStatusLabel}</span>
          </div>

          <span className="text-slate-700">|</span>

          <div className="flex items-center gap-1">
            <span className="text-slate-400 text-[10px]">PnL</span>
            {openTrade ? (
              <span className={`font-bold ${livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)}
              </span>
            ) : (
              <span className="text-slate-500 text-[11px]">$0.00</span>
            )}
          </div>
        </div>
      </header>

      {/* DESKTOP 3-ZONE TOP BAR CONTRACT */}
      <header className="hidden md:flex items-center justify-between gap-8 px-6 h-14 border-b border-slate-800/80 bg-slate-950/90 sticky top-0 z-40 backdrop-blur-md">
        {/* Zone 1: Single-line Brand Wordmark */}
        <button
          type="button"
          onClick={() => setDesktopTab('terminal')}
          className="text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0 cursor-pointer"
        >
          {copy.brand}
        </button>

        {/* Zone 2: 5 Clean Single-Line Nav Links */}
        <nav className="flex items-center gap-6 text-sm font-medium">
          {(
            [
              { id: 'terminal', label: copy.navTerminal },
              { id: 'scanner', label: copy.navScanner },
              { id: 'pnl', label: copy.navPnl },
              { id: 'trades', label: copy.navTrades },
              { id: 'signals', label: copy.navSignals }
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setDesktopTab(item.id)}
              className={`py-1 whitespace-nowrap shrink-0 transition-colors border-b-2 ${
                desktopTab === item.id
                  ? 'text-white border-sky-500'
                  : 'text-slate-400 border-transparent hover:text-slate-200'
              }`}
            >
              {item.label}
            </button>
          ))}
        </nav>

        {/* Zone 3: Single Primary Action */}
        <div className="flex items-center gap-3 shrink-0">
          {user ? (
            <button
              type="button"
              onClick={handleSignOut}
              className="min-h-[36px] px-3.5 py-1.5 rounded-lg text-xs font-medium bg-slate-800 hover:bg-slate-700 text-slate-100 flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
            >
              <span className="max-w-[130px] truncate">{user.displayName || user.email}</span>
              <LogOut className="w-3.5 h-3.5 text-slate-400" />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleSignIn}
              disabled={signingIn}
              className="min-h-[36px] px-4 py-1.5 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white flex items-center gap-2 whitespace-nowrap shrink-0 transition-colors"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>{signingIn ? copy.signingIn : copy.signIn}</span>
            </button>
          )}
        </div>
      </header>

      {/* Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-20 md:bottom-6 right-4 z-50 max-w-sm bg-slate-900 border border-slate-700 text-slate-100 px-4 py-3 rounded-xl shadow-2xl text-xs font-medium">
          {toastMessage}
        </div>
      )}

      {/* Main Content Container */}
      <main className="flex-1 w-full max-w-[1480px] mx-auto px-3 sm:px-6 pt-3 pb-20 md:pb-8 space-y-4">
        {/* Guest Persistence Prompt (when signed out) */}
        {authReady && !user && (
          <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <div className="text-xs sm:text-sm font-semibold text-slate-100">
                {copy.guestBannerTitle}
              </div>
              <div className="text-xs text-slate-400 mt-0.5">{copy.guestBannerSub}</div>
              {authError && <div className="text-xs text-rose-400 mt-1">{authError}</div>}
            </div>
            <button
              type="button"
              onClick={handleSignIn}
              disabled={signingIn}
              className="min-h-[40px] px-4 py-2 rounded-lg text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white whitespace-nowrap shrink-0 flex items-center gap-2"
            >
              <LogIn className="w-3.5 h-3.5" />
              <span>{signingIn ? copy.signingIn : copy.signIn}</span>
            </button>
          </div>
        )}

        {/* Workspace Toolbar (Desktop & Tablet/Mobile quick timeframe & pair bar) */}
        <div className="bg-slate-900/50 border border-slate-800/80 rounded-xl px-3 sm:px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            {/* Pair Trigger */}
            <button
              type="button"
              onClick={() => {
                if (botActive) {
                  showToast(copy.settingsLockedHint);
                  return;
                }
                setPairModalOpen(true);
              }}
              className={`hidden md:flex min-h-[38px] px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 items-center gap-2 text-sm font-mono font-bold text-white ${
                botActive ? 'opacity-60 cursor-not-allowed' : 'hover:border-slate-700'
              }`}
            >
              <span>{pair}</span>
              {botActive ? (
                <Lock className="w-3.5 h-3.5 text-amber-400" />
              ) : (
                <ChevronDown className="w-4 h-4 text-slate-400" />
              )}
            </button>

            {/* Live Price & 24h Change */}
            <div className="flex items-baseline gap-2 font-mono">
              <span className="text-base sm:text-lg font-bold text-white">
                {fmtPrice(livePrice)}
              </span>
              {ticker && (
                <span
                  className={`text-xs font-semibold ${
                    ticker.priceChangePercent >= 0 ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {ticker.priceChangePercent >= 0 ? '+' : ''}
                  {ticker.priceChangePercent.toFixed(2)}%
                </span>
              )}
              <span className="text-[11px] text-slate-500 font-sans hidden sm:inline">
                · {dataSource === 'simulated' ? copy.dataSourceSim : copy.dataSourceLive}
              </span>
            </div>

            {/* Desktop Live RSI & Live Trade PnL Indicators */}
            <div className="hidden lg:flex items-center gap-4 pl-3 border-l border-slate-800 text-xs font-mono">
              <div>
                <span className="text-slate-400 mr-1.5">RSI({rsiPeriod})</span>
                <span className={`font-bold ${rsiTextColor}`}>
                  {latestRsi !== null ? latestRsi.toFixed(1) : '--'}
                </span>
                <span className="text-slate-500 ml-1">
                  ({rsiStatusLabel} · {rsiOversold}/{rsiOverbought})
                </span>
              </div>
              <div>
                <span className="text-slate-400 mr-1.5">{copy.livePnl}</span>
                {openTrade ? (
                  <span className={`font-bold ${livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)} ({livePnl >= 0 ? '+' : ''}
                    {liveRoiPct.toFixed(1)}%)
                  </span>
                ) : (
                  <span className="text-slate-500">{copy.noOpenTrade}</span>
                )}
              </div>
            </div>
          </div>

          {/* Right: Timeframe Selector + Language Switcher */}
          <div className="flex items-center gap-2 w-full sm:w-auto justify-between sm:justify-end">
            <div
              className={`flex items-center gap-1 overflow-x-auto py-0.5 ${
                botActive ? 'opacity-55' : ''
              }`}
            >
              {QUICK_TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  disabled={botActive}
                  onClick={() => handleUpdateSettings({ timeframe: tf })}
                  className={`min-h-[34px] px-2.5 py-1 text-xs font-mono rounded-md transition-colors whitespace-nowrap ${
                    timeframe === tf
                      ? 'bg-sky-600 text-white font-semibold'
                      : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
                  } ${botActive ? 'cursor-not-allowed' : ''}`}
                >
                  {tf}
                </button>
              ))}
              <select
                aria-label={copy.timeframeLabel}
                disabled={botActive}
                value={timeframe}
                onChange={(e) => handleUpdateSettings({ timeframe: e.target.value as Timeframe })}
                className={`min-h-[34px] px-2 py-1 text-xs font-mono bg-slate-950 border border-slate-800 rounded-md text-slate-300 focus:outline-none ${
                  botActive ? 'cursor-not-allowed' : ''
                }`}
              >
                {TIMEFRAMES.map((tf) => (
                  <option key={tf} value={tf}>
                    {tf}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={() => setApiModalOpen(true)}
              className="min-h-[34px] px-2.5 py-1 rounded-md border border-slate-800 bg-slate-950 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <KeyRound
                className={`w-3.5 h-3.5 ${
                  binanceCreds.hasKeys && binanceCreds.enabled ? 'text-emerald-400' : 'text-sky-400'
                }`}
              />
              <span>{copy.binanceApiButton}</span>
            </button>

            <button
              type="button"
              onClick={() => setShareModalOpen(true)}
              className="min-h-[34px] px-2.5 py-1 rounded-md border border-slate-800 bg-slate-950 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <QrCode className="w-3.5 h-3.5 text-sky-400" />
              <span>{copy.shareBtn}</span>
            </button>

            <button
              type="button"
              onClick={() => handleUpdateSettings({ language: language === 'en' ? 'si' : 'en' })}
              className="min-h-[34px] px-2.5 py-1 rounded-md border border-slate-800 bg-slate-950 hover:bg-slate-800 text-xs font-medium text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0"
            >
              <Globe className="w-3.5 h-3.5 text-sky-400" />
              <span>{language === 'en' ? 'සිංහල' : 'EN'}</span>
            </button>
          </div>
        </div>

        {/* DESKTOP VIEWS */}
        <div className="hidden md:block">
          {desktopTab === 'terminal' && (
            <div className="grid grid-cols-12 gap-4 items-start">
              {/* Left Dominant Chart Column */}
              <div className="col-span-8 xl:col-span-9 space-y-4">
                {openTrade && (
                  <div className="bg-slate-900/80 border border-slate-800 rounded-xl px-4 py-2.5 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex items-center gap-3 font-mono text-xs sm:text-sm">
                      <span
                        className={`font-bold ${
                          openTrade.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {openTrade.side}
                      </span>
                      <span className="font-semibold text-white">{openTrade.pair}</span>
                      <span className="text-slate-500">·</span>
                      <span className="text-slate-300">{openTrade.leverage}x</span>
                      <span className="text-slate-500">·</span>
                      <span className="text-slate-400">
                        {copy.entryPrice} <span className="text-slate-200">{fmtPrice(openTrade.entryPrice)}</span>
                      </span>
                      <span className="text-slate-500">→</span>
                      <span className="text-slate-400">
                        {copy.markPrice} <span className="text-slate-200">{fmtPrice(openTradeMarkPrice)}</span>
                      </span>
                      {openTrade.stopLossPrice && openTrade.stopLossPrice > 0 ? (
                        <>
                          <span className="text-slate-500">·</span>
                          <span className="text-amber-400">
                            SL {fmtPrice(openTrade.stopLossPrice)}
                          </span>
                        </>
                      ) : null}
                      <span className="text-slate-500">·</span>
                      <span className="text-slate-400">
                        {copy.openedTimeLabel}:{' '}
                        <span className="text-slate-200">
                          {new Date(openTrade.openedAtMs).toLocaleString()}
                        </span>
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="font-mono text-right">
                        <span className="text-[11px] text-slate-400 mr-2">{copy.livePnl}</span>
                        <span
                          className={`text-base font-bold ${
                            livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)} ({livePnl >= 0 ? '+' : ''}
                          {liveRoiPct.toFixed(2)}%)
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleClosePosition}
                        className="min-h-[34px] px-3 py-1 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors"
                      >
                        {copy.closeManually}
                      </button>
                    </div>
                  </div>
                )}

                <div className="h-[540px]">
                  <HeikinAshiChart
                    candles={haCandles}
                    markers={chartMarkers}
                    pair={pair}
                    timeframe={timeframe}
                    armedSellRef={armedSellRef}
                    armedBuyRef={armedBuyRef}
                    slReentrySide={slReentrySide}
                    slReentryPrice={slReentryPrice}
                    slReentryStopLoss={slReentryStopLoss}
                    rsiPeriod={rsiPeriod}
                    rsiOverbought={rsiOverbought}
                    rsiOversold={rsiOversold}
                    buyCloseRsiEnabled={buyCloseRsiEnabled}
                    buyCloseRsi={buyCloseRsi}
                    sellCloseRsiEnabled={sellCloseRsiEnabled}
                    sellCloseRsi={sellCloseRsi}
                    openTrade={openTrade}
                    autoFitLabel={copy.chartAutoFit}
                    hintLabel={copy.chartFreePanHint}
                  />
                </div>

                {/* Desktop Quick Same-Button Manual Buy/Close-Buy & Sell/Close-Sell Bar */}
                <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3 flex items-center justify-between gap-4">
                  <div className="text-xs">
                    <div className="font-semibold text-slate-100 flex items-center gap-2">
                      <span className={botActive ? 'text-emerald-400' : 'text-amber-400'}>
                        {botActive ? copy.botStatusRunning : copy.modeManual}
                      </span>
                      <span className="text-slate-600">·</span>
                      <span className="font-mono text-slate-400">
                        {pair} · {leverage}x · ${marginUsdt} {marginMode}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{copy.manualTradeHint}</div>
                  </div>
                  <div className="flex items-center gap-2.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleManualTrade('BUY')}
                      className={`min-h-[42px] min-w-[140px] px-4 py-2 rounded-xl text-xs font-bold border transition-colors ${
                        openTrade?.side === 'BUY'
                          ? 'bg-emerald-600 hover:bg-emerald-500 border-emerald-400 text-white'
                          : 'bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/40 text-emerald-300'
                      }`}
                    >
                      {openTrade?.side === 'BUY'
                        ? `${copy.closeBuyBtn} (${livePnl >= 0 ? '+' : '-'}$${Math.abs(livePnl).toFixed(2)})`
                        : copy.manualBuy}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleManualTrade('SELL')}
                      className={`min-h-[42px] min-w-[140px] px-4 py-2 rounded-xl text-xs font-bold border transition-colors ${
                        openTrade?.side === 'SELL'
                          ? 'bg-rose-600 hover:bg-rose-500 border-rose-400 text-white'
                          : 'bg-rose-600/20 hover:bg-rose-600/30 border-rose-500/40 text-rose-300'
                      }`}
                    >
                      {openTrade?.side === 'SELL'
                        ? `${copy.closeSellBtn} (${livePnl >= 0 ? '+' : '-'}$${Math.abs(livePnl).toFixed(2)})`
                        : copy.manualSell}
                    </button>
                  </div>
                </div>

                {/* All-Timeframe RSI (1m -> 1d) for Active Pair */}
                {pairAllTfRsi.length > 0 && (
                  <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-3">
                    <div className="flex items-center justify-between mb-2 text-xs">
                      <span className="font-semibold text-slate-200">
                        {copy.pairAllTfRsiTitle} · <span className="font-mono text-sky-400">{pair}</span>
                      </span>
                      <span className="font-mono text-[11px] text-slate-400">
                        ≤{rsiOversold} / ≥{rsiOverbought}
                      </span>
                    </div>
                    <div className="grid grid-cols-11 gap-1.5">
                      {pairAllTfRsi.map((item) => {
                        const isOb = item.liveRsi >= rsiOverbought;
                        const isOs = item.liveRsi <= rsiOversold;
                        const isCurrent = item.interval === timeframe;
                        return (
                          <button
                            key={item.interval}
                            type="button"
                            onClick={() => handleUpdateSettings({ timeframe: item.interval })}
                            className={`py-1.5 px-1 rounded-lg border text-center font-mono transition-colors ${
                              isCurrent
                                ? 'border-sky-500 bg-sky-500/15'
                                : isOb
                                  ? 'border-rose-500/40 bg-rose-500/15'
                                  : isOs
                                    ? 'border-emerald-500/40 bg-emerald-500/15'
                                    : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
                            }`}
                          >
                            <div className="text-[10px] text-slate-400">{item.interval}</div>
                            <div
                              className={`text-xs font-bold mt-0.5 ${
                                isOb
                                  ? 'text-rose-400'
                                  : isOs
                                    ? 'text-emerald-400'
                                    : 'text-slate-200'
                              }`}
                            >
                              {item.liveRsi.toFixed(1)}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Quick Signal Preview Toggle & Recent Signals Strip */}
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-4">
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-semibold text-slate-100">
                      Recent Strategy Signals ({pair} · {timeframe})
                    </h3>
                    <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={previewBacktest}
                        onChange={(e) => setPreviewBacktest(e.target.checked)}
                        className="accent-sky-500 rounded"
                      />
                      <span>Show historical signals on chart</span>
                    </label>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {chartMarkers
                      .slice()
                      .reverse()
                      .slice(0, 6)
                      .map((m) => (
                        <div
                          key={`${m.candleTimeMs}_${m.type}`}
                          className="bg-slate-950/70 border border-slate-800/80 rounded-lg px-3 py-2 text-xs"
                        >
                          <div className="flex items-center justify-between font-mono">
                            <span
                              className={
                                m.type === 'BUY'
                                  ? 'text-emerald-400 font-bold'
                                  : m.type === 'SELL'
                                    ? 'text-rose-400 font-bold'
                                    : 'text-amber-400 font-semibold'
                              }
                            >
                              {m.type}
                            </span>
                            <span className="text-slate-400">{fmtPrice(m.price)}</span>
                          </div>
                          <div className="flex items-center justify-between text-[11px] text-slate-500 font-mono mt-1">
                            <span>RSI {m.rsi.toFixed(1)}</span>
                            <span>{new Date(m.candleTimeMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                </div>
              </div>

              {/* Right Bot Control Panel */}
              <div className="col-span-4 xl:col-span-3">
                <BotControlPanel
                  language={language}
                  pair={pair}
                  timeframe={timeframe}
                  leverage={leverage}
                  marginUsdt={marginUsdt}
                  marginMode={marginMode}
                  boundaryMode={boundaryMode}
                  rsiPeriod={rsiPeriod}
                  rsiOverbought={rsiOverbought}
                  rsiOversold={rsiOversold}
                  buyCloseRsiEnabled={buyCloseRsiEnabled}
                  buyCloseRsi={buyCloseRsi}
                  sellCloseRsiEnabled={sellCloseRsiEnabled}
                  sellCloseRsi={sellCloseRsi}
                  stopLossEnabled={stopLossEnabled}
                  botActive={botActive}
                  armedSellRef={armedSellRef}
                  armedBuyRef={armedBuyRef}
                  armedSellWick={armedSellWick}
                  armedBuyWick={armedBuyWick}
                  slReentrySide={slReentrySide}
                  slReentryPrice={slReentryPrice}
                  slReentryStopLoss={slReentryStopLoss}
                  paperBalanceUsdt={paperBalanceUsdt}
                  openTrade={openTrade}
                  livePrice={openTrade ? openTradeMarkPrice : livePrice}
                  livePnl={livePnl}
                  liveRoiPct={liveRoiPct}
                  binanceCreds={binanceCreds}
                  isSignedIn={Boolean(user)}
                  cloudWorkerStatus={serverWorkerStatus}
                  cloudWorkerToken={serverWorkerToken}
                  onUpdateSettings={handleUpdateSettings}
                  onSetBotMode={handleSetBotActive}
                  onManualTrade={handleManualTrade}
                  onClosePosition={handleClosePosition}
                  onOpenApiModal={() => setApiModalOpen(true)}
                  onOpenPairModal={() => setPairModalOpen(true)}
                  onRunBacktest={() => {
                    setPreviewBacktest(true);
                    showToast(
                      `Plotted ${historicalScan.markers.length} Heikin Ashi RSI signals across ${haCandles.length} bars`
                    );
                  }}
                />
              </div>
            </div>
          )}

          {desktopTab === 'scanner' && (
            <RsiScannerView
              language={language}
              rsiPeriod={rsiPeriod}
              rsiOverbought={rsiOverbought}
              rsiOversold={rsiOversold}
              activeTimeframe={timeframe}
              onSelectPairAndTimeframe={(symbol, tf) => {
                handleUpdateSettings({ selectedPair: symbol, timeframe: tf });
                setDesktopTab('terminal');
              }}
            />
          )}

          {desktopTab === 'pnl' && (
            <PnlAnalyticsView
              trades={trades}
              language={language}
              paperBalanceUsdt={paperBalanceUsdt}
              openTrade={openTrade}
              livePnl={livePnl}
              liveRoiPct={liveRoiPct}
              liveMarkPrice={openTradeMarkPrice}
            />
          )}

          {desktopTab === 'trades' && (
            <HistoryViews
              mode="trades"
              trades={trades}
              signals={signals}
              language={language}
              livePrices={livePrices}
            />
          )}

          {desktopTab === 'signals' && (
            <HistoryViews
              mode="signals"
              trades={trades}
              signals={signals}
              language={language}
              livePrices={livePrices}
            />
          )}
        </div>

        {/* MOBILE VIEWS */}
        <div className="md:hidden space-y-4">
          {mobileTab === 'chart' && (
            <div className="space-y-3">
              <div className="h-[420px]">
                <HeikinAshiChart
                  candles={haCandles}
                  markers={chartMarkers}
                  pair={pair}
                  timeframe={timeframe}
                  armedSellRef={armedSellRef}
                  armedBuyRef={armedBuyRef}
                  slReentrySide={slReentrySide}
                  slReentryPrice={slReentryPrice}
                  slReentryStopLoss={slReentryStopLoss}
                  rsiPeriod={rsiPeriod}
                  rsiOverbought={rsiOverbought}
                  rsiOversold={rsiOversold}
                  buyCloseRsiEnabled={buyCloseRsiEnabled}
                  buyCloseRsi={buyCloseRsi}
                  sellCloseRsiEnabled={sellCloseRsiEnabled}
                  sellCloseRsi={sellCloseRsi}
                  openTrade={openTrade}
                  autoFitLabel={copy.chartAutoFit}
                  hintLabel={copy.chartFreePanHint}
                />
              </div>

              {openTrade && (
                <div className="bg-slate-900/85 border border-slate-800 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs font-mono">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`font-bold ${
                          openTrade.side === 'BUY' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {openTrade.side}
                      </span>
                      <span className="font-semibold text-white">{openTrade.pair}</span>
                      <span className="text-slate-400">· {openTrade.leverage}x</span>
                    </div>
                    <span
                      className={`text-sm font-bold ${
                        livePnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)} ({livePnl >= 0 ? '+' : ''}
                      {liveRoiPct.toFixed(1)}%)
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400">
                    <span>
                      {copy.entryPrice}: {fmtPrice(openTrade.entryPrice)} → {copy.markPrice}:{' '}
                      {fmtPrice(openTradeMarkPrice)}
                    </span>
                    <button
                      type="button"
                      onClick={handleClosePosition}
                      className="px-2.5 py-1 rounded-md bg-slate-800 text-slate-100 font-sans font-medium"
                    >
                      {copy.closeManually}
                    </button>
                  </div>
                  <div className="text-[11px] font-mono text-slate-400 pt-1 border-t border-slate-800/80 flex items-center justify-between">
                    <span>{copy.openedTimeLabel}</span>
                    <span className="text-slate-200">{new Date(openTrade.openedAtMs).toLocaleString()}</span>
                  </div>
                </div>
              )}

              {/* Quick Same-Button Manual Buy/Close & Sell/Close right under chart on mobile */}
              <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-3 space-y-2.5">
                <div className="flex items-center justify-between gap-2 text-xs">
                  <div>
                    <div className={`font-semibold ${botActive ? 'text-emerald-400' : 'text-amber-400'}`}>
                      {botActive ? copy.botStatusRunning : copy.modeManual}
                    </div>
                    <div className="font-mono text-slate-400 text-[11px] mt-0.5">
                      {leverage}x · ${marginUsdt} · {marginMode}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleSetBotActive(!botActive)}
                    className={`min-h-[36px] px-3 py-1.5 rounded-lg text-[11px] font-semibold border whitespace-nowrap shrink-0 ${
                      botActive
                        ? 'bg-rose-600/20 border-rose-500/40 text-rose-300'
                        : 'bg-slate-800 border-slate-700 text-slate-200'
                    }`}
                  >
                    {botActive ? copy.stopBot : copy.startBot}
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2.5">
                  <button
                    type="button"
                    onClick={() => handleManualTrade('BUY')}
                    className={`min-h-[48px] px-3 py-2 rounded-xl text-xs font-bold flex flex-col items-center justify-center gap-0.5 border transition-colors ${
                      openTrade?.side === 'BUY'
                        ? 'bg-emerald-600 hover:bg-emerald-500 border-emerald-400 text-white'
                        : 'bg-emerald-600/20 hover:bg-emerald-600/30 border-emerald-500/40 text-emerald-300'
                    }`}
                  >
                    <span>{openTrade?.side === 'BUY' ? copy.closeBuyBtn : copy.manualBuy}</span>
                    {openTrade?.side === 'BUY' && (
                      <span className="font-mono text-[11px] opacity-95">
                        {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)}
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleManualTrade('SELL')}
                    className={`min-h-[48px] px-3 py-2 rounded-xl text-xs font-bold flex flex-col items-center justify-center gap-0.5 border transition-colors ${
                      openTrade?.side === 'SELL'
                        ? 'bg-rose-600 hover:bg-rose-500 border-rose-400 text-white'
                        : 'bg-rose-600/20 hover:bg-rose-600/30 border-rose-500/40 text-rose-300'
                    }`}
                  >
                    <span>{openTrade?.side === 'SELL' ? copy.closeSellBtn : copy.manualSell}</span>
                    {openTrade?.side === 'SELL' && (
                      <span className="font-mono text-[11px] opacity-95">
                        {livePnl >= 0 ? '+' : '-'}${Math.abs(livePnl).toFixed(2)}
                      </span>
                    )}
                  </button>
                </div>
              </div>

              {/* Mobile All-Timeframe RSI (1m -> 1d) for Active Pair */}
              {pairAllTfRsi.length > 0 && (
                <div className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-semibold text-slate-200">
                      {copy.pairAllTfRsiTitle} · <span className="font-mono text-sky-400">{pair}</span>
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      ≤{rsiOversold} / ≥{rsiOverbought}
                    </span>
                  </div>
                  <div className="grid grid-cols-4 gap-1.5">
                    {pairAllTfRsi.map((item) => {
                      const isOb = item.liveRsi >= rsiOverbought;
                      const isOs = item.liveRsi <= rsiOversold;
                      const isCurrent = item.interval === timeframe;
                      return (
                        <button
                          key={item.interval}
                          type="button"
                          onClick={() => handleUpdateSettings({ timeframe: item.interval })}
                          className={`py-1.5 px-2 rounded-lg border flex items-center justify-between font-mono text-xs transition-colors ${
                            isCurrent
                              ? 'border-sky-500 bg-sky-500/15'
                              : isOb
                                ? 'border-rose-500/40 bg-rose-500/15'
                                : isOs
                                  ? 'border-emerald-500/40 bg-emerald-500/15'
                                  : 'border-slate-800 bg-slate-950/70'
                          }`}
                        >
                          <span className="text-[11px] text-slate-400">{item.interval}</span>
                          <span
                            className={`font-bold ${
                              isOb
                                ? 'text-rose-400'
                                : isOs
                                  ? 'text-emerald-400'
                                  : 'text-slate-200'
                            }`}
                          >
                            {item.liveRsi.toFixed(1)}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {mobileTab === 'bot' && (
            <div className="space-y-4">
              {user && (
                <div className="bg-slate-900/60 border border-slate-800 rounded-xl px-4 py-3 flex items-center justify-between gap-2">
                  <div className="text-xs truncate">
                    <div className="font-semibold text-slate-100 truncate">
                      {user.displayName || user.email}
                    </div>
                    <div className="text-slate-400 truncate">{user.email}</div>
                  </div>
                  <button
                    type="button"
                    onClick={handleSignOut}
                    className="min-h-[40px] px-3 py-1.5 rounded-lg text-xs font-medium bg-slate-800 text-slate-200 flex items-center gap-1.5 shrink-0"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>{copy.signOut}</span>
                  </button>
                </div>
              )}
              <BotControlPanel
                language={language}
                pair={pair}
                timeframe={timeframe}
                leverage={leverage}
                marginUsdt={marginUsdt}
                marginMode={marginMode}
                boundaryMode={boundaryMode}
                rsiPeriod={rsiPeriod}
                rsiOverbought={rsiOverbought}
                rsiOversold={rsiOversold}
                buyCloseRsiEnabled={buyCloseRsiEnabled}
                buyCloseRsi={buyCloseRsi}
                sellCloseRsiEnabled={sellCloseRsiEnabled}
                sellCloseRsi={sellCloseRsi}
                stopLossEnabled={stopLossEnabled}
                botActive={botActive}
                armedSellRef={armedSellRef}
                armedBuyRef={armedBuyRef}
                armedSellWick={armedSellWick}
                armedBuyWick={armedBuyWick}
                slReentrySide={slReentrySide}
                slReentryPrice={slReentryPrice}
                slReentryStopLoss={slReentryStopLoss}
                paperBalanceUsdt={paperBalanceUsdt}
                openTrade={openTrade}
                livePrice={openTrade ? openTradeMarkPrice : livePrice}
                livePnl={livePnl}
                liveRoiPct={liveRoiPct}
                binanceCreds={binanceCreds}
                isSignedIn={Boolean(user)}
                cloudWorkerStatus={serverWorkerStatus}
                cloudWorkerToken={serverWorkerToken}
                onUpdateSettings={handleUpdateSettings}
                onSetBotMode={handleSetBotActive}
                onManualTrade={handleManualTrade}
                onClosePosition={handleClosePosition}
                onOpenApiModal={() => setApiModalOpen(true)}
                onOpenPairModal={() => setPairModalOpen(true)}
                onRunBacktest={() => {
                  setPreviewBacktest(true);
                  setMobileTab('chart');
                  showToast(
                    `Plotted ${historicalScan.markers.length} Heikin Ashi RSI signals`
                  );
                }}
              />
            </div>
          )}

          {mobileTab === 'scanner' && (
            <RsiScannerView
              language={language}
              rsiPeriod={rsiPeriod}
              rsiOverbought={rsiOverbought}
              rsiOversold={rsiOversold}
              activeTimeframe={timeframe}
              onSelectPairAndTimeframe={(symbol, tf) => {
                handleUpdateSettings({ selectedPair: symbol, timeframe: tf });
                setMobileTab('chart');
              }}
            />
          )}

          {mobileTab === 'pnl' && (
            <PnlAnalyticsView
              trades={trades}
              language={language}
              paperBalanceUsdt={paperBalanceUsdt}
              openTrade={openTrade}
              livePnl={livePnl}
              liveRoiPct={liveRoiPct}
              liveMarkPrice={openTradeMarkPrice}
            />
          )}

          {mobileTab === 'logs' && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setMobileLogMode('trades')}
                  className={`min-h-[40px] text-xs font-medium rounded-md ${
                    mobileLogMode === 'trades' ? 'bg-slate-800 text-white' : 'text-slate-400'
                  }`}
                >
                  {copy.navTrades}
                </button>
                <button
                  type="button"
                  onClick={() => setMobileLogMode('signals')}
                  className={`min-h-[40px] text-xs font-medium rounded-md ${
                    mobileLogMode === 'signals' ? 'bg-slate-800 text-white' : 'text-slate-400'
                  }`}
                >
                  {copy.navSignals}
                </button>
              </div>
              <HistoryViews
                mode={mobileLogMode}
                trades={trades}
                signals={signals}
                language={language}
                livePrices={livePrices}
              />
            </div>
          )}
        </div>
      </main>

      {/* MOBILE BOTTOM NAVIGATION BAR (56px height, total sticky mobile = 48 + 56 = 104px <= 15% of 800px) */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 h-14 bg-slate-950/95 backdrop-blur-md border-t border-slate-800/90 grid grid-cols-5 items-center">
        {(
          [
            { id: 'chart', label: copy.mobileTabChart, Icon: Activity },
            { id: 'scanner', label: copy.mobileTabScanner, Icon: Radar },
            { id: 'bot', label: copy.mobileTabBot, Icon: SlidersHorizontal },
            { id: 'pnl', label: copy.mobileTabPnl, Icon: BarChart3 },
            { id: 'logs', label: copy.mobileTabLogs, Icon: History }
          ] as const
        ).map(({ id, label, Icon }) => {
          const active = mobileTab === id;
          return (
            <button
              key={id}
              type="button"
              onClick={() => setMobileTab(id)}
              className={`h-full flex flex-col items-center justify-center gap-0.5 transition-colors ${
                active ? 'text-sky-400' : 'text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium tracking-tight">{label}</span>
            </button>
          );
        })}
      </nav>

      {/* Searchable Binance Pair Selector Modal */}
      <PairSelectorModal
        open={pairModalOpen}
        pairs={pairs}
        selectedPair={pair}
        placeholder={copy.pairPlaceholder}
        onSelect={(symbol) => handleUpdateSettings({ selectedPair: symbol })}
        onClose={() => setPairModalOpen(false)}
      />

      {/* Share QR & Multi-Device Registration Link Modal */}
      <ShareAppModal
        open={shareModalOpen}
        language={language}
        onClose={() => setShareModalOpen(false)}
      />

      {/* Owner-Isolated Cross-Device Binance API Credentials Modal */}
      <BinanceApiModal
        open={apiModalOpen}
        language={language}
        isSignedIn={Boolean(user)}
        userEmail={user?.email || null}
        credentials={binanceCreds}
        onSignIn={handleSignIn}
        onSave={async (payload) => {
          if (!user) return;
          await saveUserBinanceCredentials(user.uid, payload);
          syncServerWorker(user);
          showToast(copy.binanceApiSavedToast);
        }}
        onDelete={async () => {
          if (!user) return;
          await deleteUserBinanceCredentials(user.uid);
          showToast(copy.binanceApiDeletedToast);
        }}
        onClose={() => setApiModalOpen(false)}
      />

      {/* Always-Visible Draggable Floating RSI & PnL Mini HUD */}
      <FloatingHudWidget
        pair={pair}
        latestRsi={latestRsi}
        rsiOverbought={rsiOverbought}
        rsiOversold={rsiOversold}
        openTrade={openTrade}
        livePnl={livePnl}
        liveRoiPct={liveRoiPct}
        dragHint={copy.floatingDragHint}
      />
    </div>
  );
}
