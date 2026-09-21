'use strict';

// Compteur à fenêtre glissante : clé = `${guildId}:${module}:${userId}`
const buckets = new Map();
const MAX_AGE_MS = 60 * 60 * 1000;

function hit(key, windowMs, weight = 1) {
  const now = Date.now();
  const list = (buckets.get(key) || []).filter((e) => now - e.t < windowMs);
  list.push({ t: now, w: Math.max(1, weight) });
  buckets.set(key, list);
  return list.reduce((sum, e) => sum + e.w, 0);
}

function reset(guildId, userId) {
  const prefix = `${guildId}:`;
  const suffix = `:${userId}`;
  for (const key of buckets.keys()) {
    if (key.startsWith(prefix) && key.endsWith(suffix)) buckets.delete(key);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, list] of buckets) {
    const last = list[list.length - 1];
    if (!last || now - last.t > MAX_AGE_MS) buckets.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = { hit, reset };
