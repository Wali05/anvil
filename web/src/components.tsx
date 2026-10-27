import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ConditionId, TrialStatus } from './types';
import { copyText } from './api';

export function AnvilMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="anvil-mark">
      <g fill="currentColor">
        <path d="M1 12 4.8 9.6v4.8L1 12Z" />
        <path d="M4 10h18l7 2-7 2H4v-4Z" />
        <path d="M11 14h6.8l-1.2 7.2h-4.1L11 14Z" />
        <path d="M7 21.2h13.4V24H7v-2.8Z" />
        <path d="M4 24h20.6l-2.2 4.2H6.1L4 24Z" />
      </g>
    </svg>
  );
}

const STATUS_LABEL: Record<TrialStatus, string> = {
  pass: 'Pass',
  fail: 'Fail',
  invalid: 'Invalid',
  error: 'Error',
  canceled: 'Canceled',
};

export function StatusChip({ status, reason }: { status: TrialStatus; reason?: string | null }) {
  return (
    <span className={`status status-${status}`} title={reason ?? undefined}>
      <span className="status-dot" aria-hidden="true" />
      {STATUS_LABEL[status]}
    </span>
  );
}

export function StatusWord({ status }: { status: string }) {
  return <span className={`status-word status-word-${status}`}>{status}</span>;
}

export const CONDITION_LABEL: Record<ConditionId, string> = {
  original: 'Original',
  descriptions: 'Descriptions',
  adapted: 'Adapted',
};

export const CONDITION_NOTE: Record<ConditionId, string> = {
  original: 'Raw tools: names, nested schemas, executor and outputs unchanged.',
  descriptions: 'Same names and schemas; tool and field descriptions improved only.',
  adapted: 'Executable adapters through the same original executors; v2 lookups add one read-only exact-match search.',
};

export function JsonBlock({
  value,
  maxHeight = 320,
  label,
}: {
  value: unknown;
  maxHeight?: number;
  label?: string;
}) {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    text = String(value);
  }
  return (
    <div className="json-wrap">
      {label ? <div className="json-label mono">{label}</div> : null}
      <pre className="json mono" style={{ maxHeight }} tabIndex={0} aria-label={label ?? 'JSON value'}>
        {text}
      </pre>
    </div>
  );
}

export function CopyButton({ text, label = 'Copy', compact = false }: { text: string; label?: string; compact?: boolean }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className={compact ? 'btn btn-ghost btn-small' : 'btn btn-ghost'}
      onClick={async () => {
        try {
          await copyText(text);
          setCopied(true);
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setCopied(false), 1600);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? 'Copied' : label}
    </button>
  );
}

export function Modal({
  open,
  title,
  subtitle,
  onClose,
  children,
  width = 680,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  width?: number;
}) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    panel.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div
        className="modal"
        style={{ maxWidth: width }}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        ref={panel}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div>
            <h2 id="modal-title">{title}</h2>
            {subtitle ? <p className="muted small">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close dialog">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3l10 10M13 3L3 13" stroke="currentColor" strokeWidth="1.6" />
            </svg>
          </button>
        </header>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function Banner({
  tone = 'neutral',
  title,
  children,
}: {
  tone?: 'neutral' | 'info' | 'warning' | 'danger' | 'success';
  title?: string;
  children: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === 'danger' ? 'alert' : 'status'}>
      {title ? <strong className="banner-title">{title}</strong> : null}
      <div>{children}</div>
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner-wrap" role="status">
      <span className="spinner" aria-hidden="true" />
      <span className="mono small">{label}</span>
    </span>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string; disabled?: boolean }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          className={option.value === value ? 'seg-btn is-active' : 'seg-btn'}
          aria-pressed={option.value === value}
          disabled={option.disabled}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className={open ? 'chevron is-open' : 'chevron'}>
      <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.4" fill="none" />
    </svg>
  );
}

export function EmptyMark() {
  return (
    <span className="empty-mark" aria-hidden="true">
      <AnvilMark size={76} />
    </span>
  );
}