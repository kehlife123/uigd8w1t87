'use strict';

try {
  require('dotenv').config();
} catch {
  /* dotenv est facultatif en production (Railway injecte les variables) */
}

const http = require('http');
const bot = require('./src/bot');
const store = require('./src/store');

const PORT = Number(process.env.PORT) || 3000;

// Petit serveur HTTP : healthcheck Railway + garde le service actif.
const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', ready: bot.isReady(), uptime: Math.round(process.uptime()) }));
    return;
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] HTTP en écoute sur le port ${PORT}`);
});

bot.start().catch((err) => {
  console.error('[bot] Démarrage impossible :', err.message);
  process.exit(1);
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`[server] ${signal} reçu, arrêt en cours…`);
  try {
    store.flushSync();
    await bot.stop();
    server.close();
  } catch (err) {
    console.error('[server] Erreur pendant l’arrêt :', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => console.error('[unhandledRejection]', reason));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
