import type {
  BoundaryMode,
  ChartSignalMarker,
  HeikinAshiCandle,
  RawCandle,
  StrategyConfig,
  TradeSide
} from '../types/trading';

/**
 * Computes Heikin Ashi OHLC candles + Wilder's RSI from raw Binance candles.
 */
export function computeHeikinAshiAndRsi(
  rawCandles: RawCandle[],
  rsiPeriod = 14
): HeikinAshiCandle[] {
  if (rawCandles.length === 0) return [];

  const result: HeikinAshiCandle[] = [];
  const gains: number[] = [];
  const losses: number[] = [];
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 0; i < rawCandles.length; i++) {
    const c = rawCandles[i];
    const haClose = (c.open + c.high + c.low + c.close) / 4;
    const haOpen =
      i === 0
        ? (c.open + c.close) / 2
        : (result[i - 1].haOpen + result[i - 1].haClose) / 2;
    const haHigh = Math.max(c.high, haOpen, haClose);
    const haLow = Math.min(c.low, haOpen, haClose);

    let rsi: number | null = null;
    if (i > 0) {
      const change = c.close - rawCandles[i - 1].close;
      const gain = change > 0 ? change : 0;
      const loss = change < 0 ? -change : 0;
      gains.push(gain);
      losses.push(loss);

      if (i === rsiPeriod) {
        avgGain = gains.reduce((acc, v) => acc + v, 0) / rsiPeriod;
        avgLoss = losses.reduce((acc, v) => acc + v, 0) / rsiPeriod;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
      } else if (i > rsiPeriod) {
        avgGain = (avgGain * (rsiPeriod - 1) + gain) / rsiPeriod;
        avgLoss = (avgLoss * (rsiPeriod - 1) + loss) / rsiPeriod;
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
      }
    }

    result.push({
      ...c,
      haOpen,
      haHigh,
      haLow,
      haClose,
      isGreen: haClose > haOpen,
      isRed: haClose < haOpen,
      rsi: rsi !== null ? Number(rsi.toFixed(2)) : null
    });
  }

  return result;
}

export interface StrategyState {
  armedSellRef: number; // Green HA bottom watched after RSI > 80
  armedBuyRef: number; // Red HA top watched after RSI < 22
  armedSellWick: number; // Peak high wick of green HA candle(s) that passed RSI > 80 (Stop-Loss for SELL)
  armedBuyWick: number; // Lowest low wick of red HA candle(s) that passed RSI < 22 (Stop-Loss for BUY)
  armedSellCandleTime: number;
  armedBuyCandleTime: number;
  openSide: TradeSide | null;
  openEntryPrice: number;
  activeStopLoss: number; // Stop-loss level for the currently open trade
  slReentrySide: TradeSide | null; // Side of trade stopped out by SL, waiting for HA body re-entry
  slReentryPrice: number; // Previous trade entry price to cross for re-entry
  slReentryStopLoss: number; // Stop-Loss price level for SL cross watch & re-entry SL
  lastHaClose?: number; // Previous closed candle's haClose for strict level-cross detection
}

export interface EvaluationStepResult {
  nextState: StrategyState;
  events: Array<{
    type: 'ARMED_SELL' | 'ARMED_BUY' | 'SELL' | 'BUY' | 'STOP_LOSS' | 'RSI_CLOSE';
    candle: HeikinAshiCandle;
    rsi: number;
    referenceLevel: number;
    stopLossPrice?: number;
    execPrice: number;
    closeOppositeSide: TradeSide | null;
    note: string;
  }>;
}

export function getGreenCandleBottom(candle: HeikinAshiCandle, mode: BoundaryMode): number {
  return mode === 'wick' ? candle.haLow : candle.haOpen;
}

export function getRedCandleTop(candle: HeikinAshiCandle, mode: BoundaryMode): number {
  return mode === 'wick' ? candle.haHigh : candle.haOpen;
}

/**
 * Evaluates a single CLOSED Heikin Ashi candle against the user's exact rules:
 * 1) STOP-LOSS:
 *    - If an open SELL trade has activeStopLoss > 0 and price passes above that wick (candle.high > activeStopLoss):
 *      close SELL immediately at activeStopLoss (STOP_LOSS).
 *    - If an open BUY trade has activeStopLoss > 0 and price passes below that wick (candle.low < activeStopLoss):
 *      close BUY immediately at activeStopLoss (STOP_LOSS).
 * 2) SELL:
 *    - Green HA candle closes with RSI > overbought (80): arm sell watch with green candle bottom & record its upper wick (haHigh).
 *    - While sell watch is armed, when a Red HA candle body closes below that green candle's bottom:
 *      close any open BUY trade and open a SELL trade with stopLossPrice = armedSellWick.
 * 3) BUY:
 *    - Red HA candle closes with RSI < oversold (22): arm buy watch with red candle top & record its lower wick (haLow).
 *    - While buy watch is armed, when a Green HA candle body closes above that red candle's top:
 *      close any open SELL trade and open a BUY trade with stopLossPrice = armedBuyWick.
 */
export function evaluateClosedCandle(
  candle: HeikinAshiCandle,
  state: StrategyState,
  config: Pick<
    StrategyConfig,
    | 'boundaryMode'
    | 'rsiOverbought'
    | 'rsiOversold'
    | 'stopLossEnabled'
    | 'buyCloseRsiEnabled'
    | 'buyCloseRsi'
    | 'sellCloseRsiEnabled'
    | 'sellCloseRsi'
  >
): EvaluationStepResult {
  const nextState: StrategyState = { ...state };
  const events: EvaluationStepResult['events'] = [];

  if (candle.rsi === null) {
    nextState.lastHaClose = candle.haClose;
    return { nextState, events };
  }

  const prevHaClose = nextState.lastHaClose ?? 0;
  const rsi = candle.rsi;

  // Expire stale overbought/oversold watches if RSI cools all the way back past neutral 50
  if (nextState.armedSellRef > 0 && rsi <= 50) {
    nextState.armedSellRef = 0;
    nextState.armedSellWick = 0;
    nextState.armedSellCandleTime = 0;
  }
  if (nextState.armedBuyRef > 0 && rsi >= 50) {
    nextState.armedBuyRef = 0;
    nextState.armedBuyWick = 0;
    nextState.armedBuyCandleTime = 0;
  }

  // 1. Check Wick Stop-Loss on existing open trade first
  let slTriggeredThisBar = false;
  if (config.stopLossEnabled && nextState.openSide && nextState.activeStopLoss > 0) {
    const sl = nextState.activeStopLoss;
    if (nextState.openSide === 'SELL' && candle.high > sl) {
      const prevEntry = nextState.openEntryPrice > 0 ? nextState.openEntryPrice : sl;
      nextState.slReentrySide = 'SELL';
      nextState.slReentryPrice = prevEntry;
      nextState.slReentryStopLoss = sl;
      nextState.openSide = null;
      nextState.openEntryPrice = 0;
      nextState.activeStopLoss = 0;
      slTriggeredThisBar = true;
      events.push({
        type: 'STOP_LOSS',
        candle,
        rsi,
        referenceLevel: sl,
        execPrice: sl,
        closeOppositeSide: 'SELL',
        note: `Stop-Loss triggered on SELL: candle high (${candle.high.toFixed(4)}) passed RSI > ${config.rsiOverbought} wick (${sl.toFixed(4)}). Re-entry watch < ${prevEntry.toFixed(4)}`
      });
    } else if (nextState.openSide === 'BUY' && candle.low < sl) {
      const prevEntry = nextState.openEntryPrice > 0 ? nextState.openEntryPrice : sl;
      nextState.slReentrySide = 'BUY';
      nextState.slReentryPrice = prevEntry;
      nextState.slReentryStopLoss = sl;
      nextState.openSide = null;
      nextState.openEntryPrice = 0;
      nextState.activeStopLoss = 0;
      slTriggeredThisBar = true;
      events.push({
        type: 'STOP_LOSS',
        candle,
        rsi,
        referenceLevel: sl,
        execPrice: sl,
        closeOppositeSide: 'BUY',
        note: `Stop-Loss triggered on BUY: candle low (${candle.low.toFixed(4)}) passed RSI < ${config.rsiOversold} wick (${sl.toFixed(4)}). Re-entry watch > ${prevEntry.toFixed(4)}`
      });
    }
  }

  // 1b. Optional Close-RSI Exit (when enabled for BUY or SELL): close open position at target RSI
  // and leave nextState.openSide = null so the bot opens again on the very next signal.
  if (!slTriggeredThisBar && nextState.openSide) {
    const buyTarget = config.buyCloseRsi ?? 70;
    const sellTarget = config.sellCloseRsi ?? 30;
    if (nextState.openSide === 'BUY' && config.buyCloseRsiEnabled && rsi >= buyTarget) {
      nextState.openSide = null;
      nextState.openEntryPrice = 0;
      nextState.activeStopLoss = 0;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'RSI_CLOSE',
        candle,
        rsi,
        referenceLevel: buyTarget,
        execPrice: candle.close,
        closeOppositeSide: 'BUY',
        note: `BUY closed at Close RSI target: RSI (${rsi.toFixed(1)}) >= ${buyTarget}. Ready for next signal.`
      });
    } else if (nextState.openSide === 'SELL' && config.sellCloseRsiEnabled && rsi <= sellTarget) {
      nextState.openSide = null;
      nextState.openEntryPrice = 0;
      nextState.activeStopLoss = 0;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'RSI_CLOSE',
        candle,
        rsi,
        referenceLevel: sellTarget,
        execPrice: candle.close,
        closeOppositeSide: 'SELL',
        note: `SELL closed at Close RSI target: RSI (${rsi.toFixed(1)}) <= ${sellTarget}. Ready for next signal.`
      });
    }
  }

  // 2. Check SELL entry trigger if armed and current closed candle is RED
  if (
    nextState.armedSellRef > 0 &&
    candle.isRed &&
    candle.haClose < nextState.armedSellRef
  ) {
    const refLevel = nextState.armedSellRef;
    const slWick = Math.max(nextState.armedSellWick || 0, candle.haHigh);
    const prevSide = nextState.openSide;
    nextState.armedSellRef = 0;
    nextState.armedSellWick = 0;
    nextState.armedSellCandleTime = 0;

    if (prevSide !== 'SELL') {
      nextState.openSide = 'SELL';
      nextState.openEntryPrice = candle.close;
      nextState.activeStopLoss = config.stopLossEnabled ? slWick : 0;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'SELL',
        candle,
        rsi,
        referenceLevel: refLevel,
        stopLossPrice: config.stopLossEnabled ? slWick : 0,
        execPrice: candle.close,
        closeOppositeSide: prevSide === 'BUY' ? 'BUY' : null,
        note: `Red HA body (${candle.haClose.toFixed(4)}) closed below green bottom (${refLevel.toFixed(4)}). SL wick: ${slWick.toFixed(4)}`
      });
    }
  }

  // 3. Check BUY entry trigger if armed and current closed candle is GREEN
  if (
    nextState.armedBuyRef > 0 &&
    candle.isGreen &&
    candle.haClose > nextState.armedBuyRef
  ) {
    const refLevel = nextState.armedBuyRef;
    const slWick =
      nextState.armedBuyWick > 0
        ? Math.min(nextState.armedBuyWick, candle.haLow)
        : candle.haLow;
    const prevSide = nextState.openSide;
    nextState.armedBuyRef = 0;
    nextState.armedBuyWick = 0;
    nextState.armedBuyCandleTime = 0;

    if (prevSide !== 'BUY') {
      nextState.openSide = 'BUY';
      nextState.openEntryPrice = candle.close;
      nextState.activeStopLoss = config.stopLossEnabled ? slWick : 0;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'BUY',
        candle,
        rsi,
        referenceLevel: refLevel,
        stopLossPrice: config.stopLossEnabled ? slWick : 0,
        execPrice: candle.close,
        closeOppositeSide: prevSide === 'SELL' ? 'SELL' : null,
        note: `Green HA body (${candle.haClose.toFixed(4)}) closed above red top (${refLevel.toFixed(4)}). SL wick: ${slWick.toFixed(4)}`
      });
    }
  }

  // 3b. Stop-Loss Re-Entry: if stopped out by SL and no new signal opened, re-open same direction
  // when a closed Heikin Ashi candle body closes back across the previous trade's entry price
  if (
    !slTriggeredThisBar &&
    nextState.openSide === null &&
    nextState.slReentrySide !== null &&
    nextState.slReentryPrice > 0
  ) {
    const targetEntry = nextState.slReentryPrice;
    if (nextState.slReentrySide === 'SELL' && candle.isRed && candle.haClose < targetEntry) {
      const reEntrySl = config.stopLossEnabled
        ? Math.max(nextState.slReentryStopLoss || 0, candle.haHigh)
        : 0;
      nextState.openSide = 'SELL';
      nextState.openEntryPrice = candle.close;
      nextState.activeStopLoss = reEntrySl;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'SELL',
        candle,
        rsi,
        referenceLevel: targetEntry,
        stopLossPrice: reEntrySl,
        execPrice: candle.close,
        closeOppositeSide: null,
        note: `SL Re-Entry SELL: Red HA body (${candle.haClose.toFixed(4)}) closed below previous entry (${targetEntry.toFixed(4)})`
      });
    } else if (nextState.slReentrySide === 'BUY' && candle.isGreen && candle.haClose > targetEntry) {
      const reEntrySl = config.stopLossEnabled
        ? nextState.slReentryStopLoss > 0
          ? Math.min(nextState.slReentryStopLoss, candle.haLow)
          : candle.haLow
        : 0;
      nextState.openSide = 'BUY';
      nextState.openEntryPrice = candle.close;
      nextState.activeStopLoss = reEntrySl;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'BUY',
        candle,
        rsi,
        referenceLevel: targetEntry,
        stopLossPrice: reEntrySl,
        execPrice: candle.close,
        closeOppositeSide: null,
        note: `SL Re-Entry BUY: Green HA body (${candle.haClose.toFixed(4)}) closed above previous entry (${targetEntry.toFixed(4)})`
      });
    }
  }

  // 3c. Stop-Loss Boundary Cross Entry: after Stop-Loss hits, if the market moves up or down and
  // a closed Heikin Ashi candle body crosses the Stop-Loss level (slReentryStopLoss) again,
  // open a trade in that breakout/reversal direction (Green > SL -> BUY, Red < SL -> SELL).
  if (
    !slTriggeredThisBar &&
    nextState.openSide === null &&
    nextState.slReentrySide !== null &&
    nextState.slReentryStopLoss > 0
  ) {
    const slLevel = nextState.slReentryStopLoss;
    const crossedUp =
      prevHaClose > 0
        ? prevHaClose <= slLevel && candle.haClose > slLevel
        : candle.haOpen <= slLevel && candle.haClose > slLevel;
    const crossedDown =
      prevHaClose > 0
        ? prevHaClose >= slLevel && candle.haClose < slLevel
        : candle.haOpen >= slLevel && candle.haClose < slLevel;

    if (candle.isGreen && crossedUp) {
      const newSl = config.stopLossEnabled ? Math.min(candle.low, candle.haLow) : 0;
      nextState.openSide = 'BUY';
      nextState.openEntryPrice = candle.close;
      nextState.activeStopLoss = newSl;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'BUY',
        candle,
        rsi,
        referenceLevel: slLevel,
        stopLossPrice: newSl,
        execPrice: candle.close,
        closeOppositeSide: null,
        note: `SL Cross BUY: Green HA body (${candle.haClose.toFixed(4)}) closed above Stop level (${slLevel.toFixed(4)})`
      });
    } else if (candle.isRed && crossedDown) {
      const newSl = config.stopLossEnabled ? Math.max(candle.high, candle.haHigh) : 0;
      nextState.openSide = 'SELL';
      nextState.openEntryPrice = candle.close;
      nextState.activeStopLoss = newSl;
      nextState.slReentrySide = null;
      nextState.slReentryPrice = 0;
      nextState.slReentryStopLoss = 0;
      events.push({
        type: 'SELL',
        candle,
        rsi,
        referenceLevel: slLevel,
        stopLossPrice: newSl,
        execPrice: candle.close,
        closeOppositeSide: null,
        note: `SL Cross SELL: Red HA body (${candle.haClose.toFixed(4)}) closed below Stop level (${slLevel.toFixed(4)})`
      });
    }
  }

  // 4. Arm SELL watch if Green HA candle has RSI > overbought (80)
  if (candle.isGreen && rsi > config.rsiOverbought) {
    const bottom = getGreenCandleBottom(candle, config.boundaryMode);
    const topWick = Math.max(candle.high, candle.haHigh);
    const newlyArmed = nextState.armedSellRef === 0;
    nextState.armedSellRef = bottom;
    nextState.armedSellWick =
      nextState.armedSellWick > 0 ? Math.max(nextState.armedSellWick, topWick) : topWick;
    nextState.armedSellCandleTime = candle.openTime;
    if (newlyArmed) {
      events.push({
        type: 'ARMED_SELL',
        candle,
        rsi,
        referenceLevel: bottom,
        stopLossPrice: nextState.armedSellWick,
        execPrice: candle.close,
        closeOppositeSide: null,
        note: `Green HA RSI ${rsi.toFixed(1)} > ${config.rsiOverbought}: watching bottom ${bottom.toFixed(4)} (SL wick ${nextState.armedSellWick.toFixed(4)})`
      });
    }
  }

  // 5. Arm BUY watch if Red HA candle has RSI < oversold (22)
  if (candle.isRed && rsi < config.rsiOversold) {
    const top = getRedCandleTop(candle, config.boundaryMode);
    const lowWick = Math.min(candle.low, candle.haLow);
    const newlyArmed = nextState.armedBuyRef === 0;
    nextState.armedBuyRef = top;
    nextState.armedBuyWick =
      nextState.armedBuyWick > 0 ? Math.min(nextState.armedBuyWick, lowWick) : lowWick;
    nextState.armedBuyCandleTime = candle.openTime;
    if (newlyArmed) {
      events.push({
        type: 'ARMED_BUY',
        candle,
        rsi,
        referenceLevel: top,
        stopLossPrice: nextState.armedBuyWick,
        execPrice: candle.close,
        closeOppositeSide: null,
        note: `Red HA RSI ${rsi.toFixed(1)} < ${config.rsiOversold}: watching top ${top.toFixed(4)} (SL wick ${nextState.armedBuyWick.toFixed(4)})`
      });
    }
  }

  nextState.lastHaClose = candle.haClose;
  return { nextState, events };
}

/**
 * Scans all closed candles in the array to generate chart markers and current armed state.
 */
export function scanHistoricalSignals(
  haCandles: HeikinAshiCandle[],
  config: Pick<
    StrategyConfig,
    | 'boundaryMode'
    | 'rsiOverbought'
    | 'rsiOversold'
    | 'stopLossEnabled'
    | 'buyCloseRsiEnabled'
    | 'buyCloseRsi'
    | 'sellCloseRsiEnabled'
    | 'sellCloseRsi'
  >
): { markers: ChartSignalMarker[]; finalState: StrategyState } {
  let state: StrategyState = {
    armedSellRef: 0,
    armedBuyRef: 0,
    armedSellWick: 0,
    armedBuyWick: 0,
    armedSellCandleTime: 0,
    armedBuyCandleTime: 0,
    openSide: null,
    openEntryPrice: 0,
    activeStopLoss: 0,
    slReentrySide: null,
    slReentryPrice: 0,
    slReentryStopLoss: 0
  };
  const markers: ChartSignalMarker[] = [];

  const closedCount = Math.max(0, haCandles.length - 1);
  for (let i = 0; i < closedCount; i++) {
    const candle = haCandles[i];
    const { nextState, events } = evaluateClosedCandle(candle, state, config);
    state = nextState;
    for (const ev of events) {
      markers.push({
        candleTimeMs: candle.openTime,
        type: ev.type,
        price: ev.execPrice,
        haOpen: candle.haOpen,
        haHigh: candle.haHigh,
        haLow: candle.haLow,
        haClose: candle.haClose,
        rsi: ev.rsi,
        referenceLevel: ev.referenceLevel,
        stopLossPrice: ev.stopLossPrice,
        note: ev.note
      });
    }
  }

  return { markers, finalState: state };
}

export function calculateUnrealizedPnl(
  side: TradeSide,
  entryPrice: number,
  markPrice: number,
  quantity: number,
  marginUsdt: number
): { pnl: number; roiPct: number } {
  if (entryPrice <= 0 || quantity <= 0 || marginUsdt <= 0) {
    return { pnl: 0, roiPct: 0 };
  }
  const pnl =
    side === 'BUY'
      ? (markPrice - entryPrice) * quantity
      : (entryPrice - markPrice) * quantity;
  const roiPct = (pnl / marginUsdt) * 100;
  return { pnl, roiPct };
}
