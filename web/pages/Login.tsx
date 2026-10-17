import { useEffect, useState, type FormEvent } from 'react';
import { get, post } from '../api';
import { Field, Keypad, useToast } from '../components/ui';

export function Setup({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState('');
  const [pin, setPin] = useState('');
  const [pin2, setPin2] = useState('');
  const toast = useToast();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pin !== pin2) return toast('I due PIN non coincidono', 'error');
    try {
      await post('/setup', { name, pin });
      onDone();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <div className="center-screen">
      <form className="card login" onSubmit={submit}>
        <h1>Benvenuto in Nuova Cassa</h1>
        <p className="muted">Crea l'utente amministratore. Potrai aggiungere cassieri e cucina dalla Gestione.</p>
        <Field label="Nome">
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={40} />
        </Field>
        <Field label="PIN (4-8 cifre)">
          <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" pattern="\d{4,8}" required />
        </Field>
        <Field label="Ripeti PIN">
          <input value={pin2} onChange={(e) => setPin2(e.target.value)} type="password" inputMode="numeric" required />
        </Field>
        <button className="primary big">Crea e accedi</button>
      </form>
    </div>
  );
}

export function Login({ onDone }: { onDone: () => void }) {
  const [operators, setOperators] = useState<{ id: number; name: string; role: string }[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [pin, setPin] = useState('');
  const toast = useToast();
  useEffect(() => {
    get('/auth/operators').then(setOperators).catch((e) => toast(e.message, 'error'));
  }, []);

  const login = async () => {
    if (selected === null) return;
    try {
      await post('/auth/login', { operatorId: selected, pin });
      onDone();
    } catch (e) {
      setPin('');
      toast((e as Error).message, 'error');
    }
  };

  useEffect(() => {
    if (selected === null) return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p + e.key).slice(0, 8));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void login();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="center-screen">
      <div className="card login">
        <h1>Accesso</h1>
        {selected === null ? (
          <div className="operator-grid">
            {operators.map((o) => (
              <button key={o.id} className="big" onClick={() => setSelected(o.id)}>
                {o.name}
                <small>{o.role}</small>
              </button>
            ))}
          </div>
        ) : (
          <>
            <p>
              <button className="ghost" onClick={() => { setSelected(null); setPin(''); }}>← </button>
              <strong>{operators.find((o) => o.id === selected)?.name}</strong>: inserisci il PIN
            </p>
            <div className="pin-dots" aria-label={`${pin.length} cifre inserite`}>
              {'●'.repeat(pin.length) || <span className="muted">— — — —</span>}
            </div>
            <Keypad value={pin} onChange={(v) => setPin(v.slice(0, 8))} />
            <button className="primary big" onClick={login} disabled={pin.length < 4}>Entra</button>
          </>
        )}
      </div>
    </div>
  );
}
