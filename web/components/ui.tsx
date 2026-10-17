import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export function Modal(props: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div className={`modal ${props.wide ? 'wide' : ''}`} role="dialog" aria-label={props.title}>
        <header>
          <h2>{props.title}</h2>
          <button className="ghost icon" onClick={props.onClose} aria-label="Chiudi">✕</button>
        </header>
        <div className="modal-body">{props.children}</div>
      </div>
    </div>
  );
}

/** Tastierino numerico touch; `decimal` abilita la virgola. */
export function Keypad(props: { value: string; onChange: (v: string) => void; decimal?: boolean }) {
  const press = (k: string) => {
    if (k === '⌫') return props.onChange(props.value.slice(0, -1));
    if (k === 'C') return props.onChange('');
    if (k === ',' && (!props.decimal || props.value.includes(','))) return;
    if (props.decimal && /,\d\d$/.test(props.value)) return;
    props.onChange(props.value + k);
  };
  const keys = ['7', '8', '9', '4', '5', '6', '1', '2', '3', props.decimal ? ',' : 'C', '0', '⌫'];
  return (
    <div className="keypad">
      {keys.map((k) => (
        <button key={k} type="button" onClick={() => press(k)}>{k}</button>
      ))}
    </div>
  );
}

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
const ToastCtx = createContext<(text: string, kind?: Toast['kind']) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, kind: Toast['kind'] = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 6000 : 2500);
  }, []);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function Field(props: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="field">
      <span>{props.label}</span>
      {props.children}
      {props.hint && <small>{props.hint}</small>}
    </label>
  );
}
