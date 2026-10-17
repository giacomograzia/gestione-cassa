import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DB } from '../db.js';
import type { Printer } from '../../shared/types.js';
import { mapPrinter } from '../repo.js';
import { PrintDoc, renderEscPos, renderText } from './doc.js';

/**
 * Coda di stampa: ogni stampa è salvata come job e inviata in background,
 * così una stampante spenta non blocca mai la vendita. I job falliti
 * restano in elenco e si possono ristampare.
 */
export class PrintQueue {
  private chain = new Map<number, Promise<void>>();

  constructor(
    private db: DB,
    private previewDir: string,
    private onFailure: (jobId: number, printer: string, error: string) => void,
  ) {}

  enqueue(printerId: number | null, kind: string, doc: PrintDoc, orderId: number | null = null) {
    if (!printerId) return;
    const id = Number(
      this.db
        .prepare('INSERT INTO print_jobs (printer_id, order_id, kind, doc_json) VALUES (?, ?, ?, ?)')
        .run(printerId, orderId, kind, JSON.stringify(doc.blocks)).lastInsertRowid,
    );
    this.schedule(id, printerId);
  }

  retry(jobId: number) {
    const job = this.db.prepare('SELECT printer_id FROM print_jobs WHERE id = ?').get(jobId) as
      | { printer_id: number }
      | undefined;
    if (!job) return false;
    this.db.prepare("UPDATE print_jobs SET status = 'pending', error = NULL WHERE id = ?").run(jobId);
    this.schedule(jobId, job.printer_id);
    return true;
  }

  /** I job di ogni stampante escono in ordine, uno alla volta. */
  private schedule(jobId: number, printerId: number) {
    const prev = this.chain.get(printerId) ?? Promise.resolve();
    const next = prev.then(() => this.run(jobId));
    this.chain.set(printerId, next);
  }

  private async run(jobId: number) {
    const row = this.db
      .prepare('SELECT j.doc_json, p.* FROM print_jobs j JOIN printers p ON p.id = j.printer_id WHERE j.id = ?')
      .get(jobId) as Record<string, any> | undefined;
    if (!row) return;
    const printer = mapPrinter(row);
    const doc = new PrintDoc();
    doc.blocks = JSON.parse(row.doc_json);
    try {
      await send(printer, doc, this.previewDir, jobId);
      this.db.prepare("UPDATE print_jobs SET status = 'done' WHERE id = ?").run(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.db.prepare("UPDATE print_jobs SET status = 'failed', error = ? WHERE id = ?").run(msg, jobId);
      this.onFailure(jobId, printer.name, msg);
    }
  }
}

export async function send(printer: Printer, doc: PrintDoc, previewDir: string, jobId: number | string) {
  switch (printer.kind) {
    case 'file': {
      fs.mkdirSync(previewDir, { recursive: true });
      const safe = printer.name.replace(/[^\w-]+/g, '_');
      fs.writeFileSync(path.join(previewDir, `${String(jobId).padStart(6, '0')}-${safe}.txt`), renderText(doc, printer.widthChars));
      return;
    }
    case 'network':
      return sendTcp(printer.address, renderEscPos(doc, printer.widthChars));
    case 'cups':
      return sendCups(printer.address, renderEscPos(doc, printer.widthChars));
  }
}

function sendTcp(address: string, data: Buffer): Promise<void> {
  const [host, portStr] = address.split(':');
  const port = Number(portStr) || 9100;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(5000);
    socket.on('connect', () => socket.end(data));
    socket.on('timeout', () => socket.destroy(new Error(`Stampante ${address} non risponde`)));
    socket.on('error', (e) => reject(new Error(`Stampante ${address}: ${e.message}`)));
    socket.on('close', (hadError) => {
      if (!hadError) resolve();
    });
  });
}

/** Invio raw a una coda CUPS (stampanti USB collegate al Mac). */
function sendCups(queue: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn('lp', ['-d', queue, '-o', 'raw'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', (e) => reject(new Error(`lp: ${e.message}`)));
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `lp terminato con codice ${code}`))));
    p.stdin.end(data);
  });
}
