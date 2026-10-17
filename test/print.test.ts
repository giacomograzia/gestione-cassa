import { describe, expect, it } from 'vitest';
import { encodeCp858, PrintDoc, renderEscPos, renderText, wrap } from '../server/print/doc.js';

describe('impaginazione di stampa', () => {
  it('va a capo sulle parole mantenendo il rientro', () => {
    expect(wrap('    - 2 TIGELLA SALAME CON PROSCIUTTO', 20)).toEqual(['    - 2 TIGELLA', '    SALAME CON', '    PROSCIUTTO']);
  });

  it('allinea prezzo a destra e non lascia spazi finali senza prezzo', () => {
    const text = renderText(new PrintDoc().row('2 x Tigella', '3,00').row('1 x Gnocco', ''), 20);
    expect(text.split('\n')).toEqual(['2 x Tigella     3,00', '1 x Gnocco', '']);
  });

  it('codifica accenti ed euro in CP858', () => {
    expect(encodeCp858('àè€')).toEqual([0x85, 0x8a, 0xd5]);
    expect(encodeCp858('✓')).toEqual([0x3f]);
  });

  it('produce comandi ESC/POS con inizializzazione e taglio', () => {
    const buf = renderEscPos(new PrintDoc().text('Ciao', { bold: true }).cut(), 42);
    expect([...buf.subarray(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x74, 19]);
    expect([...buf.subarray(-4)]).toEqual([0x1d, 0x56, 66, 3]);
  });
});
