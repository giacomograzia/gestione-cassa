import path from 'node:path';

/** Configurazione da variabili d'ambiente, con valori adatti all'uso locale. */
export const dataDir = path.resolve(process.env.CASSA_DATA_DIR ?? 'data');
export const port = Number(process.env.PORT ?? 3000);
export const host = process.env.HOST ?? '0.0.0.0';
