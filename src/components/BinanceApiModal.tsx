import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, KeyRound, Lock, LogIn, ShieldCheck, Trash2, X } from 'lucide-react';
import type { BinanceCredentialsState, Language } from '../types/trading';
import { t } from '../lib/i18n';

interface BinanceApiModalProps {
  open: boolean;
  language: Language;
  isSignedIn: boolean;
  userEmail: string | null;
  credentials: BinanceCredentialsState;
  onSignIn: () => void;
  onSave: (payload: {
    apiKey: string;
    apiSecret: string;
    testnet: boolean;
    enabled: boolean;
  }) => Promise<void>;
  onDelete: () => Promise<void>;
  onClose: () => void;
}

export const BinanceApiModal: React.FC<BinanceApiModalProps> = ({
  open,
  language,
  isSignedIn,
  userEmail,
  credentials,
  onSignIn,
  onSave,
  onDelete,
  onClose
}) => {
  const copy = t(language);
  const [apiKey, setApiKey] = useState('');
  const [apiSecret, setApiSecret] = useState('');
  const [testnet, setTestnet] = useState(true);
  const [enabled, setEnabled] = useState(true);
  const [showKey, setShowKey] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!open) return;
    setApiKey(credentials.apiKey || '');
    setApiSecret(credentials.apiSecret || '');
    setTestnet(credentials.hasKeys ? credentials.testnet : true);
    setEnabled(credentials.hasKeys ? credentials.enabled : true);
    setShowKey(false);
    setShowSecret(false);
    setTestResult(null);
  }, [open, credentials]);

  if (!open) return null;

  const handleTest = async () => {
    const k = apiKey.trim();
    const s = apiSecret.trim();
    if (!k || !s) {
      setTestResult({ ok: false, message: 'Please enter both API Key and API Secret.' });
      return;
    }
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/binance/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: k, apiSecret: s, testnet })
      });
      const data = (await res.json()) as {
        ok?: boolean;
        network?: string;
        usdtBalance?: number;
        availableBalance?: number;
        error?: string;
      };
      if (res.ok && data.ok) {
        setTestResult({
          ok: true,
          message: `Connected (${data.network}) · Wallet: $${Number(data.usdtBalance || 0).toFixed(2)} USDT · Avail: $${Number(data.availableBalance || 0).toFixed(2)}`
        });
      } else {
        setTestResult({
          ok: false,
          message: data.error || 'Binance verification failed'
        });
      }
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Connection failed'
      });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const k = apiKey.trim();
    const s = apiSecret.trim();
    if (!k || !s) {
      setTestResult({ ok: false, message: 'Please enter both API Key and API Secret.' });
      return;
    }
    setSaving(true);
    try {
      await onSave({ apiKey: k, apiSecret: s, testnet, enabled });
      onClose();
    } catch (err) {
      setTestResult({
        ok: false,
        message: err instanceof Error ? err.message : 'Failed to save credentials'
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setSaving(true);
    try {
      await onDelete();
      setApiKey('');
      setApiSecret('');
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-md bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-sky-400" />
            <h3 className="text-sm font-semibold text-white">{copy.binanceApiModalTitle}</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {!isSignedIn ? (
          <div className="p-5 space-y-4">
            <div className="flex items-start gap-3 bg-slate-900/70 border border-slate-800 rounded-xl p-4">
              <Lock className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <p className="text-xs text-slate-300 leading-relaxed">
                {copy.binanceApiSignInRequired}
              </p>
            </div>
            <button
              type="button"
              onClick={() => {
                onClose();
                onSignIn();
              }}
              className="w-full min-h-[44px] px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold flex items-center justify-center gap-2 transition-colors"
            >
              <LogIn className="w-4 h-4" />
              <span>{copy.signIn}</span>
            </button>
          </div>
        ) : (
          <form onSubmit={handleSave} className="p-5 space-y-4">
            {/* Account Isolation Notice */}
            <div className="flex items-start gap-2.5 bg-emerald-950/30 border border-emerald-800/50 rounded-xl p-3">
              <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
              <div className="text-[11px] text-slate-300 leading-relaxed">
                <div>{copy.binanceApiIsolationNote}</div>
                {userEmail && (
                  <div className="font-mono text-emerald-300 mt-1 truncate">{userEmail}</div>
                )}
              </div>
            </div>

            {/* Network Switcher */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                {copy.binanceApiNetwork}
              </label>
              <div className="grid grid-cols-2 gap-1 p-1 bg-slate-900 border border-slate-800 rounded-lg">
                <button
                  type="button"
                  onClick={() => setTestnet(true)}
                  className={`min-h-[36px] text-xs font-medium rounded-md transition-colors ${
                    testnet ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {copy.binanceApiTestnet}
                </button>
                <button
                  type="button"
                  onClick={() => setTestnet(false)}
                  className={`min-h-[36px] text-xs font-medium rounded-md transition-colors ${
                    !testnet ? 'bg-amber-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {copy.binanceApiLive}
                </button>
              </div>
            </div>

            {/* API Key */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                {copy.binanceApiKeyLabel}
              </label>
              <div className="relative">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Enter your Binance Futures API Key"
                  className="w-full min-h-[42px] pl-3 pr-10 py-2 text-xs font-mono bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((v) => !v)}
                  aria-label={showKey ? 'Hide API Key' : 'Show API Key'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-1"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* API Secret */}
            <div>
              <label className="block text-xs text-slate-400 mb-1.5">
                {copy.binanceApiSecretLabel}
              </label>
              <div className="relative">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={apiSecret}
                  onChange={(e) => setApiSecret(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="Enter your Binance Futures API Secret"
                  className="w-full min-h-[42px] pl-3 pr-10 py-2 text-xs font-mono bg-slate-900 border border-slate-800 rounded-lg text-slate-100 focus:outline-none focus:border-sky-500"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((v) => !v)}
                  aria-label={showSecret ? 'Hide API Secret' : 'Show API Secret'}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-200 p-1"
                >
                  {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
            </div>

            {/* Enable Real Execution Toggle */}
            <label className="flex items-center justify-between gap-3 pt-1 cursor-pointer">
              <span className="text-xs text-slate-300">{copy.binanceApiEnableLive}</span>
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="w-4 h-4 accent-emerald-500 rounded shrink-0"
              />
            </label>

            {testResult && (
              <div
                className={`rounded-xl px-3 py-2.5 text-xs font-mono border ${
                  testResult.ok
                    ? 'bg-emerald-950/40 border-emerald-800/60 text-emerald-300'
                    : 'bg-rose-950/40 border-rose-800/60 text-rose-300'
                }`}
              >
                {testResult.message}
              </div>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={handleTest}
                disabled={testing || saving}
                className="flex-1 min-h-[42px] px-3 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 text-xs font-semibold text-slate-100 transition-colors"
              >
                {testing ? copy.binanceApiTesting : copy.binanceApiTestBtn}
              </button>
              <button
                type="submit"
                disabled={saving || testing}
                className="flex-1 min-h-[42px] px-3 py-2 rounded-xl bg-sky-600 hover:bg-sky-500 disabled:opacity-60 text-xs font-semibold text-white transition-colors"
              >
                {saving ? copy.binanceApiSaving : copy.binanceApiSaveBtn}
              </button>
            </div>

            {credentials.hasKeys && (
              <button
                type="button"
                onClick={handleDelete}
                disabled={saving}
                className="w-full min-h-[38px] px-3 py-2 rounded-xl bg-rose-950/50 hover:bg-rose-900/60 border border-rose-800/50 text-rose-300 text-xs font-medium flex items-center justify-center gap-1.5 transition-colors"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>{copy.binanceApiDeleteBtn}</span>
              </button>
            )}
          </form>
        )}
      </div>
    </div>
  );
};
