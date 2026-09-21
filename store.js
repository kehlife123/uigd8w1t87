'use strict';

const fs = require('fs');
const path = require('path');
const { MODULES } = require('./constants');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'antiraid.json');

let db = { guilds: {} };
let timer = null;

function defaultModules() {
  const out = {};
  for (const [key, def] of Object.entries(MODULES)) {
    out[key] = { enabled: true, limit: def.limit, window: def.window };
    if (def.duration) out[key].duration = def.duration;
  }
  return out;
}

function defaultGuild() {
  return {
    initialized: false,
    quarantineRoleId: null,
    logChannelId: null,
    punishInviter: true,
    whitelist: { enabled: true, bots: {} },
    exempt: {},
    modules: defaultModules(),
    raid: { active: false, since: null, until: null, reason: null },
    quarantined: {},
  };
}

function normalize(g) {
  const d = defaultGuild();
  for (const key of Object.keys(d)) {
    if (g[key] === undefined || g[key] === null) {
      if (['quarantineRoleId', 'logChannelId'].includes(key)) g[key] = null;
      else g[key] = d[key];
    }
  }
  if (typeof g.whitelist !== 'object') g.whitelist = d.whitelist;
  if (typeof g.whitelist.enabled !== 'boolean') g.whitelist.enabled = true;
  if (!g.whitelist.bots || typeof g.whitelist.bots !== 'object') g.whitelist.bots = {};
  for (const [key, def] of Object.entries(d.modules)) {
    g.modules[key] = { ...def, ...(g.modules[key] || {}) };
  }
  return g;
}

function load() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    db = parsed && typeof parsed === 'object' ? parsed : { guilds: {} };
    if (!db.guilds) db.guilds = {};
    console.log(`[store] Données chargées depuis ${FILE}`);
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.log(`[store] Nouveau fichier de données : ${FILE}`);
      return;
    }
    // Fichier corrompu : on le met de côté au lieu de l'écraser.
    const backup = `${FILE}.corrupt-${Date.now()}`;
    try {
      fs.renameSync(FILE, backup);
      console.error(`[store] Fichier illisible, sauvegardé vers ${backup}`);
    } catch (e) {
      console.error('[store] Impossible de sauvegarder le fichier corrompu :', e.message);
    }
    db = { guilds: {} };
  }
}

function flushSync() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, FILE);
  } catch (err) {
    console.error('[store] Écriture impossible :', err.message);
  }
}

function save() {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flushSync();
  }, 300);
}

function guild(id) {
  if (!db.guilds[id]) {
    db.guilds[id] = defaultGuild();
    save();
  }
  return normalize(db.guilds[id]);
}

module.exports = { load, save, flushSync, guild, defaultModules };
