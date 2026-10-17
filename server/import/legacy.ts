/**
 * Importazione dal vecchio programma "Cassa 2.0.x".
 *
 * Il vecchio programma esporta il catalogo in un file di testo (cartella Save/)
 * con sezioni [TABELLA], una riga "Fields=..." e righe separate da ";".
 * Le stringhe sono tra apici (apice raddoppiato per l'escape) e i decimali usano la virgola.
 * Il significato delle colonne DATAn è stato ricavato dal codice del vecchio programma:
 * vedi docs/mappatura-database-legacy.md.
 *
 * Uso da riga di comando:  npm run import-legacy -- <file.txt> [--replace]
 */
import { pathToFileURL } from 'node:url';
import type { DB } from '../db.js';

export type LegacyTables = Record<string, Record<string, string>[]>;

export function splitRow(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i <= line.length) {
    if (line[i] === "'") {
      let s = '';
      i++;
      while (i < line.length) {
        if (line[i] === "'" && line[i + 1] === "'") {
          s += "'";
          i += 2;
        } else if (line[i] === "'") {
          i++;
          break;
        } else s += line[i++];
      }
      out.push(s);
      while (i < line.length && line[i] !== ';') i++;
      i++;
    } else {
      const end = line.indexOf(';', i);
      const stop = end === -1 ? line.length : end;
      out.push(line.slice(i, stop));
      i = stop + 1;
    }
  }
  return out;
}

export function parseLegacyExport(text: string): LegacyTables {
  const tables: LegacyTables = {};
  let current: string | null = null;
  let fields: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line) continue;
    const section = /^\[(\w+)\]$/.exec(line);
    if (section) {
      current = section[1].toUpperCase();
      tables[current] = [];
      fields = [];
    } else if (current && line.startsWith('Fields=')) {
      fields = line.slice(7).split(';').map((f) => f.trim().toUpperCase());
    } else if (current && fields.length) {
      const values = splitRow(line);
      tables[current].push(Object.fromEntries(fields.map((f, i) => [f, values[i] ?? ''])));
    }
  }
  return tables;
}

const num = (v: string | undefined, fallback = 0) => {
  if (v === undefined || v.trim() === '') return fallback;
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) ? n : fallback;
};
const bool = (v: string | undefined) => v === 'T';
/** I colori .NET sono interi ARGB con segno: teniamo solo RGB. */
export const argbToHex = (v: string | undefined) =>
  '#' + ((num(v, -8355712) >>> 0) & 0xffffff).toString(16).padStart(6, '0');

export interface ImportSummary {
  families: number;
  products: number;
  storages: number;
  stations: number;
  menus: number;
  skipped: string[];
}

export function importLegacy(db: DB, t: LegacyTables, opts: { replace: boolean }): ImportSummary {
  const summary: ImportSummary = { families: 0, products: 0, storages: 0, stations: 0, menus: 0, skipped: [] };
  if (!t.PRODUCT && !t.FAMILY) throw new Error('Il file non sembra un\'esportazione del vecchio programma Cassa');

  db.transaction(() => {
    if (opts.replace) {
      db.exec(`
        DELETE FROM menus;
        DELETE FROM products;
        DELETE FROM families;
        DELETE FROM storages;
        DELETE FROM stations;`);
    }

    // Reparti di produzione: CONFIG gruppo 7, seq = 100 + 10*n + campo (3 = nome)
    const stationIds = new Map<number, number>();
    for (const c of t.CONFIG ?? []) {
      const seq = num(c.SEQ, -1);
      if (num(c.GRP) !== 7 || seq < 100 || seq % 10 !== 3) continue;
      const index = Math.floor((seq - 100) / 10);
      const name = c.DATA1.trim() || `Comanda ${index + 1}`;
      const existing = db.prepare('SELECT id FROM stations WHERE name = ?').get(name) as { id: number } | undefined;
      const id = existing?.id ??
        Number(db.prepare('INSERT INTO stations (name, enabled, sort) VALUES (?, 1, ?)').run(name, index).lastInsertRowid);
      if (!existing) summary.stations++;
      stationIds.set(index, id);
    }

    const storageIds = new Map<string, number>();
    for (const s of t.STORAGE ?? []) {
      const existing = db.prepare('SELECT id FROM storages WHERE name = ?').get(s.DATA1) as { id: number } | undefined;
      const id = existing?.id ??
        Number(db.prepare('INSERT INTO storages (name, quantity) VALUES (?, ?)').run(s.DATA1, num(s.DATA2)).lastInsertRowid);
      if (!existing) summary.storages++;
      storageIds.set(s.IDSTORAGE, id);
    }

    const familyIds = new Map<string, number>();
    for (const f of t.FAMILY ?? []) {
      const existing = db.prepare('SELECT id FROM families WHERE name = ?').get(f.DATA1) as { id: number } | undefined;
      const id = existing?.id ??
        Number(
          db
            .prepare('INSERT INTO families (name, color, visible, sort) VALUES (?, ?, ?, ?)')
            .run(f.DATA1, argbToHex(f.DATA4), bool(f.DATA2) ? 1 : 0, num(f.DATA5)).lastInsertRowid,
        );
      if (!existing) summary.families++;
      familyIds.set(f.IDFAMILY, id);
    }

    const productIds = new Map<string, number>();
    const insertProduct = db.prepare(`
      INSERT INTO products (family_id, station_id, name, price_cents, stock_mode, stock_qty, storage_id,
        stock_units, low_stock, print_mode, visible, menu_only, sort, legacy_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const p of t.PRODUCT ?? []) {
      const familyId = familyIds.get(p.IDFAMILY);
      if (!familyId) {
        summary.skipped.push(`${p.DATA2}: famiglia mancante`);
        continue;
      }
      const existing = db.prepare('SELECT id FROM products WHERE legacy_id = ?').get(p.IDPRODUCT) as
        | { id: number }
        | undefined;
      if (existing) {
        productIds.set(p.IDPRODUCT, existing.id);
        summary.skipped.push(`${p.DATA2}: già presente`);
        continue;
      }
      // DATA6: -1 = illimitato, -2 = magazzino condiviso (IDSTORAGE), >= 0 = quantità propria
      const qty = num(p.DATA6, -1);
      let stockMode = qty === -1 ? 'unlimited' : qty === -2 ? 'shared' : 'own';
      const storageId = stockMode === 'shared' ? storageIds.get(p.IDSTORAGE) ?? null : null;
      if (stockMode === 'shared' && !storageId) stockMode = 'unlimited';
      const price = num(p.DATA5);
      const units = num(p.DATA9, 1);
      const id = Number(
        insertProduct.run(
          familyId,
          stationIds.get(num(p.IDKORDER, -1)) ?? null,
          p.DATA2,
          price < 0 ? null : Math.round(price * 100), // -1 = prezzo libero
          stockMode,
          stockMode === 'own' ? qty : 0,
          storageId,
          units > 0 ? units : 1,
          Math.max(0, num(p.DATA7)),
          p.DATA8 === 'S' ? 'separate' : 'grouped',
          bool(p.DATA3) ? 1 : 0,
          bool(p.DATA14) ? 1 : 0,
          num(p.DATA13),
          p.IDPRODUCT,
        ).lastInsertRowid,
      );
      productIds.set(p.IDPRODUCT, id);
      summary.products++;
    }

    const menuIds = new Map<string, number>();
    for (const m of t.MENULIST ?? []) {
      const id = Number(
        db
          .prepare('INSERT INTO menus (name, price_cents, color, visible, sort) VALUES (?, ?, ?, ?, ?)')
          .run(m.DATA2, Math.round(num(m.DATA4) * 100), argbToHex(m.DATA5), bool(m.DATA3) ? 1 : 0, num(m.DATA1))
          .lastInsertRowid,
      );
      menuIds.set(m.IDMENULIST, id);
      summary.menus++;
    }
    const compIds = new Map<string, number>();
    for (const c of t.MENUCOMP ?? []) {
      const menuId = menuIds.get(c.IDMENULIST);
      if (!menuId) continue;
      compIds.set(
        c.IDMENUCOMP,
        Number(
          db
            .prepare('INSERT INTO menu_components (menu_id, name, choices, sort) VALUES (?, ?, 1, ?)')
            .run(menuId, c.DATA2, num(c.DATA1)).lastInsertRowid,
        ),
      );
    }
    for (const mp of t.MENUPROD ?? []) {
      const cid = compIds.get(mp.IDMENUCOMP);
      const pid = productIds.get(mp.IDPRODUCT);
      if (cid && pid) {
        db.prepare('INSERT OR IGNORE INTO menu_component_products (component_id, product_id, sort) VALUES (?, ?, ?)').run(
          cid, pid, num(mp.DATA2));
      }
    }
  })();
  return summary;
}

/** Decodifica il file: UTF-8 se valido, altrimenti Windows-1252 (il vecchio programma girava su Windows). */
export function decodeLegacyFile(buf: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

// ---- Esecuzione da riga di comando ----
const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const [{ default: fs }, { openDb }, { dataDir }] = await Promise.all([
    import('node:fs'),
    import('../db.js'),
    import('../config.js'),
  ]);
  const file = process.argv[2];
  if (!file) {
    console.error('Uso: npm run import-legacy -- <file-esportazione.txt> [--replace]');
    process.exit(1);
  }
  const db = openDb(`${dataDir}/cassa.db`);
  const summary = importLegacy(db, parseLegacyExport(decodeLegacyFile(fs.readFileSync(file))), {
    replace: process.argv.includes('--replace'),
  });
  console.log(JSON.stringify(summary, null, 2));
}
