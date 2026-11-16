import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import express from 'express';
import { createServerBotEngine } from './server-bot-engine.ts';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
const BINANCE_USE_TESTNET = process.env.BINANCE_USE_TESTNET !== 'false';

interface PairInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  market: 'futures' | 'spot';
}

interface RawCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

const DEFAULT_PAIRS: PairInfo[] = [
  { symbol: 'BTCUSDT', baseAsset: 'BTC', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'ETHUSDT', baseAsset: 'ETH', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'SOLUSDT', baseAsset: 'SOL', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'BNBUSDT', baseAsset: 'BNB', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'XRPUSDT', baseAsset: 'XRP', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'DOGEUSDT', baseAsset: 'DOGE', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'ADAUSDT', baseAsset: 'ADA', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'AVAXUSDT', baseAsset: 'AVAX', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'SUIUSDT', baseAsset: 'SUI', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'LINKUSDT', baseAsset: 'LINK', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'PEPEUSDT', baseAsset: 'PEPE', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'NEARUSDT', baseAsset: 'NEAR', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'LTCUSDT', baseAsset: 'LTC', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'TRXUSDT', baseAsset: 'TRX', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'DOTUSDT', baseAsset: 'DOT', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'APTUSDT', baseAsset: 'APT', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'ARBUSDT', baseAsset: 'ARB', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'OPUSDT', baseAsset: 'OP', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'ATOMUSDT', baseAsset: 'ATOM', quoteAsset: 'USDT', market: 'futures' },
  { symbol: 'TONUSDT', baseAsset: 'TON', quoteAsset: 'USDT', market: 'futures' }
];

let cachedPairs: { data: PairInfo[]; source: string; fetchedAt: number } | null = null;
const symbolPrecisionMap = new Map<string, { stepSize: number; quantityPrecision: number }>();

function formatQuantityForSymbol(symbol: string, rawQty: number): string {
  const info = symbolPrecisionMap.get(symbol.toUpperCase());
  if (!info) {
    return Number(rawQty.toFixed(3)).toString();
  }
  const step = info.stepSize;
  if (step > 0) {
    const decimals = step < 1 ? Math.max(0, Math.round(-Math.log10(step))) : 0;
    const snapped = Math.floor(rawQty / step + 1e-9) * step;
    const finalQty = snapped > 0 ? snapped : step;
    return finalQty.toFixed(Math.min(8, decimals));
  }
  return rawQty.toFixed(Math.min(8, Math.max(0, info.quantityPrecision)));
}

async function ensureSymbolPrecision(symbol: string): Promise<void> {
  const key = symbol.toUpperCase();
  if (symbolPrecisionMap.has(key)) return;
  try {
    const fRes = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/exchangeInfo', 4500);
    if (!fRes.ok) return;
    const json = (await fRes.json()) as {
      symbols?: Array<{
        symbol: string;
        quantityPrecision?: number;
        filters?: Array<{ filterType: string; stepSize?: string }>;
      }>;
    };
    for (const s of json.symbols || []) {
      const lot = s.filters?.find((f) => f.filterType === 'LOT_SIZE');
      symbolPrecisionMap.set(s.symbol, {
        stepSize: lot?.stepSize ? Number(lot.stepSize) : 0,
        quantityPrecision: typeof s.quantityPrecision === 'number' ? s.quantityPrecision : 3
      });
    }
  } catch {
    // Fallback cleanly if exchangeInfo is unreachable
  }
}

async function fetchWithTimeout(url: string, timeoutMs = 5500): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'HeikinPulse/1.0'
      }
    });
  } finally {
    clearTimeout(timer);
  }
}

function intervalToMs(interval: string): number {
  const map: Record<string, number> = {
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
  return map[interval] ?? 900_000;
}

function generateFallbackCandles(symbol: string, interval: string, limit: number): RawCandle[] {
  const stepMs = intervalToMs(interval);
  const now = Date.now();
  const latestOpen = Math.floor(now / stepMs) * stepMs;
  const basePriceMap: Record<string, number> = {
    BTCUSDT: 94200,
    ETHUSDT: 3320,
    SOLUSDT: 215,
    BNBUSDT: 645,
    XRPUSDT: 2.35,
    DOGEUSDT: 0.36,
    ADAUSDT: 0.92,
    AVAXUSDT: 42.5,
    SUIUSDT: 3.85,
    LINKUSDT: 22.4
  };
  const base = basePriceMap[symbol] ?? 100;
  let seed = 0;
  for (let i = 0; i < symbol.length; i++) {
    seed += symbol.charCodeAt(i) * (i + 1);
  }

  const candles: RawCandle[] = [];
  let price = base * 0.94;
  for (let i = limit - 1; i >= 0; i--) {
    const openTime = latestOpen - i * stepMs;
    const t = openTime / stepMs;
    // Smooth cyclical waves so RSI naturally reaches >80 and <20 periodically
    const wave = Math.sin(t * 0.14 + seed) * 0.012 + Math.cos(t * 0.045 + seed * 0.5) * 0.008;
    const noise = Math.sin(t * 1.7 + seed) * 0.003;
    const deltaPct = wave + noise;
    const open = price;
    const close = Math.max(base * 0.2, open * (1 + deltaPct));
    const spread = Math.abs(close - open) + open * 0.0022;
    const high = Math.max(open, close) + spread * 0.45;
    const low = Math.min(open, close) - spread * 0.45;
    candles.push({
      openTime,
      open: Number(open.toPrecision(6)),
      high: Number(high.toPrecision(6)),
      low: Number(low.toPrecision(6)),
      close: Number(close.toPrecision(6)),
      volume: Number((1000 + Math.abs(Math.sin(t)) * 4500).toFixed(2)),
      closeTime: openTime + stepMs - 1
    });
    price = close;
  }
  return candles;
}

const app = express();
app.use(express.json());

async function fetchBinanceKlinesInternal(
  symbol: string,
  interval: string,
  limit = 400,
  startTime?: number
): Promise<{ symbol: string; interval: string; source: string; candles: RawCandle[] }> {
  const cleanSymbol = String(symbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const allowedIntervals = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w']);
  const safeInterval = allowedIntervals.has(interval) ? interval : '15m';
  const safeLimit = Math.min(1000, Math.max(50, Number(limit || 400)));

  const params = new URLSearchParams({
    symbol: cleanSymbol,
    interval: safeInterval,
    limit: String(safeLimit)
  });
  if (startTime && Number.isFinite(startTime)) {
    params.set('startTime', String(Math.floor(startTime)));
  }

  const endpoints = [
    { url: `https://fapi.binance.com/fapi/v1/klines?${params.toString()}`, source: 'binance-futures' },
    { url: `https://data-api.binance.vision/api/v3/klines?${params.toString()}`, source: 'binance-spot' }
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(endpoint.url);
      if (response.ok) {
        const raw = (await response.json()) as Array<Array<string | number>>;
        if (Array.isArray(raw) && raw.length > 0) {
          const candles: RawCandle[] = raw.map((k) => ({
            openTime: Number(k[0]),
            open: Number(k[1]),
            high: Number(k[2]),
            low: Number(k[3]),
            close: Number(k[4]),
            volume: Number(k[5]),
            closeTime: Number(k[6])
          }));
          return { symbol: cleanSymbol, interval: safeInterval, source: endpoint.source, candles };
        }
      }
    } catch {
      // Try next endpoint
    }
  }

  return {
    symbol: cleanSymbol,
    interval: safeInterval,
    source: 'simulated',
    candles: generateFallbackCandles(cleanSymbol, safeInterval, safeLimit)
  };
}

async function fetchBinanceTickerInternal(symbol: string): Promise<{
  symbol: string;
  source: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}> {
  const cleanSymbol = String(symbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const endpoints = [
    { url: `https://fapi.binance.com/fapi/v1/ticker/24hr?symbol=${cleanSymbol}`, source: 'binance-futures' },
    { url: `https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${cleanSymbol}`, source: 'binance-spot' }
  ];

  for (const endpoint of endpoints) {
    try {
      const response = await fetchWithTimeout(endpoint.url, 4000);
      if (response.ok) {
        const t = (await response.json()) as {
          lastPrice?: string;
          priceChangePercent?: string;
          highPrice?: string;
          lowPrice?: string;
          quoteVolume?: string;
        };
        if (t && t.lastPrice) {
          return {
            symbol: cleanSymbol,
            source: endpoint.source,
            lastPrice: Number(t.lastPrice),
            priceChangePercent: Number(t.priceChangePercent || 0),
            highPrice: Number(t.highPrice || 0),
            lowPrice: Number(t.lowPrice || 0),
            quoteVolume: Number(t.quoteVolume || 0)
          };
        }
      }
    } catch {
      // Try next endpoint
    }
  }

  const fallback = generateFallbackCandles(cleanSymbol, '15m', 20);
  const last = fallback[fallback.length - 1];
  const first = fallback[0];
  return {
    symbol: cleanSymbol,
    source: 'simulated',
    lastPrice: last.close,
    priceChangePercent: Number((((last.close - first.open) / first.open) * 100).toFixed(2)),
    highPrice: Math.max(...fallback.map((c) => c.high)),
    lowPrice: Math.min(...fallback.map((c) => c.low)),
    quoteVolume: 125000000
  };
}

async function executeBinanceOrderInternal(params: {
  symbol: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  leverage?: number;
  marginType?: 'ISOLATED' | 'CROSSED';
  apiKey?: string;
  apiSecret?: string;
  testnet?: boolean;
  reduceOnly?: boolean;
}): Promise<{
  status: number;
  ok: boolean;
  executedOn: string;
  formattedQuantity?: string;
  order?: unknown;
  error?: string;
}> {
  const { symbol, side, quantity, leverage, marginType, apiKey, apiSecret, testnet, reduceOnly } = params;
  const effectiveKey = (apiKey || '').trim() || BINANCE_API_KEY;
  const effectiveSecret = (apiSecret || '').trim() || BINANCE_API_SECRET;
  const useTestnet = apiKey && apiSecret ? testnet !== false : BINANCE_USE_TESTNET;

  if (!effectiveKey || !effectiveSecret) {
    return {
      status: 200,
      ok: true,
      executedOn: 'paper-live-market'
    };
  }

  try {
    const baseUrl = useTestnet
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    if (marginType) {
      const marginParams = new URLSearchParams({
        symbol,
        marginType,
        recvWindow: '5000',
        timestamp: String(Date.now())
      });
      const marginSig = crypto.createHmac('sha256', effectiveSecret).update(marginParams.toString()).digest('hex');
      await fetch(`${baseUrl}/fapi/v1/marginType?${marginParams.toString()}&signature=${marginSig}`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': effectiveKey }
      }).catch(() => {});
    }

    if (leverage) {
      const levParams = new URLSearchParams({
        symbol,
        leverage: String(Math.min(125, Math.max(1, Math.round(leverage)))),
        recvWindow: '5000',
        timestamp: String(Date.now())
      });
      const levSig = crypto.createHmac('sha256', effectiveSecret).update(levParams.toString()).digest('hex');
      await fetch(`${baseUrl}/fapi/v1/leverage?${levParams.toString()}&signature=${levSig}`, {
        method: 'POST',
        headers: { 'X-MBX-APIKEY': effectiveKey }
      }).catch(() => {});
    }

    await ensureSymbolPrecision(symbol);
    const formattedQuantity = formatQuantityForSymbol(symbol, Number(quantity));

    const orderParams = new URLSearchParams({
      symbol,
      side,
      type: 'MARKET',
      quantity: formattedQuantity,
      recvWindow: '5000',
      timestamp: String(Date.now())
    });
    if (reduceOnly) {
      orderParams.set('reduceOnly', 'true');
    }

    const sig = crypto.createHmac('sha256', effectiveSecret).update(orderParams.toString()).digest('hex');
    const orderRes = await fetch(`${baseUrl}/fapi/v1/order?${orderParams.toString()}&signature=${sig}`, {
      method: 'POST',
      headers: { 'X-MBX-APIKEY': effectiveKey }
    });
    const orderJson = (await orderRes.json()) as { msg?: string };
    return {
      status: orderRes.status,
      ok: orderRes.ok,
      executedOn: useTestnet ? 'binance-futures-testnet' : 'binance-futures-live',
      formattedQuantity,
      order: orderJson,
      error: !orderRes.ok ? orderJson?.msg || `HTTP ${orderRes.status}` : undefined
    };
  } catch (error) {
    return {
      status: 502,
      ok: false,
      executedOn: 'error',
      error: error instanceof Error ? error.message : 'Binance execution failed'
    };
  }
}

const botEngine = createServerBotEngine({
  rootDir: __dirname,
  fetchKlines: async (symbol, interval, limit = 500) => {
    const res = await fetchBinanceKlinesInternal(symbol, interval, limit);
    return { candles: res.candles, source: res.source };
  },
  fetchLivePrice: async (symbol) => {
    const res = await fetchBinanceTickerInternal(symbol);
    return { price: res.lastPrice, source: res.source };
  },
  executeOrder: async (params) => {
    const r = await executeBinanceOrderInternal(params);
    return { ok: r.ok, error: r.error };
  }
});

app.get('/api/health', (_req, res) => {
  // Also wake & run a background tick whenever health/cron pings the server
  botEngine.runCycle().catch(() => {});
  const status = botEngine.getStatus();
  res.json({ ok: true, timestamp: Date.now(), workerCount: status.workerCount });
});

app.post('/api/bot/register', async (req, res) => {
  const { uid, refreshToken } = req.body as { uid?: string; refreshToken?: string };
  if (!uid || !refreshToken) {
    res.status(400).json({ ok: false, error: 'Missing uid or refreshToken' });
    return;
  }
  try {
    const status = await botEngine.registerWorker(uid, refreshToken);
    res.json({ ok: true, status });
  } catch (err) {
    res.status(401).json({
      ok: false,
      error: err instanceof Error ? err.message : 'Failed to verify Firebase session'
    });
  }
});

app.post('/api/bot/unregister', (req, res) => {
  const { uid } = req.body as { uid?: string };
  if (uid) {
    botEngine.unregisterWorker(uid);
  }
  res.json({ ok: true });
});

app.get('/api/bot/status', (req, res) => {
  const uid = req.query.uid ? String(req.query.uid) : undefined;
  res.json(botEngine.getStatus(uid));
});

app.get('/api/binance/status', (_req, res) => {
  res.json({
    hasServerApiKeys: Boolean(BINANCE_API_KEY && BINANCE_API_SECRET),
    testnet: BINANCE_USE_TESTNET
  });
});

app.get('/api/binance/pairs', async (_req, res) => {
  try {
    if (cachedPairs && Date.now() - cachedPairs.fetchedAt < 10 * 60_000) {
      res.json({ pairs: cachedPairs.data, source: cachedPairs.source });
      return;
    }

    // Try Binance USD-M Futures first
    try {
      const fRes = await fetchWithTimeout('https://fapi.binance.com/fapi/v1/exchangeInfo');
      if (fRes.ok) {
        const json = await fRes.json() as {
          symbols?: Array<{
            symbol: string;
            baseAsset: string;
            quoteAsset: string;
            status: string;
            contractType?: string;
            quantityPrecision?: number;
            filters?: Array<{ filterType: string; stepSize?: string }>;
          }>;
        };
        for (const s of json.symbols || []) {
          const lot = s.filters?.find((f) => f.filterType === 'LOT_SIZE');
          symbolPrecisionMap.set(s.symbol, {
            stepSize: lot?.stepSize ? Number(lot.stepSize) : 0,
            quantityPrecision: typeof s.quantityPrecision === 'number' ? s.quantityPrecision : 3
          });
        }
        const pairs = (json.symbols || [])
          .filter((s) => s.status === 'TRADING' && s.quoteAsset === 'USDT' && (!s.contractType || s.contractType === 'PERPETUAL'))
          .map((s) => ({
            symbol: s.symbol,
            baseAsset: s.baseAsset,
            quoteAsset: s.quoteAsset,
            market: 'futures' as const
          }))
          .sort((a, b) => a.symbol.localeCompare(b.symbol));
        if (pairs.length > 0) {
          cachedPairs = { data: pairs, source: 'binance-futures', fetchedAt: Date.now() };
          res.json({ pairs, source: 'binance-futures' });
          return;
        }
      }
    } catch {
      // Fall through to spot market data endpoint
    }

    // Try Binance global market-data endpoint (data-api.binance.vision)
    try {
      const sRes = await fetchWithTimeout('https://data-api.binance.vision/api/v3/exchangeInfo');
      if (sRes.ok) {
        const json = await sRes.json() as {
          symbols?: Array<{ symbol: string; baseAsset: string; quoteAsset: string; status: string }>;
        };
        const pairs = (json.symbols || [])
          .filter((s) => s.status === 'TRADING' && (s.quoteAsset === 'USDT' || s.quoteAsset === 'FDUSD' || s.quoteAsset === 'BTC'))
          .map((s) => ({
            symbol: s.symbol,
            baseAsset: s.baseAsset,
            quoteAsset: s.quoteAsset,
            market: 'spot' as const
          }))
          .slice(0, 400);
        if (pairs.length > 0) {
          cachedPairs = { data: pairs, source: 'binance-spot', fetchedAt: Date.now() };
          res.json({ pairs, source: 'binance-spot' });
          return;
        }
      }
    } catch {
      // Fall through to default pairs
    }

    res.json({ pairs: DEFAULT_PAIRS, source: 'fallback' });
  } catch {
    res.json({ pairs: DEFAULT_PAIRS, source: 'fallback' });
  }
});

app.get('/api/binance/klines', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT');
  const interval = String(req.query.interval || '15m');
  const limit = Number(req.query.limit || 400);
  const startTime = req.query.startTime ? Number(req.query.startTime) : undefined;
  const result = await fetchBinanceKlinesInternal(symbol, interval, limit, startTime);
  res.json(result);
});

app.get('/api/binance/ticker', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT');
  const result = await fetchBinanceTickerInternal(symbol);
  res.json(result);
});

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

let cachedTopTickers: {
  data: Array<{ symbol: string; lastPrice: number; priceChangePercent: number; quoteVolume: number }>;
  source: string;
  fetchedAt: number;
} | null = null;

const ALL_1M_TO_1D_INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'] as const;

const scannerCache = new Map<string, { items: ScannerEntry[]; source: string; fetchedAt: number }>();
const pairRsiCache = new Map<
  string,
  {
    fetchedAt: number;
    timeframes: Array<{ interval: string; liveRsi: number; closedRsi: number; haColor: 'GREEN' | 'RED' }>;
  }
>();

function computeLatestHaAndRsi(candles: RawCandle[], period: number): {
  liveRsi: number;
  closedRsi: number;
  haColor: 'GREEN' | 'RED';
  lastPrice: number;
} {
  let haOpen = (candles[0].open + candles[0].close) / 2;
  let haClose = (candles[0].open + candles[0].high + candles[0].low + candles[0].close) / 4;
  const gains: number[] = [];
  const losses: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;
  const rsis: Array<number | null> = [null];

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    haOpen = (haOpen + haClose) / 2;
    haClose = (c.open + c.high + c.low + c.close) / 4;

    const diff = c.close - candles[i - 1].close;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    gains.push(gain);
    losses.push(loss);

    let rsi: number | null = null;
    if (i === period) {
      avgGain = gains.reduce((a, b) => a + b, 0) / period;
      avgLoss = losses.reduce((a, b) => a + b, 0) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
    } else if (i > period) {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
      rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
    }
    rsis.push(rsi);
  }

  const liveRsi = rsis[rsis.length - 1] ?? 50;
  const closedRsi = rsis[rsis.length - 2] ?? liveRsi;
  return {
    liveRsi: Number(liveRsi.toFixed(2)),
    closedRsi: Number(closedRsi.toFixed(2)),
    haColor: haClose >= haOpen ? 'GREEN' : 'RED',
    lastPrice: candles[candles.length - 1].close
  };
}

async function getTopLiquidPairs() {
  if (cachedTopTickers && Date.now() - cachedTopTickers.fetchedAt < 5 * 60_000) {
    return cachedTopTickers;
  }

  const endpoints = [
    { url: 'https://fapi.binance.com/fapi/v1/ticker/24hr', source: 'binance-futures' },
    { url: 'https://data-api.binance.vision/api/v3/ticker/24hr', source: 'binance-spot' }
  ];

  for (const ep of endpoints) {
    try {
      const r = await fetchWithTimeout(ep.url, 6000);
      if (r.ok) {
        const arr = (await r.json()) as Array<{
          symbol: string;
          lastPrice: string;
          priceChangePercent: string;
          quoteVolume: string;
        }>;
        if (Array.isArray(arr) && arr.length > 0) {
          const top = arr
            .filter(
              (t) =>
                t.symbol.endsWith('USDT') &&
                !t.symbol.includes('_') &&
                Number(t.lastPrice) > 0 &&
                Number(t.quoteVolume) > 5_000_000
            )
            .map((t) => ({
              symbol: t.symbol,
              lastPrice: Number(t.lastPrice),
              priceChangePercent: Number(t.priceChangePercent || 0),
              quoteVolume: Number(t.quoteVolume || 0)
            }))
            .sort((a, b) => b.quoteVolume - a.quoteVolume)
            .slice(0, 45);
          if (top.length > 0) {
            cachedTopTickers = { data: top, source: ep.source, fetchedAt: Date.now() };
            return cachedTopTickers;
          }
        }
      }
    } catch {
      // Try next endpoint
    }
  }

  const fallbackList = DEFAULT_PAIRS.map((p) => {
    const c = generateFallbackCandles(p.symbol, '15m', 3);
    const last = c[c.length - 1];
    return {
      symbol: p.symbol,
      lastPrice: last.close,
      priceChangePercent: 1.25,
      quoteVolume: 100_000_000
    };
  });
  return { data: fallbackList, source: 'simulated', fetchedAt: Date.now() };
}

async function fetchCandlesFast(symbol: string, interval: string, useSpotFallback: boolean): Promise<{ candles: RawCandle[]; source: string }> {
  const urls = useSpotFallback
    ? [
        { url: `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=90`, source: 'binance-spot' },
        { url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=90`, source: 'binance-futures' }
      ]
    : [
        { url: `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=90`, source: 'binance-futures' },
        { url: `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=90`, source: 'binance-spot' }
      ];

  for (const u of urls) {
    try {
      const r = await fetchWithTimeout(u.url, 4500);
      if (r.ok) {
        const raw = (await r.json()) as Array<Array<string | number>>;
        if (Array.isArray(raw) && raw.length >= 20) {
          return {
            source: u.source,
            candles: raw.map((k) => ({
              openTime: Number(k[0]),
              open: Number(k[1]),
              high: Number(k[2]),
              low: Number(k[3]),
              close: Number(k[4]),
              volume: Number(k[5]),
              closeTime: Number(k[6])
            }))
          };
        }
      }
    } catch {
      // Next
    }
  }
  return { source: 'simulated', candles: generateFallbackCandles(symbol, interval, 90) };
}

app.get('/api/binance/scanner', async (req, res) => {
  const intervalParam = String(req.query.interval || '15m');
  const rsiPeriod = Math.min(50, Math.max(2, Number(req.query.rsiPeriod || 14)));
  const overbought = Math.min(99, Math.max(50, Number(req.query.overbought || 80)));
  const oversold = Math.min(50, Math.max(1, Number(req.query.oversold || 22)));
  const forceRefresh = req.query.refresh === '1';

  const allowedIntervals = new Set(['1m', '3m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d', '1w']);
  const isMulti = intervalParam === 'MULTI';
  const targetIntervals = isMulti
    ? [...ALL_1M_TO_1D_INTERVALS]
    : [allowedIntervals.has(intervalParam) ? intervalParam : '15m'];

  const cacheKey = `${intervalParam}_${rsiPeriod}_${overbought}_${oversold}`;
  const cached = scannerCache.get(cacheKey);
  if (!forceRefresh && cached && Date.now() - cached.fetchedAt < 35_000) {
    res.json({
      interval: intervalParam,
      source: cached.source,
      scannedAt: cached.fetchedAt,
      items: cached.items
    });
    return;
  }

  try {
    const top = await getTopLiquidPairs();
    const pairsToScan = isMulti ? top.data.slice(0, 15) : top.data.slice(0, 45);
    const useSpot = top.source === 'binance-spot';

    const tasks: Array<{
      ticker: { symbol: string; lastPrice: number; priceChangePercent: number; quoteVolume: number };
      tf: string;
    }> = [];
    for (const tf of targetIntervals) {
      for (const tk of pairsToScan) {
        tasks.push({ ticker: tk, tf });
      }
    }

    const items: ScannerEntry[] = [];
    let resolvedSource = top.source;
    const batchSize = 25;

    for (let i = 0; i < tasks.length; i += batchSize) {
      const batch = tasks.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(async ({ ticker: tk, tf }) => {
          const { candles, source } = await fetchCandlesFast(tk.symbol, tf, useSpot);
          if (source !== 'simulated') resolvedSource = source;
          const stats = computeLatestHaAndRsi(candles, rsiPeriod);
          const effectiveRsi = stats.liveRsi;

          let zone: ScannerEntry['zone'] = 'NEUTRAL';
          if (effectiveRsi >= overbought || stats.closedRsi >= overbought) {
            zone = 'OVERBOUGHT';
          } else if (effectiveRsi <= oversold || stats.closedRsi <= oversold) {
            zone = 'OVERSOLD';
          } else if (effectiveRsi >= overbought - 8) {
            zone = 'NEAR_OB';
          } else if (effectiveRsi <= oversold + 8) {
            zone = 'NEAR_OS';
          }

          let armedSignal: ScannerEntry['armedSignal'] = 'NONE';
          if (zone === 'OVERBOUGHT' && stats.haColor === 'GREEN') {
            armedSignal = 'SELL_WATCH';
          } else if (zone === 'OVERSOLD' && stats.haColor === 'RED') {
            armedSignal = 'BUY_WATCH';
          }

          return {
            symbol: tk.symbol,
            interval: tf,
            price: stats.lastPrice || tk.lastPrice,
            priceChangePercent: tk.priceChangePercent,
            quoteVolume: tk.quoteVolume,
            rsi: effectiveRsi,
            closedRsi: stats.closedRsi,
            haColor: stats.haColor,
            zone,
            armedSignal
          };
        })
      );
      items.push(...batchResults);
    }

    // Prioritize strict OVERBOUGHT (>=80) and OVERSOLD (<=22) hits at top, then closest to threshold
    items.sort((a, b) => {
      const rank = (z: ScannerEntry['zone']) =>
        z === 'OVERBOUGHT' || z === 'OVERSOLD'
          ? 0
          : z === 'NEAR_OB' || z === 'NEAR_OS'
            ? 1
            : 2;
      const rDiff = rank(a.zone) - rank(b.zone);
      if (rDiff !== 0) return rDiff;
      const distA = Math.min(Math.abs(overbought - a.rsi), Math.abs(a.rsi - oversold));
      const distB = Math.min(Math.abs(overbought - b.rsi), Math.abs(b.rsi - oversold));
      return distA - distB;
    });

    const now = Date.now();
    scannerCache.set(cacheKey, { items, source: resolvedSource, fetchedAt: now });
    res.json({
      interval: intervalParam,
      source: resolvedSource,
      scannedAt: now,
      items
    });
  } catch {
    res.status(500).json({ error: 'Scanner failed', items: [] });
  }
});

app.get('/api/binance/pair-rsi', async (req, res) => {
  const symbol = String(req.query.symbol || 'BTCUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const rsiPeriod = Math.min(50, Math.max(2, Number(req.query.rsiPeriod || 14)));
  const cacheKey = `${symbol}_${rsiPeriod}`;
  const cached = pairRsiCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < 10_000) {
    res.json({ symbol, rsiPeriod, fetchedAt: cached.fetchedAt, timeframes: cached.timeframes });
    return;
  }

  try {
    const timeframes = await Promise.all(
      ALL_1M_TO_1D_INTERVALS.map(async (tf) => {
        const { candles } = await fetchCandlesFast(symbol, tf, false);
        const stats = computeLatestHaAndRsi(candles, rsiPeriod);
        return {
          interval: tf,
          liveRsi: stats.liveRsi,
          closedRsi: stats.closedRsi,
          haColor: stats.haColor
        };
      })
    );
    const fetchedAt = Date.now();
    pairRsiCache.set(cacheKey, { fetchedAt, timeframes });
    res.json({ symbol, rsiPeriod, fetchedAt, timeframes });
  } catch {
    res.status(500).json({ error: 'Failed to compute pair multi-timeframe RSI', timeframes: [] });
  }
});

app.post('/api/binance/verify', async (req, res) => {
  const { apiKey, apiSecret, testnet } = req.body as {
    apiKey?: string;
    apiSecret?: string;
    testnet?: boolean;
  };

  const cleanKey = (apiKey || '').trim();
  const cleanSecret = (apiSecret || '').trim();
  if (!cleanKey || !cleanSecret) {
    res.status(400).json({ ok: false, error: 'API Key and Secret are required' });
    return;
  }

  const useTestnet = testnet !== false;
  const baseUrl = useTestnet ? 'https://testnet.binancefuture.com' : 'https://fapi.binance.com';

  try {
    const params = new URLSearchParams({
      recvWindow: '5000',
      timestamp: String(Date.now())
    });
    const sig = crypto.createHmac('sha256', cleanSecret).update(params.toString()).digest('hex');
    const balRes = await fetch(`${baseUrl}/fapi/v2/balance?${params.toString()}&signature=${sig}`, {
      method: 'GET',
      headers: {
        'X-MBX-APIKEY': cleanKey,
        'User-Agent': 'HeikinPulse/1.0'
      }
    });
    const data = await balRes.json() as
      | Array<{ asset: string; balance: string; availableBalance: string }>
      | { code?: number; msg?: string };

    if (!balRes.ok || !Array.isArray(data)) {
      const errMsg = !Array.isArray(data) && data?.msg ? data.msg : `Binance returned HTTP ${balRes.status}`;
      res.status(balRes.status >= 400 ? balRes.status : 400).json({ ok: false, error: errMsg });
      return;
    }

    const usdt = data.find((b) => b.asset === 'USDT');
    res.json({
      ok: true,
      network: useTestnet ? 'binance-futures-testnet' : 'binance-futures-live',
      usdtBalance: usdt ? Number(usdt.balance) : 0,
      availableBalance: usdt ? Number(usdt.availableBalance) : 0
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error instanceof Error ? error.message : 'Unable to reach Binance API'
    });
  }
});

app.post('/api/binance/order', async (req, res) => {
  const { symbol, side, quantity, leverage, marginType, apiKey, apiSecret, testnet, reduceOnly } = req.body as {
    symbol?: string;
    side?: 'BUY' | 'SELL';
    quantity?: number;
    leverage?: number;
    marginType?: 'ISOLATED' | 'CROSSED';
    apiKey?: string;
    apiSecret?: string;
    testnet?: boolean;
    reduceOnly?: boolean;
  };

  if (!symbol || !side || !quantity) {
    res.status(400).json({ error: 'Missing required order parameters' });
    return;
  }

  const result = await executeBinanceOrderInternal({
    symbol,
    side,
    quantity,
    leverage,
    marginType,
    apiKey,
    apiSecret,
    testnet,
    reduceOnly
  });
  if (result.executedOn === 'paper-live-market') {
    res.json({
      executedOn: 'paper-live-market',
      symbol,
      side,
      quantity,
      leverage: leverage || 10,
      marginType: marginType || 'ISOLATED',
      timestamp: Date.now()
    });
    return;
  }
  if (result.executedOn === 'error') {
    res.status(502).json({ error: result.error });
    return;
  }
  res.status(result.status).json({
    ok: result.ok,
    executedOn: result.executedOn,
    formattedQuantity: result.formattedQuantity,
    order: result.order
  });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa'
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`HeikinPulse server running on http://0.0.0.0:${PORT}`);
    botEngine.start();
  });
}

startServer();
