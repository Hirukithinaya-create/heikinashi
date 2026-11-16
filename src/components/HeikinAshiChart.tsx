import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Maximize2, Move, ZoomIn, ZoomOut } from 'lucide-react';
import type {
  ChartSignalMarker,
  HeikinAshiCandle,
  TradeRecord
} from '../types/trading';

interface HeikinAshiChartProps {
  candles: HeikinAshiCandle[];
  markers: ChartSignalMarker[];
  pair: string;
  timeframe: string;
  armedSellRef: number;
  armedBuyRef: number;
  slReentrySide?: 'BUY' | 'SELL' | 'NONE';
  slReentryPrice?: number;
  slReentryStopLoss?: number;
  rsiPeriod?: number;
  rsiOverbought: number;
  rsiOversold: number;
  buyCloseRsiEnabled?: boolean;
  buyCloseRsi?: number;
  sellCloseRsiEnabled?: boolean;
  sellCloseRsi?: number;
  openTrade: TradeRecord | null;
  autoFitLabel: string;
  hintLabel: string;
}

function formatPrice(val: number): string {
  if (!Number.isFinite(val)) return '0.00';
  if (val >= 1000) return val.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

function formatTime(ms: number, timeframe: string): string {
  const d = new Date(ms);
  if (timeframe === '1d' || timeframe === '1w') {
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export const HeikinAshiChart: React.FC<HeikinAshiChartProps> = ({
  candles,
  markers,
  pair,
  timeframe,
  armedSellRef,
  armedBuyRef,
  slReentrySide = 'NONE',
  slReentryPrice = 0,
  slReentryStopLoss = 0,
  rsiPeriod = 14,
  rsiOverbought,
  rsiOversold,
  buyCloseRsiEnabled = false,
  buyCloseRsi = 70,
  sellCloseRsiEnabled = false,
  sellCloseRsi = 30,
  openTrade,
  autoFitLabel,
  hintLabel
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Viewport state:
  // rightOffset: number of candle widths shifted right from the last candle (positive = blank space on right, negative = scrolled back in history)
  // candleWidth: pixels per candle slot (zoom X)
  // yPanNormalized: vertical pan offset in normalized price-range units (0 = auto centered)
  // yZoom: vertical price zoom factor (1 = auto fit)
  const [view, setView] = useState({
    rightOffset: 4,
    candleWidth: 10,
    yPanPrice: 0,
    yZoom: 1,
    autoY: true
  });

  const [hoverInfo, setHoverInfo] = useState<{
    candle: HeikinAshiCandle;
    marker?: ChartSignalMarker;
    x: number;
    y: number;
  } | null>(null);

  const dragRef = useRef<{
    active: boolean;
    mode: 'pan' | 'yscale';
    startX: number;
    startY: number;
    startRightOffset: number;
    startYPanPrice: number;
    startYZoom: number;
    pricePerPixel: number;
  }>({
    active: false,
    mode: 'pan',
    startX: 0,
    startY: 0,
    startRightOffset: 4,
    startYPanPrice: 0,
    startYZoom: 1,
    pricePerPixel: 1
  });

  const pinchRef = useRef<{
    active: boolean;
    startDist: number;
    startCandleWidth: number;
    midX: number;
    startRightOffset: number;
  }>({
    active: false,
    startDist: 0,
    startCandleWidth: 10,
    midX: 0,
    startRightOffset: 4
  });

  const priceScaleRef = useRef<{ min: number; max: number; plotHeight: number }>({
    min: 0,
    max: 1,
    plotHeight: 300
  });

  const resetView = useCallback(() => {
    setView({
      rightOffset: 4,
      candleWidth: window.innerWidth < 768 ? 8 : 10,
      yPanPrice: 0,
      yZoom: 1,
      autoY: true
    });
  }, []);

  const zoomBy = useCallback((factor: number) => {
    setView((prev) => ({
      ...prev,
      candleWidth: Math.min(38, Math.max(3, prev.candleWidth * factor))
    }));
  }, []);

  // Reset horizontal offset cleanly when switching pair/timeframe
  useEffect(() => {
    resetView();
  }, [pair, timeframe, resetView]);

  // Draw canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const render = () => {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;

      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(rect.width * dpr);
      canvas.height = Math.floor(rect.height * dpr);
      canvas.style.width = `${rect.width}px`;
      canvas.style.height = `${rect.height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const width = rect.width;
      const height = rect.height;
      const axisRightWidth = width < 640 ? 64 : 78;
      const axisBottomHeight = 24;
      const plotWidth = Math.max(100, width - axisRightWidth);
      const usableHeight = Math.max(180, height - axisBottomHeight);
      const priceHeight = Math.floor(usableHeight * 0.72);
      const rsiTop = priceHeight + 8;
      const rsiHeight = Math.max(56, usableHeight - rsiTop);

      // Background
      ctx.fillStyle = '#0B101B';
      ctx.fillRect(0, 0, width, height);

      if (candles.length === 0) {
        ctx.fillStyle = '#64748B';
        ctx.font = '13px "Plus Jakarta Sans", sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('Loading Binance Heikin Ashi market feed...', plotWidth / 2, priceHeight / 2);
        return;
      }

      // Compute visible candle indices
      const cw = view.candleWidth;
      const total = candles.length;
      const maxVisible = Math.ceil(plotWidth / cw) + 2;
      const rightEdgeIndex = total - 1 + view.rightOffset;
      const startIndex = Math.max(0, Math.floor(rightEdgeIndex - maxVisible));
      const endIndex = Math.min(total - 1, Math.ceil(rightEdgeIndex));

      const indexToX = (idx: number) => plotWidth - (rightEdgeIndex - idx + 0.5) * cw;

      // Compute price range from visible candles (or fallback to last 60)
      let minP = Infinity;
      let maxP = -Infinity;
      for (let i = startIndex; i <= endIndex; i++) {
        const c = candles[i];
        if (!c) continue;
        if (c.haLow < minP) minP = c.haLow;
        if (c.haHigh > maxP) maxP = c.haHigh;
      }
      if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
        const slice = candles.slice(-60);
        minP = Math.min(...slice.map((c) => c.haLow));
        maxP = Math.max(...slice.map((c) => c.haHigh));
      }
      if (minP === maxP) {
        minP *= 0.99;
        maxP *= 1.01;
      }

      const baseSpan = (maxP - minP) * 1.18;
      const centerP = (maxP + minP) / 2;
      const zoomedSpan = baseSpan / view.yZoom;
      const viewCenter = view.autoY ? centerP : centerP + view.yPanPrice;
      const viewMin = viewCenter - zoomedSpan / 2;
      const viewMax = viewCenter + zoomedSpan / 2;

      priceScaleRef.current = {
        min: viewMin,
        max: viewMax,
        plotHeight: priceHeight
      };

      const priceToY = (p: number) =>
        10 + ((viewMax - p) / (viewMax - viewMin)) * (priceHeight - 20);

      // Grid lines (Price pane)
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.08)';
      ctx.lineWidth = 1;
      const priceTicks = 5;
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      for (let t = 0; t <= priceTicks; t++) {
        const ratio = t / priceTicks;
        const pVal = viewMax - ratio * (viewMax - viewMin);
        const y = Math.round(10 + ratio * (priceHeight - 20)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();

        ctx.fillStyle = '#64748B';
        ctx.fillText(formatPrice(pVal), plotWidth + 6, y + 4);
      }

      // Vertical time grid
      const labelStep = Math.max(4, Math.floor(85 / cw));
      for (let i = startIndex; i <= endIndex; i++) {
        if (i % labelStep !== 0) continue;
        const x = Math.round(indexToX(i)) + 0.5;
        if (x < 10 || x > plotWidth - 20) continue;
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.06)';
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, usableHeight);
        ctx.stroke();

        ctx.fillStyle = '#64748B';
        ctx.textAlign = 'center';
        ctx.fillText(formatTime(candles[i].openTime, timeframe), x, usableHeight + 16);
      }

      // Clip price pane so vertical free-pan never bleeds into RSI pane
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, plotWidth, priceHeight);
      ctx.clip();

      // Armed reference lines
      if (armedSellRef > 0 && armedSellRef >= viewMin * 0.5 && armedSellRef <= viewMax * 1.5) {
        const y = priceToY(armedSellRef);
        ctx.strokeStyle = 'rgba(239, 68, 68, 0.78)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#FCA5A5';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`SELL ARM < ${formatPrice(armedSellRef)}`, 8, y - 5);
      }

      if (armedBuyRef > 0 && armedBuyRef >= viewMin * 0.5 && armedBuyRef <= viewMax * 1.5) {
        const y = priceToY(armedBuyRef);
        ctx.strokeStyle = 'rgba(16, 185, 129, 0.78)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#6EE7B7';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`BUY ARM > ${formatPrice(armedBuyRef)}`, 8, y - 5);
      }

      if (
        slReentrySide &&
        slReentrySide !== 'NONE' &&
        slReentryPrice > 0 &&
        slReentryPrice >= viewMin * 0.5 &&
        slReentryPrice <= viewMax * 1.5
      ) {
        const y = priceToY(slReentryPrice);
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.85)';
        ctx.setLineDash([6, 3]);
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#7DD3FC';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(
          `SL RE-ENTRY ${slReentrySide} ${slReentrySide === 'SELL' ? '<' : '>'} ${formatPrice(slReentryPrice)}`,
          8,
          y - 5
        );
      }

      if (
        slReentrySide &&
        slReentrySide !== 'NONE' &&
        slReentryStopLoss > 0 &&
        slReentryStopLoss >= viewMin * 0.5 &&
        slReentryStopLoss <= viewMax * 1.5
      ) {
        const slCrossY = priceToY(slReentryStopLoss);
        ctx.strokeStyle = 'rgba(245, 158, 11, 0.85)';
        ctx.setLineDash([5, 4]);
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(0, slCrossY);
        ctx.lineTo(plotWidth, slCrossY);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#FCD34D';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(
          `SL CROSS (↑BUY / ↓SELL) ${formatPrice(slReentryStopLoss)}`,
          8,
          slCrossY + 12
        );
      }

      // Open Position entry line & Stop-Loss line
      if (openTrade && openTrade.pair === pair) {
        const y = priceToY(openTrade.entryPrice);
        ctx.strokeStyle = openTrade.side === 'BUY' ? '#10B981' : '#EF4444';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(plotWidth, y);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = openTrade.side === 'BUY' ? '#10B981' : '#EF4444';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(
          `${openTrade.side} ENTRY ${formatPrice(openTrade.entryPrice)}`,
          8,
          y + 12
        );

        if (openTrade.stopLossPrice && openTrade.stopLossPrice > 0) {
          const slY = priceToY(openTrade.stopLossPrice);
          ctx.strokeStyle = '#F59E0B';
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1.3;
          ctx.beginPath();
          ctx.moveTo(0, slY);
          ctx.lineTo(plotWidth, slY);
          ctx.stroke();
          ctx.setLineDash([]);
          ctx.fillStyle = '#FBBF24';
          ctx.font = '600 10px "JetBrains Mono", monospace';
          ctx.fillText(`SL WICK ${formatPrice(openTrade.stopLossPrice)}`, 8, slY - 5);
        }
      }

      // Index markers by candleTimeMs for quick lookup
      const markerMap = new Map<number, ChartSignalMarker[]>();
      for (const m of markers) {
        const list = markerMap.get(m.candleTimeMs) || [];
        list.push(m);
        markerMap.set(m.candleTimeMs, list);
      }

      // Draw Heikin Ashi Candlesticks
      const bodyW = Math.max(2, Math.floor(cw * 0.68));
      for (let i = startIndex; i <= endIndex; i++) {
        const c = candles[i];
        const x = indexToX(i);
        if (x < -cw || x > plotWidth + cw) continue;

        const yHigh = priceToY(c.haHigh);
        const yLow = priceToY(c.haLow);
        const yOpen = priceToY(c.haOpen);
        const yClose = priceToY(c.haClose);

        const bull = c.haClose >= c.haOpen;
        const color = bull ? '#10B981' : '#EF4444';
        ctx.strokeStyle = color;
        ctx.fillStyle = color;

        // Wick
        ctx.lineWidth = Math.max(1, Math.min(2, cw * 0.14));
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.stroke();

        // Body
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
        ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, bodyH);

        // Plot BUY / SELL / ARMED / STOP_LOSS markers on candle
        const barMarkers = markerMap.get(c.openTime);
        if (barMarkers) {
          for (const m of barMarkers) {
            if (m.type === 'BUY') {
              const my = yLow + 10;
              ctx.fillStyle = '#10B981';
              ctx.beginPath();
              ctx.moveTo(x, my - 6);
              ctx.lineTo(x - 5, my + 2);
              ctx.lineTo(x + 5, my + 2);
              ctx.closePath();
              ctx.fill();
              ctx.font = '600 10px "JetBrains Mono", monospace';
              ctx.textAlign = 'center';
              ctx.fillText('BUY', x, my + 13);
            } else if (m.type === 'SELL') {
              const my = yHigh - 10;
              ctx.fillStyle = '#EF4444';
              ctx.beginPath();
              ctx.moveTo(x, my + 6);
              ctx.lineTo(x - 5, my - 2);
              ctx.lineTo(x + 5, my - 2);
              ctx.closePath();
              ctx.fill();
              ctx.font = '600 10px "JetBrains Mono", monospace';
              ctx.textAlign = 'center';
              ctx.fillText('SELL', x, my - 6);
            } else if (m.type === 'STOP_LOSS') {
              ctx.fillStyle = '#F59E0B';
              ctx.font = '700 10px "JetBrains Mono", monospace';
              ctx.textAlign = 'center';
              ctx.fillText('SL', x, yHigh - 12);
            } else if (m.type === 'RSI_CLOSE') {
              ctx.fillStyle = '#22D3EE';
              ctx.font = '700 10px "JetBrains Mono", monospace';
              ctx.textAlign = 'center';
              ctx.fillText('RSI X', x, yHigh - 12);
            } else if (m.type === 'ARMED_SELL') {
              ctx.strokeStyle = '#F59E0B';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(x, yHigh - 6, 3, 0, Math.PI * 2);
              ctx.stroke();
            } else if (m.type === 'ARMED_BUY') {
              ctx.strokeStyle = '#38BDF8';
              ctx.lineWidth = 1.5;
              ctx.beginPath();
              ctx.arc(x, yLow + 6, 3, 0, Math.PI * 2);
              ctx.stroke();
            }
          }
        }
      }

      // Live current price dashed line
      const lastCandle = candles[candles.length - 1];
      const liveY = priceToY(lastCandle.close);
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
      ctx.setLineDash([2, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, liveY);
      ctx.lineTo(plotWidth, liveY);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();

      // Right axis badge for live price
      const clampedLiveY = Math.max(12, Math.min(priceHeight - 12, liveY));
      ctx.fillStyle = '#0284C7';
      ctx.fillRect(plotWidth + 2, clampedLiveY - 9, axisRightWidth - 6, 18);
      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(formatPrice(lastCandle.close), plotWidth + 6, clampedLiveY + 3.5);

      // Divider between Price and RSI panes
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, priceHeight + 3);
      ctx.lineTo(width, priceHeight + 3);
      ctx.stroke();

      // RSI Pane
      const rsiToY = (val: number) =>
        rsiTop + 6 + ((100 - Math.max(0, Math.min(100, val))) / 100) * (rsiHeight - 12);

      // Overbought (>80) & Oversold (<22) shaded zones
      const y80 = rsiToY(rsiOverbought);
      const y20 = rsiToY(rsiOversold);
      const y100 = rsiToY(100);
      const y0 = rsiToY(0);

      ctx.fillStyle = 'rgba(239, 68, 68, 0.09)';
      ctx.fillRect(0, y100, plotWidth, y80 - y100);
      ctx.fillStyle = 'rgba(16, 185, 129, 0.09)';
      ctx.fillRect(0, y20, plotWidth, y0 - y20);

      // RSI guide lines
      const guides = [
        { val: rsiOverbought, color: 'rgba(239, 68, 68, 0.5)' },
        ...(buyCloseRsiEnabled ? [{ val: buyCloseRsi, color: 'rgba(34, 211, 238, 0.65)' }] : []),
        { val: 50, color: 'rgba(148, 163, 184, 0.2)' },
        ...(sellCloseRsiEnabled ? [{ val: sellCloseRsi, color: 'rgba(34, 211, 238, 0.65)' }] : []),
        { val: rsiOversold, color: 'rgba(16, 185, 129, 0.5)' }
      ];
      for (const g of guides) {
        const gy = Math.round(rsiToY(g.val)) + 0.5;
        ctx.strokeStyle = g.color;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(0, gy);
        ctx.lineTo(plotWidth, gy);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = '#94A3B8';
        ctx.font = '10px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.fillText(String(g.val), plotWidth + 6, gy + 3);
      }

      // Plot RSI curve
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, rsiTop, plotWidth, rsiHeight);
      ctx.clip();
      ctx.strokeStyle = '#38BDF8';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = startIndex; i <= endIndex; i++) {
        const c = candles[i];
        if (c.rsi === null) continue;
        const x = indexToX(i);
        const y = rsiToY(c.rsi);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();

      // Highlight RSI > OB / < OS nodes
      for (let i = startIndex; i <= endIndex; i++) {
        const c = candles[i];
        if (c.rsi === null) continue;
        if (c.rsi > rsiOverbought || c.rsi < rsiOversold) {
          const x = indexToX(i);
          const y = rsiToY(c.rsi);
          ctx.fillStyle = c.rsi > rsiOverbought ? '#EF4444' : '#10B981';
          ctx.beginPath();
          ctx.arc(x, y, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();

      // RSI Pane label & latest RSI badge
      const latestRsi = lastCandle.rsi;
      ctx.fillStyle = '#94A3B8';
      ctx.font = '500 10px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.fillText(`RSI(${rsiPeriod})`, 8, rsiTop + 14);
      if (latestRsi !== null) {
        const rsiY = Math.max(rsiTop + 10, Math.min(rsiTop + rsiHeight - 10, rsiToY(latestRsi)));
        ctx.fillStyle =
          latestRsi > rsiOverbought ? '#DC2626' : latestRsi < rsiOversold ? '#059669' : '#1E293B';
        ctx.fillRect(plotWidth + 2, rsiY - 9, axisRightWidth - 6, 18);
        ctx.fillStyle = '#F8FAFC';
        ctx.font = '600 10px "JetBrains Mono", monospace';
        ctx.fillText(latestRsi.toFixed(1), plotWidth + 6, rsiY + 3.5);
      }

      // Crosshair on hover
      if (hoverInfo) {
        ctx.strokeStyle = 'rgba(226, 232, 240, 0.25)';
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(hoverInfo.x, 0);
        ctx.lineTo(hoverInfo.x, usableHeight);
        ctx.moveTo(0, hoverInfo.y);
        ctx.lineTo(plotWidth, hoverInfo.y);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Right axis vertical divider
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.beginPath();
      ctx.moveTo(plotWidth + 0.5, 0);
      ctx.lineTo(plotWidth + 0.5, usableHeight);
      ctx.stroke();
    };

    const raf = requestAnimationFrame(render);
    return () => cancelAnimationFrame(raf);
  }, [
    candles,
    markers,
    view,
    pair,
    timeframe,
    armedSellRef,
    armedBuyRef,
    slReentrySide,
    slReentryPrice,
    slReentryStopLoss,
    rsiPeriod,
    rsiOverbought,
    rsiOversold,
    buyCloseRsiEnabled,
    buyCloseRsi,
    sellCloseRsiEnabled,
    sellCloseRsi,
    openTrade,
    hoverInfo
  ]);

  // Resize observer so canvas stays crisp on orientation/window changes
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setView((v) => ({ ...v }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const updateCrosshair = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || candles.length === 0) return;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const axisRightWidth = rect.width < 640 ? 64 : 78;
    const plotWidth = Math.max(100, rect.width - axisRightWidth);
    if (x < 0 || x > plotWidth) {
      setHoverInfo(null);
      return;
    }
    const rightEdgeIndex = candles.length - 1 + view.rightOffset;
    const idx = Math.round(rightEdgeIndex - (plotWidth - x) / view.candleWidth - 0.5);
    if (idx >= 0 && idx < candles.length) {
      const candle = candles[idx];
      const marker = markers.find((m) => m.candleTimeMs === candle.openTime);
      setHoverInfo({ candle, marker, x, y });
    } else {
      setHoverInfo(null);
    }
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const axisRightWidth = rect.width < 640 ? 64 : 78;
    const plotWidth = rect.width - axisRightWidth;
    const scale = priceScaleRef.current;
    const priceSpan = scale.max - scale.min;
    const pricePerPixel = priceSpan / Math.max(50, scale.plotHeight - 20);

    canvas.setPointerCapture(e.pointerId);
    dragRef.current = {
      active: true,
      mode: x > plotWidth ? 'yscale' : 'pan',
      startX: e.clientX,
      startY: e.clientY,
      startRightOffset: view.rightOffset,
      startYPanPrice: view.yPanPrice,
      startYZoom: view.yZoom,
      pricePerPixel
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (pinchRef.current.active) return;

    if (!dragRef.current.active) {
      updateCrosshair(e.clientX, e.clientY);
      return;
    }

    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;

    if (dragRef.current.mode === 'yscale') {
      const zoomFactor = Math.exp(-dy * 0.008);
      setView((prev) => ({
        ...prev,
        autoY: false,
        yZoom: Math.min(8, Math.max(0.25, dragRef.current.startYZoom * zoomFactor))
      }));
      return;
    }

    // Subtract candleShift so dragging left (dx < 0) moves chart left, dragging right (dx > 0) moves chart right
    const candleShift = dx / view.candleWidth;
    const priceShift = dy * dragRef.current.pricePerPixel;
    const movedVertically = Math.abs(dy) > 4;

    setView((prev) => ({
      ...prev,
      rightOffset: Math.min(
        80,
        Math.max(-(candles.length - 5), dragRef.current.startRightOffset - candleShift)
      ),
      autoY: movedVertically ? false : prev.autoY,
      yPanPrice: movedVertically
        ? dragRef.current.startYPanPrice + priceShift
        : prev.yPanPrice
    }));
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    dragRef.current.active = false;
    try {
      canvasRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore if not captured
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    if (e.shiftKey) {
      const yFactor = e.deltaY < 0 ? 1.12 : 0.89;
      setView((prev) => ({
        ...prev,
        autoY: false,
        yZoom: Math.min(8, Math.max(0.25, prev.yZoom * yFactor))
      }));
      return;
    }
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    zoomBy(factor);
  };

  // Multi-touch pinch-to-zoom for mobile screens
  const handleTouchStart = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchRef.current = {
        active: true,
        startDist: Math.hypot(dx, dy),
        startCandleWidth: view.candleWidth,
        midX: (e.touches[0].clientX + e.touches[1].clientX) / 2,
        startRightOffset: view.rightOffset
      };
    } else if (e.touches.length === 1) {
      updateCrosshair(e.touches[0].clientX, e.touches[0].clientY);
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLCanvasElement>) => {
    if (e.touches.length === 2 && pinchRef.current.active) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      if (pinchRef.current.startDist > 0) {
        const scale = dist / pinchRef.current.startDist;
        setView((prev) => ({
          ...prev,
          candleWidth: Math.min(38, Math.max(3, pinchRef.current.startCandleWidth * scale))
        }));
      }
    }
  };

  const handleTouchEnd = () => {
    if (pinchRef.current.active) {
      pinchRef.current.active = false;
    }
  };

  return (
    <div className="relative flex flex-col w-full h-full min-h-[380px] sm:min-h-[480px] bg-[#0B101B] border border-slate-800/90 rounded-xl overflow-hidden select-none">
      {/* Compact Chart Header Overlay */}
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800/80 bg-slate-900/50">
        <div className="flex items-center gap-2 text-xs text-slate-400 truncate">
          <span className="font-semibold text-slate-100">{pair}</span>
          <span aria-hidden="true">·</span>
          <span className="font-mono">{timeframe}</span>
          <span aria-hidden="true">·</span>
          <span className="hidden sm:inline truncate">
            Heikin Ashi & RSI({rsiPeriod} · {rsiOversold}/{rsiOverbought})
          </span>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => zoomBy(1.2)}
            title="Zoom In"
            className="min-h-[36px] min-w-[36px] sm:min-h-[32px] sm:min-w-[32px] flex items-center justify-center rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <ZoomIn className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(0.83)}
            title="Zoom Out"
            className="min-h-[36px] min-w-[36px] sm:min-h-[32px] sm:min-w-[32px] flex items-center justify-center rounded-lg text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={resetView}
            className="min-h-[36px] sm:min-h-[32px] px-2.5 flex items-center gap-1.5 rounded-lg text-xs font-medium text-slate-200 bg-slate-800/80 hover:bg-slate-700 transition-colors whitespace-nowrap"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            <span>{autoFitLabel}</span>
          </button>
        </div>
      </div>

      {/* Crosshair Readout Strip */}
      <div className="flex items-center justify-between gap-3 px-3 py-1.5 text-[11px] font-mono bg-[#0D1320] border-b border-slate-800/60 overflow-x-auto whitespace-nowrap">
        {hoverInfo ? (
          <div className="flex items-center gap-3 text-slate-300">
            <span className="text-slate-400">
              {new Date(hoverInfo.candle.openTime).toLocaleString()}
            </span>
            <span>HA O:{formatPrice(hoverInfo.candle.haOpen)}</span>
            <span>H:{formatPrice(hoverInfo.candle.haHigh)}</span>
            <span>L:{formatPrice(hoverInfo.candle.haLow)}</span>
            <span className={hoverInfo.candle.isGreen ? 'text-emerald-400' : 'text-rose-400'}>
              C:{formatPrice(hoverInfo.candle.haClose)}
            </span>
            <span className="text-sky-400">
              RSI:{hoverInfo.candle.rsi !== null ? hoverInfo.candle.rsi.toFixed(1) : '--'}
            </span>
            {hoverInfo.marker && (
              <span
                className={
                  hoverInfo.marker.type.includes('BUY') ? 'text-emerald-400 font-semibold' : 'text-rose-400 font-semibold'
                }
              >
                [{hoverInfo.marker.type}]
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-center gap-2 text-slate-400 font-sans">
            <Move className="w-3.5 h-3.5 text-slate-500 shrink-0" />
            <span>{hintLabel}</span>
          </div>
        )}
      </div>

      {/* Interactive Canvas */}
      <div ref={containerRef} className="relative flex-1 w-full min-h-[320px] sm:min-h-[420px]">
        <canvas
          ref={canvasRef}
          className="block w-full h-full cursor-crosshair touch-none"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            dragRef.current.active = false;
            setHoverInfo(null);
          }}
          onWheel={handleWheel}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        />
      </div>
    </div>
  );
};
