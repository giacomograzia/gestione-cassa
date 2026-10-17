import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { openDb } from '../server/db.js';
import { argbToHex, decodeLegacyFile, importLegacy, parseLegacyExport, splitRow } from '../server/import/legacy.js';
import { listProducts } from '../server/repo.js';

const SAMPLE = `[CONFIG]
Fields=SEQ;GRP;DATA1;DSC
103;7;'TIG-GNO';'Nome comanda'
113;7;'BERE';'Nome comanda'
2;1;'1';'Bottoni per riga'
[FAMILY]
Fields=IDFAMILY;DATA1;DATA2;DATA3;DATA4;DATA5
1001;'TIGELLE';'T';15;-128;1
1002;'BAR';'T';80;-8323073;10
[PRODUCT]
Fields=IDPRODUCT;IDFAMILY;IDKORDER;DATA1;DATA2;DATA3;DATA4;DATA5;DATA6;DATA7;DATA8;DATA9;DATA10;DATA11;DATA12;DATA13;DATA14;IDSTORAGE
2001;1001;0;0;'TIGELLA SALAME';'T';0;1,5;-2;0;'O';1;0;0;'';2;'F';3001
2002;1002;-1;0;'CAFFE'' D''ORZO';'T';0;1;-1;0;'O';1;0;0;'';2;'F';-1
2003;1002;1;0;'GENERICO';'T';0;-1;10;2;'S';0;0;0;'';4;'F';-1
[MENULIST]
Fields=IDMENULIST;DATA1;DATA2;DATA3;DATA4;DATA5
[STORAGE]
Fields=IDSTORAGE;DATA1;DATA2
3001;'Tigelle';1000
`;

describe('importazione dal vecchio programma', () => {
  it('divide le righe rispettando apici e apici raddoppiati', () => {
    expect(splitRow("1;'a;b';'it''s';2,5")).toEqual(['1', 'a;b', "it's", '2,5']);
  });

  it('converte i colori ARGB di .NET', () => {
    expect(argbToHex('-128')).toBe('#ffff80');
    expect(argbToHex('-16744193')).toBe('#0080ff');
  });

  it('importa reparti, famiglie, magazzini e prodotti', () => {
    const db = openDb(':memory:');
    const summary = importLegacy(db, parseLegacyExport(SAMPLE), { replace: true });
    expect(summary).toMatchObject({ families: 2, products: 3, storages: 1, stations: 2 });
    const products = listProducts(db);
    const tig = products.find((p) => p.name === 'TIGELLA SALAME')!;
    expect(tig).toMatchObject({ priceCents: 150, stockMode: 'shared', available: 1000 });
    const orzo = products.find((p) => p.name === "CAFFE' D'ORZO")!;
    expect(orzo).toMatchObject({ stationId: null, stockMode: 'unlimited' });
    const gen = products.find((p) => p.name === 'GENERICO')!;
    expect(gen).toMatchObject({ priceCents: null, stockMode: 'own', stockQty: 10, lowStock: 2, printMode: 'separate', stockUnits: 1 });

    // reimportare senza "replace" non duplica
    const again = importLegacy(db, parseLegacyExport(SAMPLE), { replace: false });
    expect(again.products).toBe(0);
    expect(listProducts(db)).toHaveLength(3);
  });

  it('legge il file reale esportato dal vecchio programma, se presente', () => {
    const file = new URL('../../estratto/Cassa settembre 2019/Save/Save-20190819194802470.txt', import.meta.url);
    if (!fs.existsSync(file)) return;
    const tables = parseLegacyExport(decodeLegacyFile(fs.readFileSync(file)));
    const db = openDb(':memory:');
    const summary = importLegacy(db, tables, { replace: true });
    expect(summary.products).toBe(tables.PRODUCT.length);
    expect(summary.skipped).toEqual([]);
    expect(listProducts(db).find((p) => p.name === 'BIGLIETTO PESCA')?.available).toBe(3000);
  });
});
