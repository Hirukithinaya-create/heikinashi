import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  calculateUnrealizedPnl,
  computeHeikinAshiAndRsi,
  evaluateClosedCandle,
  type StrategyState
} from './src/lib/strategy.ts';
import type {
  CloseReason,
  HeikinAshiCandle,
  MarginMode,
  RawCandle,
  SignalType,
  Timeframe,
  TradeRecord,
  TradeSide,
  UserBotProfile
} from './src/types/trading.ts';

interface FirebaseConfigFile {
  projectId: string;
  appId: string;
  apiKey: string;
  firestoreDatabaseId: string;
}

export interface ServerWorkerDeps {
  rootDir: string;
  fetchKlines: (symbol: string, interval: string, limit?: number) => Promise<{ candles: RawCandle[]; source: string }>;
  fetchLivePrice: (symbol: string) => Promise<{ price: number; source: string }>;
  executeOrder: (params: {
    symbol: string;
    side: TradeSide;
    quantity: number;
    leverage: number;
    marginType: MarginMode;
    reduceOnly?: boolean;
    apiKey?: string;
    apiSecret?: string;
    testnet?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
}

interface StoredWorkerRecord {
  uid: string;
  refreshToken: string;
  registeredAt: number;
}

interface ActiveWorkerRuntime extends StoredWorkerRecord {
  idToken: string;
  tokenExpiresAt: number;
  lastTickAt: number;
  lastSignalAt: number;
  lastAction: string;
  lastError: string | null;
  botActive: boolean;
  openTradeId: string | null;
  openTradePair: string | null;
  openTradeSide: TradeSide | null;
  pair: string;
  timeframe: Timeframe;
  slTriggeredCandleTime: number;
  closedTradeIds: Set<string>;
}

export interface PublicWorkerStatus {
  registered: boolean;
  running247: boolean;
  botActive: boolean;
  hasOpenTrade: boolean;
  openTradeSide: TradeSide | null;
  pair: string | null;
  timeframe: Timeframe | null;
  lastTickAt: number;
  lastSignalAt: number;
  lastAction: string;
  lastError: string | null;
  workerCount: number;
}

function timeframeToMs(tf: string): number {
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
  return map[tf] ?? 900_000;
}

function fmtPrice(val: number): string {
  if (!val || !Number.isFinite(val)) return '--';
  if (val >= 1000) return val.toFixed(2);
  if (val >= 1) return val.toFixed(4);
  return val.toFixed(6);
}

// ---------- WebCrypto-compatible AES-GCM vault decryption & session encryption ----------

const subtle = crypto.webcrypto.subtle;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

async function deriveUserVaultKey(uid: string, cfg: FirebaseConfigFile): Promise<crypto.webcrypto.CryptoKey> {
  const material = `${uid}::${cfg.projectId}::${cfg.appId}::HeikinPulseVault`;
  const keyMaterial = await subtle.importKey('raw', textEncoder.encode(material), { name: 'PBKDF2' }, false, ['deriveKey']);
  const salt = textEncoder.encode(`hp-salt-${uid}-${cfg.firestoreDatabaseId}`);
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 120_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  );
}

async function decryptUserCredential(uid: string, payload: string, cfg: FirebaseConfigFile): Promise<string> {
  const parts = payload.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Unsupported encrypted credential format');
  }
  const iv = Uint8Array.from(Buffer.from(parts[1], 'base64'));
  const cipherBytes = Uint8Array.from(Buffer.from(parts[2], 'base64'));
  const key = await deriveUserVaultKey(uid, cfg);
  const plainBuf = await subtle.decrypt({ name: 'AES-GCM', iv }, key, cipherBytes);
  return textDecoder.decode(plainBuf);
}

function deriveLocalRegistryKey(cfg: FirebaseConfigFile): Buffer {
  return crypto
    .createHash('sha256')
    .update(`hp-server-registry::${cfg.projectId}::${cfg.apiKey}::${cfg.firestoreDatabaseId}`)
    .digest();
}

function encryptRegistryJson(jsonText: string, cfg: FirebaseConfigFile): string {
  const key = deriveLocalRegistryKey(cfg);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(jsonText, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
}

function decryptRegistryJson(payload: string, cfg: FirebaseConfigFile): string {
  const [ivB64, tagB64, dataB64] = payload.trim().split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid worker registry file');
  const key = deriveLocalRegistryKey(cfg);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

// ---------- Firestore REST Value helpers ----------

type FsValue =
  | { stringValue: string }
  | { integerValue: string }
  | { doubleValue: number }
  | { booleanValue: boolean }
  | { nullValue: null }
  | { timestampValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

function toFsValue(val: unknown): FsValue {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number') {
    const safe = Number.isFinite(val) ? val : 0;
    return Number.isInteger(safe) ? { integerValue: String(safe) } : { doubleValue: safe };
  }
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map((item) => toFsValue(item)) } };
  if (typeof val === 'object') {
    const fields: Record<string, FsValue> = {};
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (v !== undefined) fields[k] = toFsValue(v);
    }
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function fromFsValue(v: FsValue | undefined): unknown {
  if (!v) return undefined;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return Number(v.doubleValue);
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map((item) => fromFsValue(item));
  if ('mapValue' in v) {
    const obj: Record<string, unknown> = {};
    for (const [k, fv] of Object.entries(v.mapValue.fields || {})) {
      obj[k] = fromFsValue(fv);
    }
    return obj;
  }
  return undefined;
}

function decodeFsFields<T>(fields: Record<string, FsValue> | undefined): T {
  const out: Record<string, unknown> = {};
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      out[k] = fromFsValue(v);
    }
  }
  return out as T;
}

function encodeFsFields(obj: Record<string, unknown>): Record<string, FsValue> {
  const out: Record<string, FsValue> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) {
      out[k] = toFsValue(v);
    }
  }
  return out;
}

export function createServerBotEngine(deps: ServerWorkerDeps) {
  const cfgPath = path.join(deps.rootDir, 'firebase-applet-config.json');
  const firebaseCfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as FirebaseConfigFile;
  const storePath = path.join(deps.rootDir, '.heikinpulse-workers.enc');

  const fsRestRoot = `https://firestore.googleapis.com/v1/projects/${firebaseCfg.projectId}/databases/${firebaseCfg.firestoreDatabaseId}`;
  const docNamePrefix = `projects/${firebaseCfg.projectId}/databases/${firebaseCfg.firestoreDatabaseId}/documents`;

  const workers = new Map<string, ActiveWorkerRuntime>();
  const userLocks = new Set<string>();
  let loopRunning = false;

  function persistWorkersToDisk(): void {
    try {
      const list: StoredWorkerRecord[] = Array.from(workers.values()).map((w) => ({
        uid: w.uid,
        refreshToken: w.refreshToken,
        registeredAt: w.registeredAt
      }));
      const enc = encryptRegistryJson(JSON.stringify(list), firebaseCfg);
      fs.writeFileSync(storePath, enc, 'utf8');
    } catch (err) {
      console.error('[24/7 Engine] Failed to persist worker registry:', err);
    }
  }

  function loadWorkersFromDisk(): void {
    try {
      if (!fs.existsSync(storePath)) return;
      const raw = fs.readFileSync(storePath, 'utf8');
      if (!raw.trim()) return;
      const parsed = JSON.parse(decryptRegistryJson(raw, firebaseCfg)) as StoredWorkerRecord[];
      if (!Array.isArray(parsed)) return;
      for (const item of parsed) {
        if (item.uid && item.refreshToken) {
          workers.set(item.uid, {
            uid: item.uid,
            refreshToken: item.refreshToken,
            registeredAt: item.registeredAt || Date.now(),
            idToken: '',
            tokenExpiresAt: 0,
            lastTickAt: 0,
            lastSignalAt: 0,
            lastAction: 'Restored on server boot',
            lastError: null,
            botActive: false,
            openTradeId: null,
            openTradePair: null,
            openTradeSide: null,
            pair: 'BTCUSDT',
            timeframe: '15m',
            slTriggeredCandleTime: 0,
            closedTradeIds: new Set()
          });
        }
      }
      if (workers.size > 0) {
        console.log(`[24/7 Engine] Restored ${workers.size} worker session(s) from disk.`);
      }
    } catch (err) {
      console.error('[24/7 Engine] Could not restore worker registry:', err);
    }
  }

  async function ensureFreshIdToken(runtime: ActiveWorkerRuntime): Promise<string> {
    if (runtime.idToken && Date.now() < runtime.tokenExpiresAt) {
      return runtime.idToken;
    }

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: runtime.refreshToken
    });
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${encodeURIComponent(firebaseCfg.apiKey)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    const data = (await res.json().catch(() => ({}))) as {
      id_token?: string;
      refresh_token?: string;
      user_id?: string;
      expires_in?: string;
      error?: { message?: string };
    };
    if (!res.ok || !data.id_token || !data.user_id) {
      throw new Error(data.error?.message || `Firebase token refresh failed (${res.status})`);
    }
    if (data.user_id !== runtime.uid) {
      throw new Error('Token user_id mismatch');
    }

    runtime.idToken = data.id_token;
    if (data.refresh_token && data.refresh_token !== runtime.refreshToken) {
      runtime.refreshToken = data.refresh_token;
      persistWorkersToDisk();
    }
    const expiresSec = Math.max(120, Number(data.expires_in || 3600));
    runtime.tokenExpiresAt = Date.now() + (expiresSec - 180) * 1000;
    return runtime.idToken;
  }

  async function fsGetDoc<T>(idToken: string, relPath: string): Promise<T | null> {
    const res = await fetch(`${fsRestRoot}/documents/${relPath}`, {
      headers: { Authorization: `Bearer ${idToken}` }
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Firestore GET ${relPath} failed (${res.status}): ${txt.slice(0, 180)}`);
    }
    const docJson = (await res.json()) as { fields?: Record<string, FsValue> };
    return decodeFsFields<T>(docJson.fields);
  }

  async function fsGetOpenTrades(idToken: string, uid: string): Promise<TradeRecord[]> {
    const res = await fetch(`${fsRestRoot}/documents/users/${uid}:runQuery`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: 'trades' }],
          where: {
            compositeFilter: {
              op: 'AND',
              filters: [
                { fieldFilter: { field: { fieldPath: 'ownerId' }, op: 'EQUAL', value: { stringValue: uid } } },
                { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'OPEN' } } }
              ]
            }
          },
          limit: 10
        }
      })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Firestore query open trades failed (${res.status}): ${txt.slice(0, 180)}`);
    }
    const rows = (await res.json()) as Array<{ document?: { name?: string; fields?: Record<string, FsValue> } }>;
    const list: TradeRecord[] = [];
    for (const r of rows) {
      if (!r.document?.name || !r.document.fields) continue;
      const parts = r.document.name.split('/');
      const id = parts[parts.length - 1];
      const data = decodeFsFields<Omit<TradeRecord, 'id'>>(r.document.fields);
      list.push({ ...data, id });
    }
    list.sort((a, b) => (b.openedAtMs || 0) - (a.openedAtMs || 0));
    return list;
  }

  async function fsCommit(idToken: string, writes: unknown[]): Promise<void> {
    if (writes.length === 0) return;
    const res = await fetch(`${fsRestRoot}/documents:commit`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${idToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ writes })
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`Firestore commit failed (${res.status}): ${txt.slice(0, 240)}`);
    }
  }

  async function fsUpdateProfile(
    idToken: string,
    uid: string,
    patch: Record<string, unknown>
  ): Promise<void> {
    const fieldPaths = Object.keys(patch);
    if (fieldPaths.length === 0) return;
    await fsCommit(idToken, [
      {
        update: {
          name: `${docNamePrefix}/users/${uid}`,
          fields: encodeFsFields(patch)
        },
        updateMask: { fieldPaths },
        updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }]
      }
    ]);
  }

  async function fsCreateOpenTrade(
    idToken: string,
    uid: string,
    trade: Omit<TradeRecord, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<TradeRecord> {
    const tradeId = `tr_${trade.openedAtMs}_${trade.side}_${Math.random().toString(36).slice(2, 6)}`;
    const fieldsObj: Record<string, unknown> = {
      ownerId: uid,
      pair: trade.pair,
      timeframe: trade.timeframe,
      side: trade.side,
      status: 'OPEN',
      entryPrice: Number(trade.entryPrice),
      exitPrice: 0,
      stopLossPrice: Number(trade.stopLossPrice || 0),
      leverage: Math.min(125, Math.max(1, Math.round(trade.leverage))),
      marginUsdt: Math.min(10000000, Math.max(1, Number(trade.marginUsdt))),
      quantity: Number(trade.quantity),
      realizedPnl: 0,
      realizedRoiPct: 0,
      entryRsi: Math.min(100, Math.max(0, Number(trade.entryRsi))),
      exitRsi: 0,
      closeReason: 'NONE',
      openedAtMs: Number(trade.openedAtMs),
      closedAtMs: 0
    };
    await fsCommit(idToken, [
      {
        currentDocument: { exists: false },
        update: {
          name: `${docNamePrefix}/users/${uid}/trades/${tradeId}`,
          fields: encodeFsFields(fieldsObj)
        },
        updateTransforms: [
          { fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' },
          { fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }
        ]
      }
    ]);
    return { ...(fieldsObj as Omit<TradeRecord, 'id'>), id: tradeId };
  }

  async function fsCloseTrade(
    idToken: string,
    uid: string,
    tradeId: string,
    payload: {
      exitPrice: number;
      realizedPnl: number;
      realizedRoiPct: number;
      exitRsi: number;
      closeReason: Exclude<CloseReason, 'NONE'>;
      closedAtMs: number;
    }
  ): Promise<void> {
    const patch: Record<string, unknown> = {
      status: 'CLOSED',
      exitPrice: Number(payload.exitPrice),
      realizedPnl: Number(payload.realizedPnl.toFixed(4)),
      realizedRoiPct: Number(payload.realizedRoiPct.toFixed(2)),
      exitRsi: Math.min(100, Math.max(0, Number(payload.exitRsi))),
      closeReason: payload.closeReason,
      closedAtMs: Number(payload.closedAtMs)
    };
    await fsCommit(idToken, [
      {
        update: {
          name: `${docNamePrefix}/users/${uid}/trades/${tradeId}`,
          fields: encodeFsFields(patch)
        },
        updateMask: { fieldPaths: Object.keys(patch) },
        updateTransforms: [{ fieldPath: 'updatedAt', setToServerValue: 'REQUEST_TIME' }]
      }
    ]);
  }

  async function fsRecordSignal(
    idToken: string,
    uid: string,
    signal: {
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
    }
  ): Promise<void> {
    const safeCandleTime = Math.max(1, Math.floor(signal.candleTimeMs));
    const signalId = `sig_${signal.pair}_${signal.timeframe}_${safeCandleTime}_${signal.signalType}`;
    const fieldsObj: Record<string, unknown> = {
      ownerId: uid,
      pair: signal.pair,
      timeframe: signal.timeframe,
      signalType: signal.signalType,
      candleTimeMs: safeCandleTime,
      price: Math.max(1e-9, Number(signal.price)),
      haOpen: Math.max(1e-9, Number(signal.haOpen)),
      haHigh: Math.max(1e-9, Number(signal.haHigh)),
      haLow: Math.max(1e-9, Number(signal.haLow)),
      haClose: Math.max(1e-9, Number(signal.haClose)),
      rsi: Math.min(100, Math.max(0, Number(signal.rsi))),
      referenceLevel: Math.max(0, Number(signal.referenceLevel)),
      executed: Boolean(signal.executed),
      note: signal.note.slice(0, 240)
    };
    try {
      await fsCommit(idToken, [
        {
          currentDocument: { exists: false },
          update: {
            name: `${docNamePrefix}/users/${uid}/signals/${signalId}`,
            fields: encodeFsFields(fieldsObj)
          },
          updateTransforms: [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]
        }
      ]);
    } catch (err) {
      // Ignore duplicate signal writes cleanly
      const msg = err instanceof Error ? err.message : '';
      if (!msg.includes('ALREADY_EXISTS') && !msg.includes('409')) {
        throw err;
      }
    }
  }

  async function loadUserBinanceCreds(
    idToken: string,
    uid: string
  ): Promise<{ enabled: boolean; apiKey: string; apiSecret: string; testnet: boolean }> {
    try {
      const doc = await fsGetDoc<{
        encryptedKey?: string;
        encryptedSecret?: string;
        enabled?: boolean;
        testnet?: boolean;
      }>(idToken, `users/${uid}/private/binanceCredentials`);
      if (!doc || !doc.enabled || !doc.encryptedKey || !doc.encryptedSecret) {
        return { enabled: false, apiKey: '', apiSecret: '', testnet: true };
      }
      const [apiKey, apiSecret] = await Promise.all([
        decryptUserCredential(uid, doc.encryptedKey, firebaseCfg),
        decryptUserCredential(uid, doc.encryptedSecret, firebaseCfg)
      ]);
      return {
        enabled: true,
        apiKey,
        apiSecret,
        testnet: doc.testnet !== false
      };
    } catch {
      return { enabled: false, apiKey: '', apiSecret: '', testnet: true };
    }
  }

  async function executePositionTransition(params: {
    idToken: string;
    uid: string;
    profile: UserBotProfile;
    creds: { enabled: boolean; apiKey: string; apiSecret: string; testnet: boolean };
    newSide: TradeSide | null;
    execPrice: number;
    execRsi: number;
    eventTimeMs: number;
    closeReason: Exclude<CloseReason, 'NONE'>;
    currentOpen: TradeRecord | null;
    currentBalance: number;
    stopLossPrice?: number;
  }): Promise<{ createdTrade: TradeRecord | null; updatedBalance: number }> {
    const {
      idToken,
      uid,
      profile,
      creds,
      newSide,
      execPrice,
      execRsi,
      eventTimeMs,
      closeReason,
      currentOpen,
      currentBalance,
      stopLossPrice = 0
    } = params;

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

      if (creds.enabled && creds.apiKey && creds.apiSecret) {
        const closeSide: TradeSide = currentOpen.side === 'BUY' ? 'SELL' : 'BUY';
        await deps.executeOrder({
          symbol: currentOpen.pair,
          side: closeSide,
          quantity: currentOpen.quantity,
          leverage: currentOpen.leverage,
          marginType: profile.marginMode || 'ISOLATED',
          reduceOnly: true,
          apiKey: creds.apiKey,
          apiSecret: creds.apiSecret,
          testnet: creds.testnet
        });
      }

      await fsCloseTrade(idToken, uid, currentOpen.id, {
        exitPrice: execPrice,
        realizedPnl: pnl,
        realizedRoiPct: roiPct,
        exitRsi: execRsi,
        closeReason,
        closedAtMs: eventTimeMs
      });
    }

    if (!newSide) {
      return { createdTrade: null, updatedBalance: nextBalance };
    }

    const quantity = Number(((profile.marginUsdt * profile.leverage) / execPrice).toFixed(6));
    if (creds.enabled && creds.apiKey && creds.apiSecret) {
      await deps.executeOrder({
        symbol: profile.selectedPair,
        side: newSide,
        quantity,
        leverage: profile.leverage,
        marginType: profile.marginMode || 'ISOLATED',
        apiKey: creds.apiKey,
        apiSecret: creds.apiSecret,
        testnet: creds.testnet
      });
    }

    const createdTrade = await fsCreateOpenTrade(idToken, uid, {
      ownerId: uid,
      pair: profile.selectedPair,
      timeframe: profile.timeframe,
      side: newSide,
      status: 'OPEN',
      entryPrice: execPrice,
      exitPrice: 0,
      stopLossPrice,
      leverage: profile.leverage,
      marginUsdt: profile.marginUsdt,
      quantity,
      realizedPnl: 0,
      realizedRoiPct: 0,
      entryRsi: execRsi,
      exitRsi: 0,
      closeReason: 'NONE',
      openedAtMs: eventTimeMs,
      closedAtMs: 0
    });

    return { createdTrade, updatedBalance: nextBalance };
  }

  async function processSingleUser(runtime: ActiveWorkerRuntime): Promise<void> {
    if (userLocks.has(runtime.uid)) return;
    userLocks.add(runtime.uid);
    try {
      const idToken = await ensureFreshIdToken(runtime);
      const profile = await fsGetDoc<UserBotProfile>(idToken, `users/${runtime.uid}`);
      if (!profile) {
        runtime.lastTickAt = Date.now();
        runtime.lastError = 'User profile not found';
        return;
      }

      const openTrades = await fsGetOpenTrades(idToken, runtime.uid);
      const pair = profile.selectedPair;
      const timeframe = profile.timeframe;
      const openTrade =
        openTrades.find((tr) => tr.pair === pair && !runtime.closedTradeIds.has(tr.id)) ||
        openTrades.find((tr) => !runtime.closedTradeIds.has(tr.id)) ||
        null;

      runtime.botActive = Boolean(profile.botActive);
      runtime.pair = pair;
      runtime.timeframe = timeframe;
      runtime.openTradeId = openTrade?.id ?? null;
      runtime.openTradePair = openTrade?.pair ?? null;
      runtime.openTradeSide = openTrade?.side ?? null;
      runtime.lastTickAt = Date.now();
      runtime.lastError = null;

      // Idle cleanly if Bot is OFF and there's no open trade on this pair/timeframe needing Close-RSI watch
      const needsManualCloseWatch =
        !profile.botActive &&
        openTrade &&
        openTrade.pair === pair &&
        openTrade.timeframe === timeframe &&
        ((openTrade.side === 'BUY' && Boolean(profile.buyCloseRsiEnabled)) ||
          (openTrade.side === 'SELL' && Boolean(profile.sellCloseRsiEnabled)));

      if (!profile.botActive && !needsManualCloseWatch) {
        return;
      }

      const [{ candles: rawCandles, source }, tickerInfo] = await Promise.all([
        deps.fetchKlines(pair, timeframe, 500),
        deps.fetchLivePrice(pair)
      ]);
      if (source === 'simulated' || rawCandles.length < (profile.rsiPeriod || 14) + 5) {
        return;
      }

      // Apply freshest live ticker price onto the active forming bar
      const livePrice = tickerInfo.price > 0 ? tickerInfo.price : rawCandles[rawCandles.length - 1].close;
      if (livePrice > 0 && rawCandles.length > 0) {
        const lastIdx = rawCandles.length - 1;
        rawCandles[lastIdx] = {
          ...rawCandles[lastIdx],
          close: livePrice,
          high: Math.max(rawCandles[lastIdx].high, livePrice),
          low: Math.min(rawCandles[lastIdx].low, livePrice)
        };
      }

      const rsiPeriod = profile.rsiPeriod || 14;
      const haCandles: HeikinAshiCandle[] = computeHeikinAshiAndRsi(rawCandles, rsiPeriod);
      const liveBar = haCandles[haCandles.length - 1];
      const latestRsi = liveBar?.rsi ?? null;
      const nowMs = Date.now();
      const creds = await loadUserBinanceCreds(idToken, runtime.uid);

      // ---------- MODE A: Manual Trade Close-RSI 24/7 Watch ----------
      if (!profile.botActive && needsManualCloseWatch && openTrade) {
        const buyTarget = profile.buyCloseRsi ?? 70;
        const sellTarget = profile.sellCloseRsi ?? 30;
        const watchBuy = openTrade.side === 'BUY' && Boolean(profile.buyCloseRsiEnabled);
        const watchSell = openTrade.side === 'SELL' && Boolean(profile.sellCloseRsiEnabled);

        const postEntryClosed = haCandles
          .slice(0, Math.max(0, haCandles.length - 1))
          .filter((c) => c.closeTime <= nowMs && c.closeTime > openTrade.openedAtMs && c.rsi !== null);
        const latestPostClosed = postEntryClosed[postEntryClosed.length - 1];

        const hitLiveBuy = watchBuy && latestRsi !== null && openTrade.entryRsi < buyTarget && latestRsi >= buyTarget;
        const hitClosedBuy =
          watchBuy && latestPostClosed?.rsi !== null && latestPostClosed?.rsi !== undefined && latestPostClosed.rsi >= buyTarget;
        const hitLiveSell = watchSell && latestRsi !== null && openTrade.entryRsi > sellTarget && latestRsi <= sellTarget;
        const hitClosedSell =
          watchSell && latestPostClosed?.rsi !== null && latestPostClosed?.rsi !== undefined && latestPostClosed.rsi <= sellTarget;

        if (hitLiveBuy || hitClosedBuy || hitLiveSell || hitClosedSell) {
          const isLiveHit = hitLiveBuy || hitLiveSell;
          const exitRsiVal = isLiveHit ? (latestRsi as number) : (latestPostClosed!.rsi as number);
          const triggerBar = isLiveHit ? liveBar : latestPostClosed!;
          const targetThreshold = openTrade.side === 'BUY' ? buyTarget : sellTarget;
          const note = `24/7 Server closed Manual ${openTrade.side} at Close RSI ${exitRsiVal.toFixed(1)} (target ${openTrade.side === 'BUY' ? '≥' : '≤'} ${targetThreshold})`;

          runtime.closedTradeIds.add(openTrade.id);
          const { updatedBalance } = await executePositionTransition({
            idToken,
            uid: runtime.uid,
            profile,
            creds,
            newSide: null,
            execPrice: livePrice,
            execRsi: exitRsiVal,
            eventTimeMs: nowMs,
            closeReason: 'RSI_CLOSE',
            currentOpen: openTrade,
            currentBalance: profile.paperBalanceUsdt
          });
          await fsUpdateProfile(idToken, runtime.uid, { paperBalanceUsdt: updatedBalance });
          await fsRecordSignal(idToken, runtime.uid, {
            pair,
            timeframe,
            signalType: 'RSI_CLOSE',
            candleTimeMs: triggerBar?.openTime ?? nowMs,
            price: livePrice,
            haOpen: triggerBar?.haOpen ?? livePrice,
            haHigh: triggerBar?.haHigh ?? livePrice,
            haLow: triggerBar?.haLow ?? livePrice,
            haClose: triggerBar?.haClose ?? livePrice,
            rsi: exitRsiVal,
            referenceLevel: targetThreshold,
            executed: true,
            note
          });
          runtime.lastSignalAt = nowMs;
          runtime.openTradeId = null;
          runtime.openTradeSide = null;
          runtime.lastAction = `Closed Manual ${openTrade.side} @ ${fmtPrice(livePrice)} (RSI ${exitRsiVal.toFixed(1)})`;
          console.log(`[24/7 Engine] [${runtime.uid}] ${runtime.lastAction}`);
        }
        return;
      }

      // ---------- MODE B: 24/7 Auto-Trade Strategy Engine ----------
      if (!profile.botActive) return;

      const closedCandles = haCandles
        .slice(0, Math.max(0, haCandles.length - 1))
        .filter((c) => c.closeTime <= nowMs && c.rsi !== null);
      const latestClosed = closedCandles[closedCandles.length - 1];
      if (!latestClosed) return;

      if (!profile.lastEvaluatedTime || profile.lastEvaluatedTime === 0) {
        await fsUpdateProfile(idToken, runtime.uid, { lastEvaluatedTime: latestClosed.openTime });
        runtime.lastAction = `Initialized candle cursor @ ${new Date(latestClosed.openTime).toISOString()}`;
        return;
      }

      const pendingCandles = closedCandles.filter((c) => c.openTime > profile.lastEvaluatedTime);

      // B1. No newly closed candle yet -> monitor Live Wick SL & Live Close-RSI intra-candle
      if (pendingCandles.length === 0) {
        if (
          openTrade &&
          openTrade.pair === pair &&
          openTrade.timeframe === timeframe &&
          !runtime.closedTradeIds.has(openTrade.id) &&
          liveBar
        ) {
          // 1) Live Wick Stop-Loss
          const sl = openTrade.stopLossPrice || 0;
          if ((profile.stopLossEnabled ?? true) && sl > 0) {
            const breachedSell = openTrade.side === 'SELL' && (livePrice > sl || liveBar.high > sl);
            const breachedBuy = openTrade.side === 'BUY' && (livePrice < sl || liveBar.low < sl);
            if (breachedSell || breachedBuy) {
              const rsiVal = latestRsi ?? 50;
              runtime.closedTradeIds.add(openTrade.id);
              const { updatedBalance } = await executePositionTransition({
                idToken,
                uid: runtime.uid,
                profile,
                creds,
                newSide: null,
                execPrice: sl,
                execRsi: rsiVal,
                eventTimeMs: nowMs,
                closeReason: 'STOP_LOSS',
                currentOpen: openTrade,
                currentBalance: profile.paperBalanceUsdt
              });
              const stoppedSide = openTrade.side;
              const stoppedEntry = openTrade.entryPrice;
              runtime.slTriggeredCandleTime = liveBar.openTime;
              await fsUpdateProfile(idToken, runtime.uid, {
                slReentrySide: stoppedSide,
                slReentryPrice: stoppedEntry,
                slReentryStopLoss: sl,
                paperBalanceUsdt: updatedBalance
              });
              await fsRecordSignal(idToken, runtime.uid, {
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
                note: `24/7 Live Stop-Loss triggered on ${stoppedSide} @ ${fmtPrice(sl)}. Re-entry watch @ ${fmtPrice(stoppedEntry)} / SL Cross ${fmtPrice(sl)}`
              });
              runtime.lastSignalAt = nowMs;
              runtime.openTradeId = null;
              runtime.openTradeSide = null;
              runtime.lastAction = `Live SL ${stoppedSide} @ ${fmtPrice(sl)}`;
              console.log(`[24/7 Engine] [${runtime.uid}] ${runtime.lastAction}`);
              return;
            }
          }

          // 2) Live Close-RSI Exit (when Switch 1 or Switch 2 enabled)
          const buyTarget = profile.buyCloseRsi ?? 70;
          const sellTarget = profile.sellCloseRsi ?? 30;
          const hitLiveCloseBuy =
            openTrade.side === 'BUY' &&
            Boolean(profile.buyCloseRsiEnabled) &&
            latestRsi !== null &&
            openTrade.entryRsi < buyTarget &&
            latestRsi >= buyTarget;
          const hitLiveCloseSell =
            openTrade.side === 'SELL' &&
            Boolean(profile.sellCloseRsiEnabled) &&
            latestRsi !== null &&
            openTrade.entryRsi > sellTarget &&
            latestRsi <= sellTarget;

          if (hitLiveCloseBuy || hitLiveCloseSell) {
            const rsiVal = latestRsi as number;
            const target = openTrade.side === 'BUY' ? buyTarget : sellTarget;
            runtime.closedTradeIds.add(openTrade.id);
            const { updatedBalance } = await executePositionTransition({
              idToken,
              uid: runtime.uid,
              profile,
              creds,
              newSide: null,
              execPrice: livePrice,
              execRsi: rsiVal,
              eventTimeMs: nowMs,
              closeReason: 'RSI_CLOSE',
              currentOpen: openTrade,
              currentBalance: profile.paperBalanceUsdt
            });
            await fsUpdateProfile(idToken, runtime.uid, {
              paperBalanceUsdt: updatedBalance,
              slReentrySide: 'NONE',
              slReentryPrice: 0,
              slReentryStopLoss: 0
            });
            await fsRecordSignal(idToken, runtime.uid, {
              pair,
              timeframe,
              signalType: 'RSI_CLOSE',
              candleTimeMs: liveBar.openTime,
              price: livePrice,
              haOpen: liveBar.haOpen,
              haHigh: liveBar.haHigh,
              haLow: liveBar.haLow,
              haClose: liveBar.haClose,
              rsi: rsiVal,
              referenceLevel: target,
              executed: true,
              note: `24/7 Live Close RSI ${openTrade.side} @ ${fmtPrice(livePrice)} (RSI ${rsiVal.toFixed(1)}). Ready for next signal.`
            });
            runtime.lastSignalAt = nowMs;
            runtime.openTradeId = null;
            runtime.openTradeSide = null;
            runtime.lastAction = `Live RSI Close ${openTrade.side} @ ${fmtPrice(livePrice)} (RSI ${rsiVal.toFixed(1)})`;
            console.log(`[24/7 Engine] [${runtime.uid}] ${runtime.lastAction}`);
          }
        }
        return;
      }

      // B2. Evaluate all pending closed candles chronologically (real-time 1 bar OR offline catch-up)
      const firstPendingIdx = closedCandles.findIndex((c) => c.openTime === pendingCandles[0].openTime);
      const initialPrevHaClose = firstPendingIdx > 0 ? closedCandles[firstPendingIdx - 1].haClose : 0;

      let state: StrategyState = {
        armedSellRef: profile.armedSellRef || 0,
        armedBuyRef: profile.armedBuyRef || 0,
        armedSellWick: profile.armedSellWick || 0,
        armedBuyWick: profile.armedBuyWick || 0,
        armedSellCandleTime: profile.armedSellCandleTime || 0,
        armedBuyCandleTime: profile.armedBuyCandleTime || 0,
        openSide: openTrade && openTrade.pair === pair ? openTrade.side : null,
        openEntryPrice: openTrade && openTrade.pair === pair ? openTrade.entryPrice : 0,
        activeStopLoss: openTrade && openTrade.pair === pair ? openTrade.stopLossPrice || 0 : 0,
        slReentrySide: !profile.slReentrySide || profile.slReentrySide === 'NONE' ? null : profile.slReentrySide,
        slReentryPrice: profile.slReentryPrice || 0,
        slReentryStopLoss: profile.slReentryStopLoss || 0,
        lastHaClose: initialPrevHaClose
      };

      let activeOpen: TradeRecord | null = openTrade && openTrade.pair === pair ? openTrade : null;
      let activeBalance = profile.paperBalanceUsdt;
      let newestTime = profile.lastEvaluatedTime;
      const tfWindowMs = Math.max(180_000, timeframeToMs(timeframe) * 1.5);
      const latestPendingIdx = pendingCandles.length - 1;

      // Track whether existing activeOpen exited on a missed bar during catch-up so it never stays stuck open
      let pendingCatchupCloseReason: Exclude<CloseReason, 'NONE'> | null = null;
      let pendingCatchupClosePrice = 0;
      let pendingCatchupCloseRsi = 0;
      let pendingCatchupCloseTime = 0;

      for (let idx = 0; idx < pendingCandles.length; idx++) {
        const candle = pendingCandles[idx];
        const isLiveSlBar = runtime.slTriggeredCandleTime > 0 && candle.openTime === runtime.slTriggeredCandleTime;
        const savedSlWatch = isLiveSlBar
          ? {
              slReentrySide: state.slReentrySide,
              slReentryPrice: state.slReentryPrice,
              slReentryStopLoss: state.slReentryStopLoss
            }
          : null;
        const evalInputState = isLiveSlBar ? { ...state, slReentrySide: null } : state;

        const { nextState, events } = evaluateClosedCandle(candle, evalInputState, {
          boundaryMode: profile.boundaryMode || 'wick',
          rsiOverbought: profile.rsiOverbought ?? 80,
          rsiOversold: profile.rsiOversold ?? 22,
          buyCloseRsiEnabled: profile.buyCloseRsiEnabled ?? false,
          buyCloseRsi: profile.buyCloseRsi ?? 70,
          sellCloseRsiEnabled: profile.sellCloseRsiEnabled ?? false,
          sellCloseRsi: profile.sellCloseRsi ?? 30,
          stopLossEnabled: profile.stopLossEnabled ?? true
        });

        if (savedSlWatch && nextState.openSide === null) {
          nextState.slReentrySide = savedSlWatch.slReentrySide;
          nextState.slReentryPrice = savedSlWatch.slReentryPrice;
          nextState.slReentryStopLoss = savedSlWatch.slReentryStopLoss;
        }
        if (candle.openTime > runtime.slTriggeredCandleTime) {
          runtime.slTriggeredCandleTime = 0;
        }
        state = nextState;
        newestTime = candle.openTime;

        const isLatestClosed = idx === latestPendingIdx;
        const isFreshClose = nowMs - (candle.closeTime || candle.openTime) <= tfWindowMs;

        if (!isLatestClosed || !isFreshClose) {
          // Catch-up mode across missed bars: record events cleanly and close stale open trade if an exit/reversal happened
          for (const ev of events) {
            if (activeOpen && !pendingCatchupCloseReason) {
              if (ev.type === 'STOP_LOSS') {
                pendingCatchupCloseReason = 'STOP_LOSS';
                pendingCatchupClosePrice = ev.execPrice;
                pendingCatchupCloseRsi = ev.rsi;
                pendingCatchupCloseTime = candle.closeTime || candle.openTime;
              } else if (ev.type === 'RSI_CLOSE') {
                pendingCatchupCloseReason = 'RSI_CLOSE';
                pendingCatchupClosePrice = ev.execPrice;
                pendingCatchupCloseRsi = ev.rsi;
                pendingCatchupCloseTime = candle.closeTime || candle.openTime;
              } else if ((ev.type === 'BUY' || ev.type === 'SELL') && ev.type !== activeOpen.side) {
                pendingCatchupCloseReason = 'REVERSAL_SIGNAL';
                pendingCatchupClosePrice = ev.execPrice;
                pendingCatchupCloseRsi = ev.rsi;
                pendingCatchupCloseTime = candle.closeTime || candle.openTime;
              }
            }
            await fsRecordSignal(idToken, runtime.uid, {
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
              executed: ev.type === 'STOP_LOSS' || ev.type === 'RSI_CLOSE',
              note: `[Catch-up] ${ev.note}`
            });
          }
          continue;
        }

        // If an earlier missed candle already triggered closing the stale activeOpen, close it now before evaluating the fresh bar
        if (activeOpen && pendingCatchupCloseReason) {
          runtime.closedTradeIds.add(activeOpen.id);
          const closeRes = await executePositionTransition({
            idToken,
            uid: runtime.uid,
            profile,
            creds,
            newSide: null,
            execPrice: livePrice,
            execRsi: pendingCatchupCloseRsi,
            eventTimeMs: pendingCatchupCloseTime || nowMs,
            closeReason: pendingCatchupCloseReason,
            currentOpen: activeOpen,
            currentBalance: activeBalance
          });
          activeOpen = closeRes.createdTrade;
          activeBalance = closeRes.updatedBalance;
          pendingCatchupCloseReason = null;
          runtime.lastSignalAt = nowMs;
          runtime.lastAction = `Catch-up closed stale trade (${pendingCatchupClosePrice > 0 ? fmtPrice(pendingCatchupClosePrice) : fmtPrice(livePrice)})`;
        }

        // Freshly closed bar: execute live transitions immediately
        for (const ev of events) {
          if (ev.type === 'STOP_LOSS' && activeOpen) {
            runtime.closedTradeIds.add(activeOpen.id);
            const res = await executePositionTransition({
              idToken,
              uid: runtime.uid,
              profile,
              creds,
              newSide: null,
              execPrice: ev.execPrice,
              execRsi: ev.rsi,
              eventTimeMs: nowMs,
              closeReason: 'STOP_LOSS',
              currentOpen: activeOpen,
              currentBalance: activeBalance
            });
            activeOpen = res.createdTrade;
            activeBalance = res.updatedBalance;
            runtime.lastSignalAt = nowMs;
            runtime.lastAction = `24/7 SL Closed ${pair} @ ${fmtPrice(ev.execPrice)}`;
            console.log(`[24/7 Engine] [${runtime.uid}] ${runtime.lastAction}`);
          }

          if (ev.type === 'RSI_CLOSE' && activeOpen) {
            const closedSide = activeOpen.side;
            runtime.closedTradeIds.add(activeOpen.id);
            const res = await executePositionTransition({
              idToken,
              uid: runtime.uid,
              profile,
              creds,
              newSide: null,
              execPrice: ev.execPrice,
              execRsi: ev.rsi,
              eventTimeMs: nowMs,
              closeReason: 'RSI_CLOSE',
              currentOpen: activeOpen,
              currentBalance: activeBalance
            });
            activeOpen = res.createdTrade;
            activeBalance = res.updatedBalance;
            runtime.lastSignalAt = nowMs;
            runtime.lastAction = `24/7 RSI Closed ${closedSide} ${pair} @ ${fmtPrice(ev.execPrice)} (RSI ${ev.rsi.toFixed(1)})`;
            console.log(`[24/7 Engine] [${runtime.uid}] ${runtime.lastAction}`);
          }

          const isTradeEntry = ev.type === 'BUY' || ev.type === 'SELL';
          if (isTradeEntry) {
            if (activeOpen) runtime.closedTradeIds.add(activeOpen.id);
            const res = await executePositionTransition({
              idToken,
              uid: runtime.uid,
              profile,
              creds,
              newSide: ev.type as TradeSide,
              execPrice: ev.execPrice,
              execRsi: ev.rsi,
              eventTimeMs: nowMs,
              closeReason: 'REVERSAL_SIGNAL',
              currentOpen: activeOpen,
              currentBalance: activeBalance,
              stopLossPrice: ev.stopLossPrice || 0
            });
            activeOpen = res.createdTrade;
            activeBalance = res.updatedBalance;
            runtime.lastSignalAt = nowMs;
            runtime.lastAction = `24/7 Opened ${ev.type} ${pair} @ ${fmtPrice(ev.execPrice)} (${timeframe} RSI ${ev.rsi.toFixed(1)})`;
            console.log(`[24/7 Engine] [${runtime.uid}] ${runtime.lastAction}`);
          }

          await fsRecordSignal(idToken, runtime.uid, {
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
        }
      }

      // If all pending candles were older than tfWindowMs (e.g., server woke up after long downtime)
      // and activeOpen should have exited during that downtime, make sure it is closed NOW!
      if (activeOpen && pendingCatchupCloseReason) {
        runtime.closedTradeIds.add(activeOpen.id);
        const closeRes = await executePositionTransition({
          idToken,
          uid: runtime.uid,
          profile,
          creds,
          newSide: null,
          execPrice: livePrice,
          execRsi: pendingCatchupCloseRsi,
          eventTimeMs: pendingCatchupCloseTime || nowMs,
          closeReason: pendingCatchupCloseReason,
          currentOpen: activeOpen,
          currentBalance: activeBalance
        });
        activeOpen = closeRes.createdTrade;
        activeBalance = closeRes.updatedBalance;
        runtime.lastSignalAt = nowMs;
        runtime.lastAction = `Catch-up closed stale trade @ ${fmtPrice(livePrice)} (${pendingCatchupCloseReason})`;
        console.log(`[24/7 Engine] [${runtime.uid}] ${runtime.lastAction}`);
      }

      const nextReentrySide: TradeSide | 'NONE' = state.slReentrySide ?? 'NONE';
      await fsUpdateProfile(idToken, runtime.uid, {
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

      runtime.openTradeId = activeOpen?.id ?? null;
      runtime.openTradeSide = activeOpen?.side ?? null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      runtime.lastError = msg;
      console.error(`[24/7 Engine] [${runtime.uid}] Tick error:`, msg);
    } finally {
      userLocks.delete(runtime.uid);
    }
  }

  async function runCycle(): Promise<void> {
    if (loopRunning || workers.size === 0) return;
    loopRunning = true;
    try {
      const list = Array.from(workers.values());
      await Promise.all(list.map((w) => processSingleUser(w)));
    } finally {
      loopRunning = false;
    }
  }

  async function registerWorker(uid: string, refreshToken: string): Promise<PublicWorkerStatus> {
    if (!uid || !refreshToken) {
      throw new Error('uid and refreshToken are required');
    }
    const existing = workers.get(uid);
    const runtime: ActiveWorkerRuntime = existing
      ? {
          ...existing,
          refreshToken,
          idToken: existing.refreshToken === refreshToken ? existing.idToken : '',
          tokenExpiresAt: existing.refreshToken === refreshToken ? existing.tokenExpiresAt : 0,
          lastError: null
        }
      : {
          uid,
          refreshToken,
          registeredAt: Date.now(),
          idToken: '',
          tokenExpiresAt: 0,
          lastTickAt: 0,
          lastSignalAt: 0,
          lastAction: '24/7 Cloud Worker synced',
          lastError: null,
          botActive: false,
          openTradeId: null,
          openTradePair: null,
          openTradeSide: null,
          pair: 'BTCUSDT',
          timeframe: '15m',
          slTriggeredCandleTime: 0,
          closedTradeIds: new Set()
        };

    // Validate token right away so client knows registration succeeded
    await ensureFreshIdToken(runtime);
    workers.set(uid, runtime);
    persistWorkersToDisk();

    // Run immediate evaluation without blocking response long
    await processSingleUser(runtime);
    return getStatus(uid);
  }

  function unregisterWorker(uid: string): void {
    if (workers.delete(uid)) {
      persistWorkersToDisk();
    }
  }

  function getStatus(uid?: string): PublicWorkerStatus {
    const w = uid ? workers.get(uid) : undefined;
    if (!w) {
      return {
        registered: false,
        running247: workers.size > 0,
        botActive: false,
        hasOpenTrade: false,
        openTradeSide: null,
        pair: null,
        timeframe: null,
        lastTickAt: 0,
        lastSignalAt: 0,
        lastAction: '',
        lastError: null,
        workerCount: workers.size
      };
    }
    return {
      registered: true,
      running247: true,
      botActive: w.botActive,
      hasOpenTrade: Boolean(w.openTradeId),
      openTradeSide: w.openTradeSide,
      pair: w.pair,
      timeframe: w.timeframe,
      lastTickAt: w.lastTickAt,
      lastSignalAt: w.lastSignalAt,
      lastAction: w.lastAction,
      lastError: w.lastError,
      workerCount: workers.size
    };
  }

  let intervalHandle: NodeJS.Timeout | null = null;

  function start(): void {
    loadWorkersFromDisk();
    if (intervalHandle) return;
    intervalHandle = setInterval(() => {
      runCycle().catch((err) => console.error('[24/7 Engine] Cycle error:', err));
    }, 4000);
    // Run first cycle shortly after startup if restored sessions exist
    setTimeout(() => {
      runCycle().catch((err) => console.error('[24/7 Engine] Startup cycle error:', err));
    }, 1500);
    console.log('[24/7 Engine] Autonomous background trading loop started (4s interval).');
  }

  return {
    start,
    runCycle,
    registerWorker,
    unregisterWorker,
    getStatus
  };
}
