import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;

/**
 * Migrazioni in ordine. Ogni elemento viene eseguito una sola volta;
 * la versione applicata è salvata in `PRAGMA user_version`.
 * Non modificare migrazioni già rilasciate: aggiungerne di nuove in coda.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE operators (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pin_hash TEXT NOT NULL,
    role     TEXT NOT NULL CHECK (role IN ('admin', 'cassa', 'cucina')),
    active   INTEGER NOT NULL DEFAULT 1
  ) STRICT;

  CREATE TABLE sessions (
    token       TEXT PRIMARY KEY,
    operator_id INTEGER NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  ) STRICT;

  CREATE TABLE printers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    -- network: stampante ESC/POS in rete (porta 9100)
    -- cups: coda di stampa del sistema (USB), invio raw con lp
    -- file: nessuna stampa fisica, salva un'anteprima testuale (per prove)
    kind        TEXT NOT NULL CHECK (kind IN ('network', 'cups', 'file')),
    address     TEXT NOT NULL DEFAULT '',
    width_chars INTEGER NOT NULL DEFAULT 42
  ) STRICT;

  -- Postazioni cassa: ogni browser che vende sceglie la propria.
  CREATE TABLE tills (
    id                 INTEGER PRIMARY KEY,
    name               TEXT NOT NULL,
    receipt_printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL
  ) STRICT;

  -- Reparti di produzione (le "comande" del vecchio programma).
  CREATE TABLE stations (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL,
    printer_id INTEGER REFERENCES printers(id) ON DELETE SET NULL,
    enabled    INTEGER NOT NULL DEFAULT 1,
    sort       INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE families (
    id      INTEGER PRIMARY KEY,
    name    TEXT NOT NULL,
    color   TEXT NOT NULL DEFAULT '#888888',
    visible INTEGER NOT NULL DEFAULT 1,
    sort    INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  -- Magazzini condivisi tra più prodotti (es. "Tigelle" per tutte le tigelle).
  CREATE TABLE storages (
    id       INTEGER PRIMARY KEY,
    name     TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE products (
    id          INTEGER PRIMARY KEY,
    family_id   INTEGER NOT NULL REFERENCES families(id),
    station_id  INTEGER REFERENCES stations(id) ON DELETE SET NULL,
    name        TEXT NOT NULL,
    -- NULL = prezzo libero, chiesto alla vendita
    price_cents INTEGER CHECK (price_cents IS NULL OR price_cents >= 0),
    stock_mode  TEXT NOT NULL DEFAULT 'unlimited' CHECK (stock_mode IN ('unlimited', 'own', 'shared')),
    stock_qty   REAL NOT NULL DEFAULT 0,
    storage_id  INTEGER REFERENCES storages(id),
    -- unità scaricate dal magazzino per ogni pezzo venduto
    stock_units REAL NOT NULL DEFAULT 1 CHECK (stock_units > 0),
    low_stock   INTEGER NOT NULL DEFAULT 0,
    -- grouped: righe raggruppate nella comanda; separate: un foglietto per pezzo
    print_mode  TEXT NOT NULL DEFAULT 'grouped' CHECK (print_mode IN ('grouped', 'separate')),
    visible     INTEGER NOT NULL DEFAULT 1,
    menu_only   INTEGER NOT NULL DEFAULT 0,
    sort        INTEGER NOT NULL DEFAULT 0,
    legacy_id   TEXT UNIQUE,
    CHECK (stock_mode <> 'shared' OR storage_id IS NOT NULL)
  ) STRICT;
  CREATE INDEX products_family ON products(family_id);

  CREATE TABLE menus (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
    color       TEXT NOT NULL DEFAULT '#888888',
    visible     INTEGER NOT NULL DEFAULT 1,
    sort        INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE menu_components (
    id      INTEGER PRIMARY KEY,
    menu_id INTEGER NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
    name    TEXT NOT NULL,
    choices INTEGER NOT NULL DEFAULT 1 CHECK (choices >= 1),
    sort    INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE TABLE menu_component_products (
    component_id INTEGER NOT NULL REFERENCES menu_components(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    sort         INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (component_id, product_id)
  ) STRICT;

  -- Chiusure di cassa: separano le giornate e azzerano la numerazione ordini.
  CREATE TABLE closures (
    id          INTEGER PRIMARY KEY,
    created_at  TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    operator_id INTEGER REFERENCES operators(id),
    totals_json TEXT NOT NULL
  ) STRICT;

  CREATE TABLE orders (
    id             INTEGER PRIMARY KEY,
    number         INTEGER NOT NULL,
    created_at     TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    operator_id    INTEGER REFERENCES operators(id),
    till_id        INTEGER REFERENCES tills(id) ON DELETE SET NULL,
    table_label    TEXT NOT NULL DEFAULT '',
    takeaway       INTEGER NOT NULL DEFAULT 0,
    note           TEXT NOT NULL DEFAULT '',
    subtotal_cents INTEGER NOT NULL,
    discount_cents INTEGER NOT NULL DEFAULT 0,
    total_cents    INTEGER NOT NULL,
    paid_cents     INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'contanti' CHECK (payment_method IN ('contanti', 'carta', 'altro')),
    status         TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'voided')),
    voided_at      TEXT,
    voided_by      INTEGER REFERENCES operators(id),
    void_reason    TEXT,
    closure_id     INTEGER REFERENCES closures(id)
  ) STRICT;
  CREATE INDEX orders_closure ON orders(closure_id);
  CREATE INDEX orders_created ON orders(created_at);

  CREATE TABLE order_lines (
    id               INTEGER PRIMARY KEY,
    order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    -- le righe dei prodotti scelti in un menù puntano alla riga del menù
    parent_line_id   INTEGER REFERENCES order_lines(id) ON DELETE CASCADE,
    product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
    menu_id          INTEGER REFERENCES menus(id) ON DELETE SET NULL,
    name             TEXT NOT NULL,
    family_name      TEXT NOT NULL DEFAULT '',
    qty              INTEGER NOT NULL CHECK (qty > 0),
    unit_price_cents INTEGER NOT NULL,
    gift             INTEGER NOT NULL DEFAULT 0,
    note             TEXT NOT NULL DEFAULT '',
    station_id       INTEGER REFERENCES stations(id) ON DELETE SET NULL,
    kitchen_status   TEXT NOT NULL DEFAULT 'none' CHECK (kitchen_status IN ('none', 'pending', 'ready', 'delivered')),
    ready_at         TEXT
  ) STRICT;
  CREATE INDEX order_lines_order ON order_lines(order_id);
  CREATE INDEX order_lines_kitchen ON order_lines(station_id, kitchen_status);

  -- Storico movimenti di magazzino (vendite, storni, rettifiche manuali).
  CREATE TABLE stock_movements (
    id         INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    product_id INTEGER REFERENCES products(id) ON DELETE CASCADE,
    storage_id INTEGER REFERENCES storages(id) ON DELETE CASCADE,
    delta      REAL NOT NULL,
    reason     TEXT NOT NULL,
    order_id   INTEGER REFERENCES orders(id) ON DELETE SET NULL
  ) STRICT;

  CREATE TABLE print_jobs (
    id         INTEGER PRIMARY KEY,
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    printer_id INTEGER REFERENCES printers(id) ON DELETE CASCADE,
    order_id   INTEGER REFERENCES orders(id) ON DELETE CASCADE,
    kind       TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
    error      TEXT,
    doc_json   TEXT NOT NULL
  ) STRICT;
  CREATE INDEX print_jobs_status ON print_jobs(status);
  `,
];

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db: DB) {
  const current = db.pragma('user_version', { simple: true }) as number;
  for (let v = current; v < MIGRATIONS.length; v++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[v]);
      db.pragma(`user_version = ${v + 1}`);
    })();
  }
}

/** Copia consistente del database (funziona anche mentre è in uso). */
export async function backupDb(db: DB, dir: string, label: string, keep = 30): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(dir, `cassa-${stamp}-${label}.db`);
  await db.backup(file);
  const old = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('cassa-') && f.endsWith('.db'))
    .sort()
    .reverse()
    .slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return file;
}
