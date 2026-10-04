'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');
const { ChannelType: T, PermissionFlagsBits, Routes, WebhookType } = require('discord.js');
const store = require('./store');
const { sendLog } = require('./logger');
const { DATA_DIR } = require('./constants');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const FORMAT_VERSION = 1;
const KEEP = 5;
const MAX_IMPORT_BYTES = 25 * 1024 * 1024;
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const REASON = 'Anti-Raid — sauvegarde';
const ID_RE = /^\d{10,20}$/;

/* -------------------------------------------------------------------------- */
/*  Utilitaires                                                               */
/* -------------------------------------------------------------------------- */

const big = (v) => {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
};
const ext = (hash) => (hash && String(hash).startsWith('a_') ? 'gif' : 'png');
const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);

async function download(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    return { buffer: Buffer.from(await res.arrayBuffer()), type: res.headers.get('content-type') || 'image/png' };
  } catch {
    return null;
  }
}

async function toDataUri(url) {
  const file = await download(url);
  return file ? `data:${file.type};base64,${file.buffer.toString('base64')}` : null;
}

const fromDataUri = (uri) =>
  typeof uri === 'string' && uri.includes(',') ? Buffer.from(uri.split(',')[1], 'base64') : null;

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await fn(items[index], index);
    }
  });
  await Promise.all(workers);
}

/* -------------------------------------------------------------------------- */
/*  Tâches en cours (progression affichée dans le panel)                      */
/* -------------------------------------------------------------------------- */

const jobs = new Map(); // guildId -> job

function startJob(guildId, kind, labels, onChange) {
  const job = {
    kind,
    labels,
    index: 0,
    done: 0,
    total: 0,
    startedAt: Date.now(),
    finished: false,
    ok: false,
    error: null,
    report: null,
    onChange: onChange || null,
  };
  jobs.set(guildId, job);
  return job;
}

const notify = (job) => {
  try {
    job.onChange?.();
  } catch {
    /* l'affichage ne doit jamais casser la tâche */
  }
};

const setStep = (job, index) => {
  job.index = index;
  job.done = 0;
  job.total = 0;
  notify(job);
};

const tick = (job, done, total) => {
  job.done = done;
  if (total !== undefined) job.total = total;
  notify(job);
};

const getJob = (guildId) => jobs.get(guildId) || null;
const isBusy = (guildId) => Boolean(jobs.get(guildId) && !jobs.get(guildId).finished);
const dismissJob = (guildId) => {
  const job = jobs.get(guildId);
  if (job && job.finished) jobs.delete(guildId);
};

/* -------------------------------------------------------------------------- */
/*  Stockage (volume)                                                         */
/* -------------------------------------------------------------------------- */

const indexCache = new Map(); // guildId -> [{ id, createdAt, bytes, stats, name, imported }]

const guildDir = (guildId) => path.join(BACKUP_DIR, String(guildId).replace(/\D/g, ''));
const fileFor = (guildId, id) => path.join(guildDir(guildId), `${String(id).replace(/\D/g, '')}.json.gz`);
const indexFile = (guildId) => path.join(guildDir(guildId), 'index.json');

/** Charge les index au démarrage (synchrone, fichiers minuscules). */
function init() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    for (const dir of fs.readdirSync(BACKUP_DIR)) {
      const file = path.join(BACKUP_DIR, dir, 'index.json');
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(parsed)) indexCache.set(dir, parsed.filter((e) => fs.existsSync(fileFor(dir, e.id))));
      } catch {
        /* dossier sans index : ignoré */
      }
    }
    console.log(`[backup] Dossier des sauvegardes : ${BACKUP_DIR}`);
  } catch (err) {
    console.error('[backup] Initialisation impossible :', err.message);
  }
}

const list = (guildId) => [...(indexCache.get(guildId) || [])].sort((a, b) => b.createdAt - a.createdAt);
const get = (guildId, id) => list(guildId).find((e) => e.id === String(id)) || null;

async function writeIndex(guildId, entries) {
  indexCache.set(guildId, entries);
  await fsp.mkdir(guildDir(guildId), { recursive: true });
  const tmp = `${indexFile(guildId)}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(entries));
  await fsp.rename(tmp, indexFile(guildId));
}

async function saveBackupFile(guildId, data, extra = {}) {
  const raw = await gzip(Buffer.from(JSON.stringify(data)));
  const id = String(Date.now());
  await fsp.mkdir(guildDir(guildId), { recursive: true });
  const target = fileFor(guildId, id);
  const tmp = `${target}.tmp`;
  await fsp.writeFile(tmp, raw);
  await fsp.rename(tmp, target);

  const entry = {
    id,
    createdAt: data.createdAt || Date.now(),
    bytes: raw.length,
    stats: data.stats || {},
    name: data.guild?.name || 'Serveur',
    ...extra,
  };
  let entries = [entry, ...list(guildId)].sort((a, b) => b.createdAt - a.createdAt);
  const dropped = entries.slice(KEEP);
  entries = entries.slice(0, KEEP);
  await writeIndex(guildId, entries);
  for (const old of dropped) await fsp.unlink(fileFor(guildId, old.id)).catch(() => {});
  return entry;
}

async function loadBackup(guildId, id) {
  if (!get(guildId, id)) throw new Error('Sauvegarde introuvable.');
  const raw = await fsp.readFile(fileFor(guildId, id));
  const data = JSON.parse((await gunzip(raw)).toString('utf8'));
  if (!data || data.version !== FORMAT_VERSION || !Array.isArray(data.roles) || !Array.isArray(data.channels)) {
    throw new Error('Fichier de sauvegarde invalide ou d’une version incompatible.');
  }
  return data;
}

async function remove(guildId, id) {
  if (!get(guildId, id)) return false;
  await fsp.unlink(fileFor(guildId, id)).catch(() => {});
  await writeIndex(guildId, list(guildId).filter((e) => e.id !== String(id)));
  return true;
}

async function readRaw(guildId, id) {
  if (!get(guildId, id)) return null;
  return fsp.readFile(fileFor(guildId, id));
}

/** Importe un fichier exporté (.json.gz ou .json) dans ce serveur. */
async function importBuffer(guildId, buffer) {
  if (buffer.length > MAX_IMPORT_BYTES) throw new Error('Fichier trop volumineux.');
  const isGzip = buffer.length > 2 && buffer[0] === 0x1f && buffer[1] === 0x8b;
  const text = (isGzip ? await gunzip(buffer) : buffer).toString('utf8');
  const data = JSON.parse(text);
  if (!data || data.version !== FORMAT_VERSION || !Array.isArray(data.roles) || !Array.isArray(data.channels)) {
    throw new Error('Fichier de sauvegarde invalide.');
  }
  return saveBackupFile(guildId, data, { imported: true });
}

/* -------------------------------------------------------------------------- */
/*  Création                                                                  */
/* -------------------------------------------------------------------------- */

const channelDef = (ch) => ({
  id: ch.id,
  type: ch.type,
  name: ch.name,
  parentId: ch.parentId ?? null,
  position: ch.rawPosition ?? 0,
  overwrites: [...(ch.permissionOverwrites?.cache?.values() ?? [])].map((o) => ({
    id: o.id,
    type: o.type,
    allow: o.allow.bitfield.toString(),
    deny: o.deny.bitfield.toString(),
  })),
  topic: ch.topic ?? null,
  nsfw: Boolean(ch.nsfw),
  rateLimitPerUser: ch.rateLimitPerUser ?? 0,
  bitrate: ch.bitrate ?? null,
  userLimit: ch.userLimit ?? 0,
  rtcRegion: ch.rtcRegion ?? null,
  videoQualityMode: ch.videoQualityMode ?? null,
  defaultAutoArchiveDuration: ch.defaultAutoArchiveDuration ?? null,
  defaultThreadRateLimitPerUser: ch.defaultThreadRateLimitPerUser ?? null,
  defaultSortOrder: ch.defaultSortOrder ?? null,
  defaultForumLayout: ch.defaultForumLayout ?? null,
  defaultReactionEmoji: ch.defaultReactionEmoji
    ? { id: ch.defaultReactionEmoji.id ?? null, name: ch.defaultReactionEmoji.name ?? null }
    : null,
  availableTags: (ch.availableTags || []).map((t) => ({
    name: t.name,
    moderated: Boolean(t.moderated),
    emoji: t.emoji ? { id: t.emoji.id ?? null, name: t.emoji.name ?? null } : null,
  })),
});

const CREATE_LABELS = [
  'Paramètres du serveur',
  'Rôles',
  'Salons et permissions',
  'Membres et bannissements',
  'Emojis et stickers',
  'Webhooks, AutoMod et événements',
  'Accueil et onboarding',
  'Enregistrement',
];

async function fetchAllBans(guild) {
  const out = [];
  let after;
  for (;;) {
    const page = await guild.bans.fetch({ limit: 1000, after, cache: false });
    if (!page.size) break;
    let maxId = after ? big(after) : 0n;
    for (const ban of page.values()) {
      out.push({ id: ban.user.id, reason: ban.reason || null });
      if (big(ban.user.id) > maxId) maxId = big(ban.user.id);
    }
    if (page.size < 1000) break;
    after = maxId.toString();
  }
  return out;
}

async function snapshot(guild, job, warn) {
  const rest = guild.client.rest;
  const data = {
    version: FORMAT_VERSION,
    createdAt: Date.now(),
    guild: {},
    everyonePermissions: guild.roles.everyone.permissions.bitfield.toString(),
    roles: [],
    channels: [],
    members: [],
    bans: [],
    emojis: [],
    stickers: [],
    webhooks: [],
    automod: [],
    events: [],
    welcome: null,
    onboarding: null,
    stats: {},
  };

  const attempt = async (label, fn) => {
    try {
      return await fn();
    } catch (err) {
      warn(`${label} : ${err.message}`);
      return null;
    }
  };

  // 1. Paramètres
  setStep(job, 0);
  await attempt('Paramètres', async () => {
    await guild.fetch();
    data.guild = {
      id: guild.id,
      name: guild.name,
      description: guild.description ?? null,
      preferredLocale: guild.preferredLocale,
      verificationLevel: guild.verificationLevel,
      defaultMessageNotifications: guild.defaultMessageNotifications,
      explicitContentFilter: guild.explicitContentFilter,
      afkTimeout: guild.afkTimeout,
      afkChannelId: guild.afkChannelId ?? null,
      systemChannelId: guild.systemChannelId ?? null,
      systemChannelFlags: guild.systemChannelFlags?.bitfield ?? 0,
      rulesChannelId: guild.rulesChannelId ?? null,
      publicUpdatesChannelId: guild.publicUpdatesChannelId ?? null,
      safetyAlertsChannelId: guild.safetyAlertsChannelId ?? null,
      premiumProgressBarEnabled: Boolean(guild.premiumProgressBarEnabled),
      icon: await toDataUri(guild.iconURL({ size: 1024, extension: ext(guild.icon) })),
      banner: await toDataUri(guild.bannerURL({ size: 1024, extension: ext(guild.banner) })),
      splash: await toDataUri(guild.splashURL({ size: 1024, extension: 'png' })),
    };
  });
  if (!data.guild.id) data.guild = { id: guild.id, name: guild.name };

  // 2. Rôles
  setStep(job, 1);
  await attempt('Rôles', async () => {
    const roles = await guild.roles.fetch();
    const defs = [...roles.values()]
      .filter((r) => r.id !== guild.id && !r.managed)
      .sort(byPosition);
    tick(job, 0, defs.length);
    let i = 0;
    for (const r of defs) {
      data.roles.push({
        id: r.id,
        name: r.name,
        color: r.color,
        hoist: r.hoist,
        mentionable: r.mentionable,
        permissions: r.permissions.bitfield.toString(),
        position: r.position,
        unicodeEmoji: r.unicodeEmoji ?? null,
        icon: r.icon ? await toDataUri(r.iconURL({ size: 128, extension: 'png' })) : null,
      });
      tick(job, ++i);
    }
  });

  // 3. Salons
  setStep(job, 2);
  await attempt('Salons', async () => {
    const channels = await guild.channels.fetch();
    const defs = [...channels.values()].filter(Boolean).map(channelDef);
    data.channels = defs;
    tick(job, defs.length, defs.length);
  });

  // 4. Membres et bannissements
  setStep(job, 3);
  await attempt('Membres', async () => {
    const members = await guild.members.fetch();
    for (const m of members.values()) {
      const roles = [...m.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed).map((r) => r.id);
      if (roles.length || m.nickname) data.members.push({ id: m.id, bot: m.user.bot, nick: m.nickname ?? null, roles });
    }
  });
  await attempt('Bannissements', async () => {
    data.bans = await fetchAllBans(guild);
  });

  // 5. Emojis et stickers
  setStep(job, 4);
  await attempt('Emojis', async () => {
    const emojis = [...(await guild.emojis.fetch()).values()];
    tick(job, 0, emojis.length);
    let i = 0;
    for (const e of emojis) {
      const image = await toDataUri(e.imageURL({ size: 128, extension: e.animated ? 'gif' : 'png' }));
      if (image) {
        data.emojis.push({
          id: e.id,
          name: e.name,
          animated: Boolean(e.animated),
          roles: [...(e.roles?.cache?.keys() ?? [])],
          image,
        });
      } else warn(`Emoji « ${e.name} » : image introuvable`);
      tick(job, ++i);
    }
  });
  await attempt('Stickers', async () => {
    for (const s of (await guild.stickers.fetch()).values()) {
      const image = await toDataUri(s.url);
      if (image) {
        data.stickers.push({
          id: s.id,
          name: s.name,
          description: s.description ?? null,
          tags: s.tags ?? null,
          format: s.format,
          image,
        });
      } else warn(`Sticker « ${s.name} » : image introuvable`);
    }
  });

  // 6. Webhooks, AutoMod, événements
  setStep(job, 5);
  await attempt('Webhooks', async () => {
    for (const w of (await guild.fetchWebhooks()).values()) {
      if (w.type !== WebhookType.Incoming || !w.channelId) continue;
      data.webhooks.push({
        id: w.id,
        name: w.name,
        channelId: w.channelId,
        avatar: await toDataUri(w.avatarURL({ size: 256, extension: 'png' })),
      });
    }
  });
  await attempt('AutoMod', async () => {
    for (const rule of (await guild.autoModerationRules.fetch()).values()) {
      data.automod.push({
        name: rule.name,
        eventType: rule.eventType,
        triggerType: rule.triggerType,
        triggerMetadata: JSON.parse(JSON.stringify(rule.triggerMetadata ?? {})),
        actions: rule.actions.map((a) => ({
          type: a.type,
          metadata: {
            channelId: a.metadata?.channelId ?? null,
            durationSeconds: a.metadata?.durationSeconds ?? null,
            customMessage: a.metadata?.customMessage ?? null,
          },
        })),
        enabled: rule.enabled,
        exemptRoles: [...rule.exemptRoles.keys()],
        exemptChannels: [...rule.exemptChannels.keys()],
      });
    }
  });
  await attempt('Événements', async () => {
    for (const ev of (await guild.scheduledEvents.fetch()).values()) {
      data.events.push({
        name: ev.name,
        description: ev.description ?? null,
        scheduledStartTimestamp: ev.scheduledStartTimestamp,
        scheduledEndTimestamp: ev.scheduledEndTimestamp ?? null,
        privacyLevel: ev.privacyLevel,
        entityType: ev.entityType,
        channelId: ev.channelId ?? null,
        location: ev.entityMetadata?.location ?? null,
        image: ev.image ? await toDataUri(ev.coverImageURL({ size: 1024, extension: 'png' })) : null,
      });
    }
  });

  // 7. Accueil et onboarding (serveurs Communauté)
  setStep(job, 6);
  if (guild.features.includes('COMMUNITY')) {
    data.welcome = await attempt('Écran d’accueil', () => rest.get(Routes.guildWelcomeScreen(guild.id)));
    if (data.welcome) data.welcome.enabled = guild.features.includes('WELCOME_SCREEN_ENABLED');
    data.onboarding = await attempt('Onboarding', () => rest.get(Routes.guildOnboarding(guild.id)));
  }

  const nonCategory = data.channels.filter((c) => c.type !== T.GuildCategory).length;
  data.stats = {
    roles: data.roles.length,
    categories: data.channels.length - nonCategory,
    channels: nonCategory,
    members: data.members.length,
    bans: data.bans.length,
    emojis: data.emojis.length,
    stickers: data.stickers.length,
    webhooks: data.webhooks.length,
    automod: data.automod.length,
    events: data.events.length,
  };
  return data;
}

async function createBackup(guild, { by, onChange } = {}) {
  if (isBusy(guild.id)) throw new Error('Une opération est déjà en cours.');
  const job = startJob(guild.id, 'create', CREATE_LABELS, onChange);
  const warnings = [];
  const warn = (m) => {
    if (warnings.length < 20) warnings.push(m);
  };

  try {
    const data = await snapshot(guild, job, warn);
    data.createdBy = by || null;
    setStep(job, 7);
    const entry = await saveBackupFile(guild.id, data);

    job.finished = true;
    job.ok = true;
    job.report = { entry, warnings };
    notify(job);

    await sendLog(guild, {
      title: 'Sauvegarde créée',
      fields: [
        ['Contenu', `${data.stats.roles} rôles · ${data.stats.categories} catégories · ${data.stats.channels} salons`],
        ['Taille', `${(entry.bytes / 1024 / 1024).toFixed(2)} Mo`],
        ...(warnings.length ? [['Avertissements', warnings.join('\n')]] : []),
        ...(by ? [['Par', `<@${by}>`]] : []),
      ],
    });
    return { entry, warnings };
  } catch (err) {
    console.error('[backup] Création impossible :', err);
    job.finished = true;
    job.ok = false;
    job.error = err.message;
    notify(job);
    throw err;
  }
}

/* -------------------------------------------------------------------------- */
/*  Restauration                                                              */
/* -------------------------------------------------------------------------- */

const FALLBACK_TYPE = {
  [T.GuildAnnouncement]: T.GuildText,
  [T.GuildStageVoice]: T.GuildVoice,
  [T.GuildForum]: T.GuildText,
  [T.GuildMedia]: T.GuildText,
};

const CATEGORIES = ['roles', 'channels', 'emojis', 'stickers', 'webhooks', 'automod', 'events', 'bans', 'members'];

// Options de restauration choisies dans le panel (par serveur)
const options = new Map();
const getOptions = (guildId) => options.get(guildId) || { unban: false };
const setOption = (guildId, key, value) => options.set(guildId, { ...getOptions(guildId), [key]: value });

async function restore(guild, backupId, { mode = 'merge', keepChannelId = null, by, onChange } = {}) {
  if (isBusy(guild.id)) throw new Error('Une opération est déjà en cours.');
  const wipe = mode === 'wipe';
  const unban = Boolean(getOptions(guild.id).unban);

  const stepDefs = [
    ...(wipe ? [['wipe', 'Nettoyage du serveur']] : []),
    ['settings', 'Paramètres du serveur'],
    ['roles', 'Rôles'],
    ['emojis', 'Emojis'],
    ['stickers', 'Stickers'],
    ['channels', 'Catégories et salons'],
    ['order', 'Ordre des rôles et salons'],
    ['refs', 'Salons système, accueil et onboarding'],
    ['webhooks', 'Webhooks'],
    ['automod', 'AutoMod'],
    ['events', 'Événements'],
    ['bans', 'Bannissements'],
    ['members', 'Rôles et pseudos des membres'],
    ['config', 'Configuration du bot'],
  ];
  const job = startJob(guild.id, 'restore', stepDefs.map((s) => s[1]), onChange);
  job.mode = mode;

  const report = {
    mode,
    stats: Object.fromEntries(CATEGORIES.map((k) => [k, { created: 0, existing: 0, failed: 0 }])),
    warnings: [],
    omitted: 0,
  };
  const warn = (m) => {
    if (report.warnings.length < 25) report.warnings.push(m);
    else report.omitted++;
  };

  try {
    const bk = await loadBackup(guild.id, backupId);

    await sendLog(guild, {
      title: wipe ? 'Restauration lancée — reconstruction complète' : 'Restauration lancée — ajout des éléments manquants',
      fields: [
        ['Sauvegarde', `<t:${Math.floor(bk.createdAt / 1000)}:f>`],
        ...(by ? [['Par', `<@${by}>`]] : []),
      ],
    });

    // État frais
    await guild.roles.fetch();
    await guild.channels.fetch();
    await guild.members.fetch().catch(() => null);
    await guild.emojis.fetch().catch(() => null);
    await guild.stickers.fetch().catch(() => null);

    const me = guild.members.me || (await guild.members.fetchMe());
    const isAdmin = me.permissions.has(PermissionFlagsBits.Administrator);
    const botPerms = me.permissions.bitfield;
    const canRoleIcons = guild.features.includes('ROLE_ICONS');
    if (!isAdmin) warn('Le bot n’a pas la permission Administrateur : certaines permissions peuvent être omises.');

    const roleMap = new Map([[bk.guild?.id ?? guild.id, guild.id]]);
    const chanMap = new Map();
    const emojiMap = new Map();

    const mapRole = (id) => roleMap.get(id) ?? (guild.roles.cache.has(id) ? id : null);
    const mapChan = (id) => (id ? chanMap.get(id) ?? null : null);
    const mapEmoji = (id) => (id ? emojiMap.get(id) ?? (guild.emojis.cache.has(id) ? id : null) : null);

    const runStep = async (key, fn) => {
      const index = stepDefs.findIndex((s) => s[0] === key);
      setStep(job, index);
      try {
        await fn();
      } catch (err) {
        console.error(`[backup] Étape « ${key} » :`, err);
        warn(`Étape « ${stepDefs[index][1]} » interrompue : ${err.message}`);
      }
    };

    /* ------------------------------ Nettoyage ------------------------------ */
    if (wipe) {
      await runStep('wipe', async () => {
        const keep = new Set(
          [keepChannelId, guild.rulesChannelId, guild.publicUpdatesChannelId, guild.safetyAlertsChannelId].filter(Boolean),
        );
        const channels = [...guild.channels.cache.values()].filter((c) => !keep.has(c.id));
        const roles = [...guild.roles.cache.values()].filter((r) => r.id !== guild.id && !r.managed && r.editable);
        const emojis = [...guild.emojis.cache.values()];
        const stickers = [...guild.stickers.cache.values()];
        const rules = [...((await guild.autoModerationRules.fetch().catch(() => null))?.values() ?? [])];
        const events = [...((await guild.scheduledEvents.fetch().catch(() => null))?.values() ?? [])];

        const total = channels.length + roles.length + emojis.length + stickers.length + rules.length + events.length;
        let done = 0;
        tick(job, 0, total);
        const del = async (label, item) => {
          try {
            await item.delete(REASON);
          } catch (err) {
            warn(`Suppression de ${label} impossible : ${err.message}`);
          }
          tick(job, ++done);
        };
        for (const c of channels) await del(`#${c.name}`, c);
        for (const r of roles) await del(`@${r.name}`, r);
        for (const e of emojis) await del(`:${e.name}:`, e);
        for (const s of stickers) await del(`sticker ${s.name}`, s);
        for (const x of rules) await del(`règle ${x.name}`, x);
        for (const x of events) await del(`événement ${x.name}`, x);
      });
    }

    /* ------------------------------ Paramètres ----------------------------- */
    await runStep('settings', async () => {
      const g = bk.guild || {};
      const community = guild.features.includes('COMMUNITY');
      const base = {
        name: g.name,
        preferredLocale: g.preferredLocale,
        verificationLevel: g.verificationLevel,
        defaultMessageNotifications: g.defaultMessageNotifications,
        explicitContentFilter: g.explicitContentFilter,
        afkTimeout: g.afkTimeout,
        systemChannelFlags: g.systemChannelFlags,
        premiumProgressBarEnabled: g.premiumProgressBarEnabled,
        reason: REASON,
      };
      if (community && g.description) base.description = g.description;
      for (const k of Object.keys(base)) if (base[k] === undefined || base[k] === null) delete base[k];
      await guild.edit(base).catch((err) => warn(`Paramètres du serveur : ${err.message}`));
      for (const [key, label] of [['icon', 'Icône'], ['banner', 'Bannière'], ['splash', 'Image d’invitation']]) {
        if (!g[key]) continue;
        await guild.edit({ [key]: g[key], reason: REASON }).catch((err) => warn(`${label} : ${err.message}`));
      }
      await guild.roles.everyone
        .setPermissions(big(bk.everyonePermissions) & (isAdmin ? ~0n : botPerms), REASON)
        .catch((err) => warn(`Permissions de @everyone : ${err.message}`));
    });

    /* -------------------------------- Rôles -------------------------------- */
    const mappedRoles = [];
    await runStep('roles', async () => {
      const pending = new Map();
      for (const r of guild.roles.cache.values()) {
        if (r.id === guild.id || r.managed) continue;
        if (!pending.has(r.name)) pending.set(r.name, []);
        pending.get(r.name).push(r);
      }
      const defs = [...bk.roles].sort(byPosition);
      tick(job, 0, defs.length);
      let done = 0;
      for (const def of defs) {
        const existing = pending.get(def.name)?.shift();
        if (existing) {
          roleMap.set(def.id, existing.id);
          mappedRoles.push(existing);
          report.stats.roles.existing++;
        } else {
          try {
            const data = {
              name: def.name,
              color: def.color,
              hoist: def.hoist,
              mentionable: def.mentionable,
              permissions: big(def.permissions) & (isAdmin ? ~0n : botPerms),
              reason: REASON,
            };
            if (canRoleIcons && def.unicodeEmoji) data.unicodeEmoji = def.unicodeEmoji;
            else if (canRoleIcons && def.icon) data.icon = fromDataUri(def.icon);
            const role = await guild.roles.create(data);
            roleMap.set(def.id, role.id);
            mappedRoles.push(role);
            report.stats.roles.created++;
          } catch (err) {
            report.stats.roles.failed++;
            warn(`Rôle « ${def.name} » : ${err.message}`);
          }
        }
        tick(job, ++done);
      }
    });

    /* -------------------------------- Emojis ------------------------------- */
    await runStep('emojis', async () => {
      const have = new Map([...guild.emojis.cache.values()].map((e) => [e.name, e]));
      tick(job, 0, bk.emojis.length);
      let done = 0;
      for (const def of bk.emojis) {
        const existing = have.get(def.name);
        if (existing) {
          emojiMap.set(def.id, existing.id);
          report.stats.emojis.existing++;
        } else {
          try {
            const roles = (def.roles || []).map(mapRole).filter(Boolean);
            const emoji = await guild.emojis.create({
              attachment: fromDataUri(def.image),
              name: def.name,
              ...(roles.length ? { roles } : {}),
              reason: REASON,
            });
            emojiMap.set(def.id, emoji.id);
            report.stats.emojis.created++;
          } catch (err) {
            report.stats.emojis.failed++;
            warn(`Emoji « ${def.name} » : ${err.message}`);
          }
        }
        tick(job, ++done);
      }
    });

    /* ------------------------------- Stickers ------------------------------ */
    await runStep('stickers', async () => {
      const have = new Set([...guild.stickers.cache.values()].map((s) => s.name));
      tick(job, 0, bk.stickers.length);
      let done = 0;
      for (const def of bk.stickers) {
        if (have.has(def.name)) {
          report.stats.stickers.existing++;
        } else {
          try {
            await guild.stickers.create({
              file: { attachment: fromDataUri(def.image), name: `${def.name}.${def.format === 4 ? 'gif' : def.format === 3 ? 'json' : 'png'}` },
              name: def.name,
              tags: def.tags || def.name,
              description: def.description || undefined,
              reason: REASON,
            });
            report.stats.stickers.created++;
          } catch (err) {
            report.stats.stickers.failed++;
            warn(`Sticker « ${def.name} » : ${err.message}`);
          }
        }
        tick(job, ++done);
      }
    });

    /* --------------------------- Catégories / salons ----------------------- */
    const mappedChannels = []; // { id, position }
    await runStep('channels', async () => {
      const mask = isAdmin ? ~0n : botPerms;
      const used = new Set();
      const specials = new Map(); // ancien id -> salon conservé (rules, updates…)
      if (wipe) {
        const pairs = [
          [bk.guild?.rulesChannelId, guild.rulesChannelId],
          [bk.guild?.publicUpdatesChannelId, guild.publicUpdatesChannelId],
          [bk.guild?.safetyAlertsChannelId, guild.safetyAlertsChannelId],
        ];
        for (const [oldId, newId] of pairs) if (oldId && newId && guild.channels.cache.has(newId)) specials.set(oldId, newId);
        if (keepChannelId && bk.channels.some((c) => c.id === keepChannelId)) specials.set(keepChannelId, keepChannelId);
      }

      const mapOverwrites = (def) => {
        const out = [];
        for (const o of def.overwrites || []) {
          const id = o.type === 0 ? mapRole(o.id) : guild.members.cache.has(o.id) ? o.id : null;
          if (!id) continue;
          out.push({ id, type: o.type, allow: big(o.allow) & mask, deny: big(o.deny) });
        }
        return out;
      };

      const findExisting = (def, parentNew) => {
        const special = specials.get(def.id);
        if (special) return guild.channels.cache.get(special) || null;
        return (
          guild.channels.cache.find(
            (c) =>
              !used.has(c.id) &&
              (!wipe || c.id !== keepChannelId) &&
              c.type === def.type &&
              c.name === def.name &&
              (wipe || (c.parentId ?? null) === (parentNew ?? null)),
          ) || null
        );
      };

      const buildOptions = (def, type, parentNew, overwrites) => {
        const o = { name: def.name, type, reason: REASON };
        if (parentNew) o.parent = parentNew;
        if (overwrites.length) o.permissionOverwrites = overwrites;
        switch (type) {
          case T.GuildText:
          case T.GuildAnnouncement:
            if (def.topic) o.topic = def.topic;
            if (def.nsfw) o.nsfw = true;
            if (type === T.GuildText && def.rateLimitPerUser) o.rateLimitPerUser = def.rateLimitPerUser;
            if (def.defaultAutoArchiveDuration) o.defaultAutoArchiveDuration = def.defaultAutoArchiveDuration;
            break;
          case T.GuildVoice:
          case T.GuildStageVoice:
            if (def.bitrate) o.bitrate = Math.min(def.bitrate, guild.maximumBitrate || def.bitrate);
            if (def.userLimit) o.userLimit = def.userLimit;
            if (def.rtcRegion) o.rtcRegion = def.rtcRegion;
            if (type === T.GuildVoice && def.videoQualityMode) o.videoQualityMode = def.videoQualityMode;
            if (def.rateLimitPerUser) o.rateLimitPerUser = def.rateLimitPerUser;
            if (def.nsfw) o.nsfw = true;
            break;
          case T.GuildForum:
          case T.GuildMedia:
            if (def.topic) o.topic = def.topic;
            if (def.nsfw) o.nsfw = true;
            if (def.rateLimitPerUser) o.rateLimitPerUser = def.rateLimitPerUser;
            if (def.defaultAutoArchiveDuration) o.defaultAutoArchiveDuration = def.defaultAutoArchiveDuration;
            if (def.defaultThreadRateLimitPerUser) o.defaultThreadRateLimitPerUser = def.defaultThreadRateLimitPerUser;
            if (def.defaultSortOrder !== null && def.defaultSortOrder !== undefined) o.defaultSortOrder = def.defaultSortOrder;
            if (type === T.GuildForum && def.defaultForumLayout) o.defaultForumLayout = def.defaultForumLayout;
            if (def.availableTags?.length) {
              o.availableTags = def.availableTags.map((t) => {
                const tag = { name: t.name, moderated: t.moderated };
                if (t.emoji) {
                  const id = t.emoji.id ? mapEmoji(t.emoji.id) : null;
                  if (id) tag.emoji = { id, name: null };
                  else if (!t.emoji.id && t.emoji.name) tag.emoji = { id: null, name: t.emoji.name };
                }
                return tag;
              });
            }
            if (def.defaultReactionEmoji) {
              const r = def.defaultReactionEmoji;
              const id = r.id ? mapEmoji(r.id) : null;
              if (id) o.defaultReactionEmoji = { id, name: null };
              else if (!r.id && r.name) o.defaultReactionEmoji = { id: null, name: r.name };
            }
            break;
          default:
        }
        return o;
      };

      const cats = bk.channels.filter((c) => c.type === T.GuildCategory).sort(byPosition);
      const others = bk.channels.filter((c) => c.type !== T.GuildCategory).sort(byPosition);
      const ordered = [...cats, ...others];
      tick(job, 0, ordered.length);
      let done = 0;

      for (const def of ordered) {
        const parentNew = def.parentId ? mapChan(def.parentId) : null;
        if (def.parentId && !parentNew) warn(`Salon « ${def.name} » : catégorie d’origine introuvable, créé hors catégorie`);

        const existing = findExisting(def, parentNew);
        if (existing) {
          used.add(existing.id);
          chanMap.set(def.id, existing.id);
          report.stats.channels.existing++;
          if (wipe && specials.has(def.id)) {
            await existing
              .edit({
                name: def.name,
                parent: parentNew,
                permissionOverwrites: mapOverwrites(def),
                ...(def.topic ? { topic: def.topic } : {}),
                reason: REASON,
              })
              .catch((err) => warn(`Salon « ${def.name} » : ${err.message}`));
          }
          mappedChannels.push({ id: existing.id, position: def.position });
        } else {
          const overwrites = mapOverwrites(def);
          let created = null;
          try {
            created = await guild.channels.create(buildOptions(def, def.type, parentNew, overwrites));
          } catch (err) {
            const fallback = FALLBACK_TYPE[def.type];
            if (fallback) {
              try {
                created = await guild.channels.create(buildOptions(def, fallback, parentNew, overwrites));
                warn(`Salon « ${def.name} » : type indisponible sur ce serveur, recréé en salon classique`);
              } catch (err2) {
                warn(`Salon « ${def.name} » : ${err2.message}`);
              }
            } else {
              warn(`Salon « ${def.name} » : ${err.message}`);
            }
          }
          if (created) {
            used.add(created.id);
            chanMap.set(def.id, created.id);
            mappedChannels.push({ id: created.id, position: def.position });
            report.stats.channels.created++;
          } else {
            report.stats.channels.failed++;
          }
        }
        tick(job, ++done);
      }
    });

    /* -------------------------------- Ordre -------------------------------- */
    await runStep('order', async () => {
      const list = mappedRoles.filter((r) => r.editable);
      if (list.length > 1) {
        const slots = list.map((r) => r.position).sort((a, b) => a - b);
        await guild.roles
          .setPositions(list.map((role, i) => ({ role: role.id, position: slots[i] })))
          .catch((err) => warn(`Ordre des rôles : ${err.message}`));
      }
      if (wipe && mappedChannels.length) {
        await guild.channels
          .setPositions(mappedChannels.map((c) => ({ channel: c.id, position: c.position })))
          .catch((err) => warn(`Ordre des salons : ${err.message}`));
      }
    });

    /* ----------------------- Références, accueil, onboarding --------------- */
    await runStep('refs', async () => {
      const g = bk.guild || {};
      const refs = [
        ['afkChannelId', 'afkChannel', 'Salon AFK'],
        ['systemChannelId', 'systemChannel', 'Salon système'],
        ['rulesChannelId', 'rulesChannel', 'Salon des règles'],
        ['publicUpdatesChannelId', 'publicUpdatesChannel', 'Salon des mises à jour'],
        ['safetyAlertsChannelId', 'safetyAlertsChannel', 'Salon des alertes de sécurité'],
      ];
      for (const [key, option, label] of refs) {
        const id = mapChan(g[key]);
        if (id && guild[key] !== id) {
          await guild.edit({ [option]: id, reason: REASON }).catch((err) => warn(`${label} : ${err.message}`));
        }
      }

      const rest = guild.client.rest;
      if (bk.welcome && guild.features.includes('COMMUNITY')) {
        try {
          const channels = (bk.welcome.welcome_channels || [])
            .map((w) => {
              const channelId = mapChan(w.channel_id);
              if (!channelId) return null;
              const emojiId = w.emoji_id ? mapEmoji(w.emoji_id) : null;
              return {
                channel_id: channelId,
                description: w.description,
                emoji_id: emojiId,
                emoji_name: emojiId ? null : w.emoji_id ? null : w.emoji_name ?? null,
              };
            })
            .filter(Boolean);
          await rest.patch(Routes.guildWelcomeScreen(guild.id), {
            body: { enabled: Boolean(bk.welcome.enabled), description: bk.welcome.description ?? null, welcome_channels: channels },
            reason: REASON,
          });
        } catch (err) {
          warn(`Écran d’accueil : ${err.message}`);
        }
      }

      if (bk.onboarding && guild.features.includes('COMMUNITY')) {
        try {
          let seq = 0;
          const snowflake = () => ((BigInt(Date.now()) - 1420070400000n) << 22n | BigInt(seq++ % 4096)).toString();
          const ch = (ids) => (ids || []).map(mapChan).filter(Boolean);
          const prompts = (bk.onboarding.prompts || []).map((p) => ({
            id: snowflake(),
            type: p.type,
            title: p.title,
            single_select: p.single_select,
            required: p.required,
            in_onboarding: p.in_onboarding,
            options: (p.options || []).map((o) => {
              const emojiId = o.emoji?.id ? mapEmoji(o.emoji.id) : null;
              return {
                id: snowflake(),
                title: o.title,
                description: o.description ?? null,
                channel_ids: ch(o.channel_ids),
                role_ids: (o.role_ids || []).map(mapRole).filter(Boolean),
                emoji_id: emojiId,
                emoji_name: emojiId ? null : o.emoji?.id ? null : o.emoji?.name ?? null,
                emoji_animated: Boolean(o.emoji?.animated),
              };
            }),
          }));
          await rest.put(Routes.guildOnboarding(guild.id), {
            body: {
              prompts,
              default_channel_ids: ch(bk.onboarding.default_channel_ids),
              enabled: Boolean(bk.onboarding.enabled),
              mode: bk.onboarding.mode,
            },
            reason: REASON,
          });
        } catch (err) {
          warn(`Onboarding : ${err.message}`);
        }
      }
    });

    /* ------------------------------- Webhooks ------------------------------ */
    await runStep('webhooks', async () => {
      const have = new Set();
      for (const w of (await guild.fetchWebhooks().catch(() => null))?.values() ?? []) have.add(`${w.channelId}|${w.name}`);
      tick(job, 0, bk.webhooks.length);
      let done = 0;
      for (const def of bk.webhooks) {
        const channelId = mapChan(def.channelId);
        const channel = channelId ? guild.channels.cache.get(channelId) : null;
        if (have.has(`${channelId}|${def.name}`)) report.stats.webhooks.existing++;
        else if (!channel || typeof channel.createWebhook !== 'function') report.stats.webhooks.failed++;
        else {
          try {
            await channel.createWebhook({ name: def.name, avatar: fromDataUri(def.avatar) || undefined, reason: REASON });
            report.stats.webhooks.created++;
          } catch (err) {
            report.stats.webhooks.failed++;
            warn(`Webhook « ${def.name} » : ${err.message}`);
          }
        }
        tick(job, ++done);
      }
      if (report.stats.webhooks.created) warn('Les webhooks recréés ont de nouvelles URL : mets à jour les services qui les utilisent.');
    });

    /* -------------------------------- AutoMod ------------------------------ */
    await runStep('automod', async () => {
      const have = new Set([...((await guild.autoModerationRules.fetch().catch(() => null))?.values() ?? [])].map((r) => r.name));
      for (const def of bk.automod) {
        if (have.has(def.name)) {
          report.stats.automod.existing++;
          continue;
        }
        try {
          await guild.autoModerationRules.create({
            name: def.name,
            eventType: def.eventType,
            triggerType: def.triggerType,
            triggerMetadata: def.triggerMetadata,
            actions: def.actions.map((a) => {
              const metadata = {};
              const channel = mapChan(a.metadata?.channelId);
              if (channel) metadata.channel = channel;
              if (a.metadata?.durationSeconds) metadata.durationSeconds = a.metadata.durationSeconds;
              if (a.metadata?.customMessage) metadata.customMessage = a.metadata.customMessage;
              return { type: a.type, ...(Object.keys(metadata).length ? { metadata } : {}) };
            }),
            enabled: def.enabled,
            exemptRoles: (def.exemptRoles || []).map(mapRole).filter(Boolean),
            exemptChannels: (def.exemptChannels || []).map(mapChan).filter(Boolean),
            reason: REASON,
          });
          report.stats.automod.created++;
        } catch (err) {
          report.stats.automod.failed++;
          warn(`Règle AutoMod « ${def.name} » : ${err.message}`);
        }
      }
    });

    /* ------------------------------- Événements ---------------------------- */
    await runStep('events', async () => {
      const have = new Set([...((await guild.scheduledEvents.fetch().catch(() => null))?.values() ?? [])].map((e) => e.name));
      for (const def of bk.events) {
        if (have.has(def.name)) {
          report.stats.events.existing++;
          continue;
        }
        if (!def.scheduledStartTimestamp || def.scheduledStartTimestamp < Date.now() + 60_000) continue; // événement passé
        try {
          const data = {
            name: def.name,
            description: def.description || undefined,
            scheduledStartTime: def.scheduledStartTimestamp,
            privacyLevel: def.privacyLevel,
            entityType: def.entityType,
            reason: REASON,
          };
          if (def.scheduledEndTimestamp) data.scheduledEndTime = def.scheduledEndTimestamp;
          const channel = mapChan(def.channelId);
          if (channel) data.channel = channel;
          if (def.location) data.entityMetadata = { location: def.location };
          if (def.image) data.image = fromDataUri(def.image);
          await guild.scheduledEvents.create(data);
          report.stats.events.created++;
        } catch (err) {
          report.stats.events.failed++;
          warn(`Événement « ${def.name} » : ${err.message}`);
        }
      }
    });

    /* ------------------------------ Bannissements -------------------------- */
    await runStep('bans', async () => {
      const current = new Map((await fetchAllBans(guild).catch(() => [])).map((b) => [b.id, b]));
      const wanted = new Set(bk.bans.map((b) => b.id));
      tick(job, 0, bk.bans.length);
      let done = 0;
      await pool(bk.bans, 3, async (ban) => {
        if (current.has(ban.id)) report.stats.bans.existing++;
        else {
          try {
            await guild.bans.create(ban.id, { reason: ban.reason || REASON });
            report.stats.bans.created++;
          } catch (err) {
            report.stats.bans.failed++;
            warn(`Bannissement ${ban.id} : ${err.message}`);
          }
        }
        tick(job, ++done);
      });
      if (unban) {
        let removed = 0;
        for (const id of current.keys()) {
          if (wanted.has(id)) continue;
          try {
            await guild.bans.remove(id, REASON);
            removed++;
          } catch (err) {
            warn(`Débannissement ${id} : ${err.message}`);
          }
        }
        if (removed) warn(`${removed} membre(s) bannis depuis la sauvegarde ont été débannis.`);
      }
    });

    /* -------------------------------- Membres ------------------------------ */
    await runStep('members', async () => {
      const cfg = store.guild(guild.id);
      const targets = bk.members.filter((m) => guild.members.cache.has(m.id) && !cfg.quarantined[m.id]);
      tick(job, 0, targets.length);
      let done = 0;
      await pool(targets, 3, async (def) => {
        const member = guild.members.cache.get(def.id);
        try {
          if (member && member.manageable) {
            const wanted = def.roles.map(mapRole).filter((id) => id && !member.roles.cache.has(id));
            const roles = wanted.filter((id) => {
              const role = guild.roles.cache.get(id);
              return role && role.editable;
            });
            if (roles.length) {
              await member.roles.add(roles, REASON);
              report.stats.members.created++;
            } else report.stats.members.existing++;
            if (def.nick && !member.nickname) await member.setNickname(def.nick, REASON).catch(() => {});
          } else report.stats.members.existing++;
        } catch (err) {
          report.stats.members.failed++;
          warn(`Membre ${def.id} : ${err.message}`);
        }
        tick(job, ++done);
      });
    });

    /* ----------------------------- Config du bot --------------------------- */
    await runStep('config', async () => {
      const cfg = store.guild(guild.id);
      const roleId = cfg.quarantineRoleId && roleMap.get(cfg.quarantineRoleId);
      if (roleId) cfg.quarantineRoleId = roleId;
      const logId = cfg.logChannelId && chanMap.get(cfg.logChannelId);
      if (logId) cfg.logChannelId = logId;
      for (const rec of Object.values(cfg.quarantined)) {
        rec.roles = (rec.roles || []).map((id) => roleMap.get(id) ?? id).filter((id) => guild.roles.cache.has(id));
        if (rec.roleId && roleMap.has(rec.roleId)) rec.roleId = roleMap.get(rec.roleId);
      }
      store.save();
    });

    job.finished = true;
    job.ok = true;
    job.report = report;
    notify(job);

    const s = report.stats;
    await sendLog(guild, {
      title: 'Restauration terminée',
      fields: [
        ['Rôles', `${s.roles.created} créés · ${s.roles.existing} existants · ${s.roles.failed} échecs`],
        ['Salons', `${s.channels.created} créés · ${s.channels.existing} existants · ${s.channels.failed} échecs`],
        ['Durée', `${Math.round((Date.now() - job.startedAt) / 1000)} s`],
        ...(report.warnings.length ? [['Avertissements', report.warnings.slice(0, 8).join('\n')]] : []),
      ],
    });
    return report;
  } catch (err) {
    console.error('[backup] Restauration impossible :', err);
    job.finished = true;
    job.ok = false;
    job.error = err.message;
    job.report = report;
    notify(job);
    throw err;
  }
}

module.exports = {
  init,
  list,
  get,
  getJob,
  isBusy,
  dismissJob,
  createBackup,
  restore,
  remove,
  readRaw,
  importBuffer,
  getOptions,
  setOption,
  ID_RE,
};
