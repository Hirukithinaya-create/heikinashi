import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Share2, X } from 'lucide-react';
import type { Language } from '../types/trading';
import { t } from '../lib/i18n';

interface ShareAppModalProps {
  open: boolean;
  language: Language;
  onClose: () => void;
}

function resolveSharedAppUrl(): string {
  if (typeof window === 'undefined') return '';
  const origin = window.location.origin;
  if (origin.includes('://ais-dev-')) {
    return origin.replace('://ais-dev-', '://ais-pre-');
  }
  return origin;
}

export const ShareAppModal: React.FC<ShareAppModalProps> = ({
  open,
  language,
  onClose
}) => {
  const copy = t(language);
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const shareUrl = resolveSharedAppUrl();

  useEffect(() => {
    if (!open || !shareUrl) return;
    QRCode.toDataURL(shareUrl, {
      width: 240,
      margin: 2,
      color: {
        dark: '#090D16',
        light: '#FFFFFF'
      }
    })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [open, shareUrl]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard fallback ignored
    }
  };

  const handleNativeShare = async () => {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      try {
        await navigator.share({
          title: 'HeikinPulse Binance Auto-Trader',
          text: copy.shareSubtitle,
          url: shareUrl
        });
      } catch {
        // User cancelled share
      }
    } else {
      handleCopy();
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/75 backdrop-blur-sm p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-md bg-slate-900 border border-slate-800 rounded-t-2xl sm:rounded-2xl overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800">
          <h3 className="text-sm font-semibold text-slate-100">{copy.shareTitle}</h3>
          <button
            type="button"
            onClick={onClose}
            className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-400 leading-relaxed">{copy.shareSubtitle}</p>

          {/* QR Code Frame */}
          <div className="flex justify-center">
            <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-inner">
              {qrDataUrl ? (
                <img
                  src={qrDataUrl}
                  alt="App Share QR Code"
                  className="w-48 h-48 block"
                />
              ) : (
                <div className="w-48 h-48 flex items-center justify-center text-xs text-slate-500">
                  Generating QR...
                </div>
              )}
            </div>
          </div>

          {/* Copyable Direct Shared App Link */}
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="flex-1 min-h-[42px] px-3 py-2 text-xs font-mono bg-slate-950 border border-slate-800 rounded-lg text-slate-200 focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCopy}
              className="min-h-[42px] px-3.5 py-2 rounded-lg text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-100 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors"
            >
              {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copied ? copy.copied : copy.copyLink}</span>
            </button>
          </div>

          <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-[11px] text-amber-200 leading-relaxed">
            {copy.shareUrlNote}
          </div>

          <button
            type="button"
            onClick={handleNativeShare}
            className="w-full min-h-[44px] px-4 py-2.5 rounded-xl text-xs font-semibold bg-sky-600 hover:bg-sky-500 text-white flex items-center justify-center gap-2 transition-colors"
          >
            <Share2 className="w-4 h-4" />
            <span>{copy.nativeShare}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
