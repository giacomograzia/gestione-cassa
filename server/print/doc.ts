/**
 * Documento di stampa astratto: una lista di blocchi che si può rendere
 * in comandi ESC/POS (stampanti termiche) o in testo semplice (anteprima).
 */
export type Align = 'left' | 'center' | 'right';

export type Block =
  | { t: 'text'; text: string; align?: Align; bold?: boolean; big?: boolean; huge?: boolean }
  | { t: 'row'; left: string; right: string; bold?: boolean }
  | { t: 'rule' }
  | { t: 'feed'; lines: number }
  | { t: 'cut' };

export class PrintDoc {
  blocks: Block[] = [];
  text(text: string, opts: Omit<Extract<Block, { t: 'text' }>, 't' | 'text'> = {}) {
    this.blocks.push({ t: 'text', text, ...opts });
    return this;
  }
  row(left: string, right: string, bold = false) {
    this.blocks.push({ t: 'row', left, right, bold });
    return this;
  }
  rule() {
    this.blocks.push({ t: 'rule' });
    return this;
  }
  feed(lines = 1) {
    this.blocks.push({ t: 'feed', lines });
    return this;
  }
  cut() {
    this.blocks.push({ t: 'cut' });
    return this;
  }
}

/** Spezza il testo in righe della larghezza indicata, andando a capo sulle parole. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    const indent = /^\s*/.exec(para)![0].slice(0, Math.floor(width / 2));
    let line = indent;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (line === indent) line += word;
      else if (line.length + 1 + word.length <= width) line += ' ' + word;
      else {
        out.push(line);
        line = indent + word;
      }
      while (line.length > width) {
        out.push(line.slice(0, width));
        line = line.slice(width);
      }
    }
    out.push(line);
  }
  return out;
}

function alignLine(s: string, width: number, align: Align = 'left'): string {
  if (s.length >= width || align === 'left') return s;
  const pad = width - s.length;
  return align === 'right' ? ' '.repeat(pad) + s : ' '.repeat(Math.floor(pad / 2)) + s;
}

function rowLine(left: string, right: string, width: number): string[] {
  if (!right) return wrap(left, width);
  const avail = width - right.length - 1;
  const lines = wrap(left, Math.max(8, avail));
  const last = lines.pop() ?? '';
  return [...lines, last + ' '.repeat(Math.max(1, width - last.length - right.length)) + right];
}

export function renderText(doc: PrintDoc, width: number): string {
  const out: string[] = [];
  for (const b of doc.blocks) {
    switch (b.t) {
      case 'text': {
        // in anteprima i caratteri grandi occupano il doppio: dimezziamo la larghezza
        const w = b.huge ? Math.floor(width / 3) : b.big ? Math.floor(width / 2) : width;
        for (const l of wrap(b.text, w)) out.push(alignLine(l, width, b.align));
        break;
      }
      case 'row':
        out.push(...rowLine(b.left, b.right, width));
        break;
      case 'rule':
        out.push('-'.repeat(width));
        break;
      case 'feed':
        for (let i = 0; i < b.lines; i++) out.push('');
        break;
      case 'cut':
        out.push('='.repeat(width) + '  ✂');
        break;
    }
  }
  return out.join('\n') + '\n';
}

// ---- ESC/POS ----

const ESC = 0x1b;
const GS = 0x1d;

/** Tabella CP858 (Europa occidentale con €) per i caratteri non ASCII più comuni. */
const CP858: Record<string, number> = {
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85, 'å': 0x86, 'ç': 0x87, 'ê': 0x88, 'ë': 0x89,
  'è': 0x8a, 'ï': 0x8b, 'î': 0x8c, 'ì': 0x8d, 'Ä': 0x8e, 'Å': 0x8f, 'É': 0x90, 'æ': 0x91, 'Æ': 0x92, 'ô': 0x93,
  'ö': 0x94, 'ò': 0x95, 'û': 0x96, 'ù': 0x97, 'ÿ': 0x98, 'Ö': 0x99, 'Ü': 0x9a, 'ø': 0x9b, '£': 0x9c, 'Ø': 0x9d,
  'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5, 'ª': 0xa6, 'º': 0xa7, '¿': 0xa8, '°': 0xf8,
  'À': 0xb7, 'È': 0xd4, 'Ì': 0xde, 'Ò': 0xe3, 'Ù': 0xeb, '€': 0xd5, '’': 0x27, '‘': 0x27, '“': 0x22, '”': 0x22,
  '–': 0x2d, '—': 0x2d, '…': 0x2e,
};

export function encodeCp858(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const code = ch.charCodeAt(0);
    if (code < 0x80) out.push(code);
    else out.push(CP858[ch] ?? 0x3f); // '?'
  }
  return out;
}

export function renderEscPos(doc: PrintDoc, width: number): Buffer {
  const bytes: number[] = [ESC, 0x40, ESC, 0x74, 19]; // init + codepage CP858
  const line = (s: string) => bytes.push(...encodeCp858(s), 0x0a);
  const setAlign = (a: Align = 'left') => bytes.push(ESC, 0x61, a === 'left' ? 0 : a === 'center' ? 1 : 2);
  const setBold = (on: boolean) => bytes.push(ESC, 0x45, on ? 1 : 0);
  const setSize = (mult: number) => bytes.push(GS, 0x21, ((mult - 1) << 4) | (mult - 1));

  for (const b of doc.blocks) {
    switch (b.t) {
      case 'text': {
        const mult = b.huge ? 3 : b.big ? 2 : 1;
        setAlign(b.align);
        setBold(!!b.bold);
        setSize(mult);
        for (const l of wrap(b.text, Math.floor(width / mult))) line(l);
        setSize(1);
        setBold(false);
        setAlign('left');
        break;
      }
      case 'row':
        setBold(!!b.bold);
        for (const l of rowLine(b.left, b.right, width)) line(l);
        setBold(false);
        break;
      case 'rule':
        line('-'.repeat(width));
        break;
      case 'feed':
        bytes.push(ESC, 0x64, Math.min(255, b.lines));
        break;
      case 'cut':
        bytes.push(GS, 0x56, 66, 3); // avanza e taglio parziale
        break;
    }
  }
  return Buffer.from(bytes);
}
