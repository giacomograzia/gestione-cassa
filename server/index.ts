import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { dataDir, host, port } from './config.js';
import { backupDb, openDb } from './db.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// in sviluppo l'interfaccia è servita da Vite; dopo "npm run build" da dist/web
const webDir = path.resolve(here, here.includes(`${path.sep}dist${path.sep}`) ? '../web' : '../dist/web');

const db = openDb(path.join(dataDir, 'cassa.db'));
await backupDb(db, path.join(dataDir, 'backup'), 'avvio');

const { app } = await buildApp({ db, dataDir, webDir, logger: true });
await app.listen({ host, port });

const addresses = Object.values(os.networkInterfaces())
  .flat()
  .filter((a) => a && a.family === 'IPv4' && !a.internal)
  .map((a) => `http://${a!.address}:${port}`);
console.log('\nNuova Cassa avviata. Apri da questo computer o dagli altri dispositivi in rete:');
for (const a of [`http://localhost:${port}`, ...addresses]) console.log(`  ${a}`);
console.log(`Dati in: ${dataDir}\n`);

const shutdown = () => {
  app.close().finally(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
