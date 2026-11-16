export type Timeframe =
  | '1m'
  | '3m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '2h'
  | '4h'
  | '6h'
  | '12h'
  | '1d'
  | '1w';

export type Language = 'en' | 'si';
export type MarginMode = 'ISOLATED' | 'CROSSED';
export type BoundaryMode = 'wick' | 'body';
export type TradeSide = 'BUY' | 'SELL';
export type TradeStatus = 'OPEN' | 'CLOSED';
export type CloseReason = 'NONE' | 'REVERSAL_SIGNAL' | 'MANUAL_CLOSE' | 'STOP_LOSS' | 'RSI_CLOSE';
export type SignalType = 'BUY' | 'SELL' | 'ARMED_SELL' | 'ARMED_BUY' | 'STOP_LOSS' | 'RSI_CLOSE';

export interface PairInfo {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  market: 'futures' | 'spot';
}

export interface RawCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  closeTime: number;
}

export interface HeikinAshiCandle extends RawCandle {
  haOpen: number;
  haHigh: number;
  haLow: number;
  haClose: number;
  isGreen: boolean;
  isRed: boolean;
  rsi: number | null;
}

export interface ChartSignalMarker {
  candleTimeMs: number;
  type: SignalType;
  price: number;
  haOpen: number;
  haHigh: number;
  haLow: number;
  haClose: number;
  rsi: number;
  referenceLevel: number;
  stopLossPrice?: number;
  note: string;
}

export interface StrategyConfig {
  pair: string;
  timeframe: Timeframe;
  leverage: number;
  marginUsdt: number;
  marginMode: MarginMode;
  boundaryMode: BoundaryMode;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  buyCloseRsiEnabled?: boolean;
  buyCloseRsi?: number;
  sellCloseRsiEnabled?: boolean;
  sellCloseRsi?: number;
  stopLossEnabled: boolean;
}

export interface UserBotProfile {
  userId: string;
  displayName: string;
  email: string;
  language: Language;
  selectedPair: string;
  timeframe: Timeframe;
  leverage: number;
  marginUsdt: number;
  marginMode: MarginMode;
  boundaryMode: BoundaryMode;
  rsiPeriod: number;
  rsiOverbought: number;
  rsiOversold: number;
  buyCloseRsiEnabled?: boolean;
  buyCloseRsi?: number;
  sellCloseRsiEnabled?: boolean;
  sellCloseRsi?: number;
  botActive: boolean;
  stopLossEnabled?: boolean;
  paperBalanceUsdt: number;
  lastEvaluatedTime: number;
  armedSellRef: number;
  armedBuyRef: number;
  armedSellWick?: number;
  armedBuyWick?: number;
  armedSellCandleTime: number;
  armedBuyCandleTime: number;
  slReentrySide?: TradeSide | 'NONE';
  slReentryPrice?: number;
  slReentryStopLoss?: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface TradeRecord {
  id: string;
  ownerId: string;
  pair: string;
  timeframe: Timeframe;
  side: TradeSide;
  status: TradeStatus;
  entryPrice: number;
  exitPrice: number;
  stopLossPrice?: number;
  leverage: number;
  marginUsdt: number;
  quantity: number;
  realizedPnl: number;
  realizedRoiPct: number;
  entryRsi: number;
  exitRsi: number;
  closeReason: CloseReason;
  openedAtMs: number;
  closedAtMs: number;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface SignalRecord {
  id: string;
  ownerId: string;
  pair: string;
  timeframe: Timeframe;
  signalType: SignalType;
  candleTimeMs: number;
  price: number;
  haOpen: number;
  haHigh: number;
  haLow: number;
  haClose: number;
  rsi: number;
  referenceLevel: number;
  executed: boolean;
  note: string;
  createdAt?: unknown;
}

export interface TickerInfo {
  symbol: string;
  source: string;
  lastPrice: number;
  priceChangePercent: number;
  highPrice: number;
  lowPrice: number;
  quoteVolume: number;
}

export interface EncryptedBinanceCredentialsDoc {
  ownerId: string;
  encryptedKey: string;
  encryptedSecret: string;
  keyPreview: string;
  testnet: boolean;
  enabled: boolean;
  createdAt?: unknown;
  updatedAt?: unknown;
}

export interface BinanceCredentialsState {
  hasKeys: boolean;
  apiKey: string;
  apiSecret: string;
  keyPreview: string;
  testnet: boolean;
  enabled: boolean;
}
