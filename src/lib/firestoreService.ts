import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  type Unsubscribe
} from 'firebase/firestore';
import type { User } from 'firebase/auth';
import { db, handleFirestoreError, OperationType } from './firebase';
import { encryptForUser, maskApiKey } from './cryptoVault';
import type {
  CloseReason,
  EncryptedBinanceCredentialsDoc,
  SignalRecord,
  TradeRecord,
  UserBotProfile
} from '../types/trading';

export function buildDefaultUserProfile(user: User): Omit<UserBotProfile, 'createdAt' | 'updatedAt'> {
  const safeName = (user.displayName || user.email?.split('@')[0] || 'Trader').slice(0, 120);
  const safeEmail = (user.email || 'trader@example.com').slice(0, 200);
  return {
    userId: user.uid,
    displayName: safeName.length > 0 ? safeName : 'Trader',
    email: safeEmail.length >= 3 ? safeEmail : 'trader@example.com',
    language: 'en',
    selectedPair: 'BTCUSDT',
    timeframe: '15m',
    leverage: 20,
    marginUsdt: 100,
    marginMode: 'ISOLATED',
    boundaryMode: 'wick',
    rsiPeriod: 14,
    rsiOverbought: 80,
    rsiOversold: 22,
    buyCloseRsiEnabled: false,
    buyCloseRsi: 70,
    sellCloseRsiEnabled: false,
    sellCloseRsi: 30,
    botActive: false,
    stopLossEnabled: true,
    paperBalanceUsdt: 10000,
    lastEvaluatedTime: 0,
    armedSellRef: 0,
    armedBuyRef: 0,
    armedSellWick: 0,
    armedBuyWick: 0,
    armedSellCandleTime: 0,
    armedBuyCandleTime: 0,
    slReentrySide: 'NONE',
    slReentryPrice: 0,
    slReentryStopLoss: 0
  };
}

export async function ensureUserProfile(user: User): Promise<UserBotProfile> {
  const path = `users/${user.uid}`;
  const ref = doc(db, 'users', user.uid);
  try {
    const snap = await getDoc(ref);
    if (snap.exists()) {
      return snap.data() as UserBotProfile;
    }
    const defaults = buildDefaultUserProfile(user);
    await setDoc(ref, {
      ...defaults,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return defaults;
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export function subscribeUserProfile(
  userId: string,
  onData: (profile: UserBotProfile | null) => void
): Unsubscribe {
  const path = `users/${userId}`;
  return onSnapshot(
    doc(db, 'users', userId),
    (snap) => {
      onData(snap.exists() ? (snap.data() as UserBotProfile) : null);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export function subscribeUserTrades(
  userId: string,
  onData: (trades: TradeRecord[]) => void
): Unsubscribe {
  const path = `users/${userId}/trades`;
  const q = query(
    collection(db, 'users', userId, 'trades'),
    where('ownerId', '==', userId),
    orderBy('openedAtMs', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const items: TradeRecord[] = snap.docs.map((d) => ({
        ...(d.data() as Omit<TradeRecord, 'id'>),
        id: d.id
      }));
      onData(items);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export function subscribeUserSignals(
  userId: string,
  onData: (signals: SignalRecord[]) => void
): Unsubscribe {
  const path = `users/${userId}/signals`;
  const q = query(
    collection(db, 'users', userId, 'signals'),
    where('ownerId', '==', userId),
    orderBy('candleTimeMs', 'desc')
  );
  return onSnapshot(
    q,
    (snap) => {
      const items: SignalRecord[] = snap.docs.map((d) => ({
        ...(d.data() as Omit<SignalRecord, 'id'>),
        id: d.id
      }));
      onData(items);
    },
    (error) => {
      handleFirestoreError(error, OperationType.LIST, path);
    }
  );
}

export async function updateUserConfig(
  userId: string,
  patch: Partial<
    Pick<
      UserBotProfile,
      | 'selectedPair'
      | 'timeframe'
      | 'leverage'
      | 'marginUsdt'
      | 'marginMode'
      | 'boundaryMode'
      | 'rsiPeriod'
      | 'rsiOverbought'
      | 'rsiOversold'
      | 'buyCloseRsiEnabled'
      | 'buyCloseRsi'
      | 'sellCloseRsiEnabled'
      | 'sellCloseRsi'
      | 'stopLossEnabled'
      | 'language'
      | 'displayName'
      | 'botActive'
      | 'lastEvaluatedTime'
      | 'armedSellRef'
      | 'armedBuyRef'
      | 'armedSellWick'
      | 'armedBuyWick'
      | 'armedSellCandleTime'
      | 'armedBuyCandleTime'
      | 'slReentrySide'
      | 'slReentryPrice'
      | 'slReentryStopLoss'
      | 'paperBalanceUsdt'
    >
  >
): Promise<void> {
  const path = `users/${userId}`;
  try {
    await updateDoc(doc(db, 'users', userId), {
      ...patch,
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function createOpenTrade(
  userId: string,
  trade: Omit<TradeRecord, 'id' | 'createdAt' | 'updatedAt'>
): Promise<string> {
  const tradeId = `tr_${trade.openedAtMs}_${trade.side}_${Math.random().toString(36).slice(2, 6)}`;
  const path = `users/${userId}/trades/${tradeId}`;
  try {
    await setDoc(doc(db, 'users', userId, 'trades', tradeId), {
      ownerId: userId,
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
      closedAtMs: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });
    return tradeId;
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export async function closeExistingTrade(
  userId: string,
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
  const path = `users/${userId}/trades/${tradeId}`;
  try {
    await updateDoc(doc(db, 'users', userId, 'trades', tradeId), {
      status: 'CLOSED',
      exitPrice: Number(payload.exitPrice),
      realizedPnl: Number(payload.realizedPnl.toFixed(4)),
      realizedRoiPct: Number(payload.realizedRoiPct.toFixed(2)),
      exitRsi: Math.min(100, Math.max(0, Number(payload.exitRsi))),
      closeReason: payload.closeReason,
      closedAtMs: Number(payload.closedAtMs),
      updatedAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}

export async function recordSignal(
  userId: string,
  signal: Omit<SignalRecord, 'id' | 'createdAt'>
): Promise<void> {
  const signalId = `sig_${signal.pair}_${signal.timeframe}_${signal.candleTimeMs}_${signal.signalType}`;
  const path = `users/${userId}/signals/${signalId}`;
  try {
    const existing = await getDoc(doc(db, 'users', userId, 'signals', signalId));
    if (existing.exists()) return;
    await setDoc(doc(db, 'users', userId, 'signals', signalId), {
      ownerId: userId,
      pair: signal.pair,
      timeframe: signal.timeframe,
      signalType: signal.signalType,
      candleTimeMs: Number(signal.candleTimeMs),
      price: Number(signal.price),
      haOpen: Number(signal.haOpen),
      haHigh: Number(signal.haHigh),
      haLow: Number(signal.haLow),
      haClose: Number(signal.haClose),
      rsi: Math.min(100, Math.max(0, Number(signal.rsi))),
      referenceLevel: Number(signal.referenceLevel),
      executed: Boolean(signal.executed),
      note: signal.note.slice(0, 240),
      createdAt: serverTimestamp()
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, path);
  }
}

export function subscribeUserBinanceCredentials(
  userId: string,
  onData: (creds: EncryptedBinanceCredentialsDoc | null) => void
): Unsubscribe {
  const path = `users/${userId}/private/binanceCredentials`;
  return onSnapshot(
    doc(db, 'users', userId, 'private', 'binanceCredentials'),
    (snap) => {
      onData(snap.exists() ? (snap.data() as EncryptedBinanceCredentialsDoc) : null);
    },
    (error) => {
      handleFirestoreError(error, OperationType.GET, path);
    }
  );
}

export async function saveUserBinanceCredentials(
  userId: string,
  payload: {
    apiKey: string;
    apiSecret: string;
    testnet: boolean;
    enabled: boolean;
  }
): Promise<void> {
  const path = `users/${userId}/private/binanceCredentials`;
  const ref = doc(db, 'users', userId, 'private', 'binanceCredentials');
  const trimmedKey = payload.apiKey.trim();
  const trimmedSecret = payload.apiSecret.trim();

  try {
    const encryptedKey = await encryptForUser(userId, trimmedKey);
    const encryptedSecret = await encryptForUser(userId, trimmedSecret);
    const keyPreview = maskApiKey(trimmedKey).slice(0, 40);

    const existing = await getDoc(ref);
    if (existing.exists()) {
      await updateDoc(ref, {
        encryptedKey,
        encryptedSecret,
        keyPreview,
        testnet: Boolean(payload.testnet),
        enabled: Boolean(payload.enabled),
        updatedAt: serverTimestamp()
      });
    } else {
      await setDoc(ref, {
        ownerId: userId,
        encryptedKey,
        encryptedSecret,
        keyPreview,
        testnet: Boolean(payload.testnet),
        enabled: Boolean(payload.enabled),
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function deleteUserBinanceCredentials(userId: string): Promise<void> {
  const path = `users/${userId}/private/binanceCredentials`;
  try {
    await deleteDoc(doc(db, 'users', userId, 'private', 'binanceCredentials'));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}
