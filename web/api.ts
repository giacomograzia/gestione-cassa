import { useEffect, useRef, useState } from 'react';
import type { RealtimeEvent } from '../shared/types';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${url}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const isJson = res.headers.get('content-type')?.includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) throw new ApiError(res.status, (isJson && data?.error) || `Errore ${res.status}`);
  return data as T;
}

export const get = <T = any>(url: string) => api<T>('GET', url);
export const post = <T = any>(url: string, body: unknown = {}) => api<T>('POST', url, body);
export const put = <T = any>(url: string, body: unknown) => api<T>('PUT', url, body);
export const del = <T = any>(url: string) => api<T>('DELETE', url);

export const euro = (cents: number) =>
  (cents / 100).toLocaleString('it-IT', { style: 'currency', currency: 'EUR' });

/** Converte "12,50" o "12.5" in centesimi; null se non valido. */
export function parseEuro(s: string): number | null {
  const n = Number(s.replace(',', '.'));
  return s.trim() !== '' && Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

type Listener = (e: RealtimeEvent) => void;
const listeners = new Set<Listener>();
let socket: WebSocket | null = null;
let connected = false;
const statusListeners = new Set<(c: boolean) => void>();

function connect() {
  if (socket) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  socket = ws;
  ws.onopen = () => {
    connected = true;
    statusListeners.forEach((l) => l(true));
    // dopo una riconnessione ricarichiamo tutto: potremmo aver perso eventi
    listeners.forEach((l) => l({ type: 'catalog' }));
    listeners.forEach((l) => l({ type: 'kitchen' }));
  };
  ws.onmessage = (m) => {
    const e = JSON.parse(m.data) as RealtimeEvent;
    listeners.forEach((l) => l(e));
  };
  ws.onclose = (ev) => {
    if (socket !== ws) return; // socket già sostituito da reconnectRealtime
    socket = null;
    connected = false;
    statusListeners.forEach((l) => l(false));
    // 4401 = non autenticato: si riconnette solo dopo l'accesso (reconnectRealtime)
    if (ev.code !== 4401) setTimeout(connect, 2000);
  };
}

/** Da chiamare dopo accesso/uscita: riapre il canale con la sessione attuale. */
export function reconnectRealtime() {
  const old = socket;
  socket = null;
  connected = false;
  old?.close();
  connect();
}

/** Esegue `onEvent` a ogni evento in tempo reale dal server. */
export function useRealtime(onEvent: Listener) {
  const ref = useRef(onEvent);
  ref.current = onEvent;
  useEffect(() => {
    connect();
    const l: Listener = (e) => ref.current(e);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
}

export function useConnected() {
  const [c, setC] = useState(connected);
  useEffect(() => {
    connect();
    statusListeners.add(setC);
    return () => {
      statusListeners.delete(setC);
    };
  }, []);
  return c;
}

/** Carica dati da un endpoint e li ricarica quando arriva uno degli eventi indicati. */
export function useLoad<T>(url: string | null, events: RealtimeEvent['type'][] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useRef<() => void>(() => {});
  reload.current = () => {
    if (!url) return;
    get<T>(url)
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(e.message));
  };
  useEffect(() => reload.current(), [url]);
  useRealtime((e) => {
    if (events.includes(e.type)) reload.current();
  });
  return { data, error, reload: () => reload.current(), setData };
}

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key);
      return v === null ? initial : (JSON.parse(v) as T);
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, JSON.stringify(v));
    } catch {
      /* archiviazione non disponibile: resta solo in memoria */
    }
  };
  return [value, set] as const;
}
