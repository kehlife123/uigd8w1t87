'use strict';

const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ContainerBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RoleSelectMenuBuilder,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  StringSelectMenuBuilder,
  TextDisplayBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
} = require('discord.js');

const store = require('./store');
const protection = require('./protection');
const backup = require('./backup');
const { quarantineMember, releaseMember } = require('./quarantine');
const { sendLog, clip } = require('./logger');
const { COLORS, ID_RE, MODULES, getOwnerId } = require('./constants');

/* -------------------------------------------------------------------------- */
/*  Briques de construction (Components V2)                                   */
/* -------------------------------------------------------------------------- */

const text = (content) => new TextDisplayBuilder().setContent(content);
const rule = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const gap = () => new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small);
const row = (...components) => new ActionRowBuilder().addComponents(...components);

const button = (id, label, { danger = false, disabled = false } = {}) =>
  new ButtonBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(danger ? ButtonStyle.Danger : ButtonStyle.Secondary)
    .setDisabled(disabled);

/** Une ligne de réglage : libellé + état discret à gauche, action à droite. */
const line = (title, detail, accessory) =>
  new SectionBuilder()
    .addTextDisplayComponents(text(detail ? `${title}\n-# ${detail}` : title))
    .setButtonAccessory(accessory);

const head = (title, subtitle) => text(`## ${title}${subtitle ? `\n-# ${subtitle}` : ''}`);
const state = (on) => (on ? 'Actif' : 'Inactif');

const PAGES = [
  ['home', 'Accueil'],
  ['whitelist', 'Whitelist'],
  ['protections', 'Protections'],
  ['quarantine', 'Quarantaine'],
  ['backup', 'Sauvegarde'],
  ['settings', 'Paramètres'],
];

function nav(active) {
  return row(
    new StringSelectMenuBuilder()
      .setCustomId('nav:go')
      .setPlaceholder('Aller à…')
      .addOptions(PAGES.map(([value, label]) => ({ label, value, default: value === active }))),
  );
}

const fmtDate = (ms) =>
  new Date(ms).toLocaleString('fr-FR', {
    timeZone: process.env.TIMEZONE || 'UTC',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
const fmtSize = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} Mo` : `${Math.max(1, Math.round(bytes / 1024))} Ko`);
const fmtDuration = (ms) => {
  const s = Math.floor(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
};
const summary = (st = {}) =>
  `${st.roles ?? 0} rôles · ${st.categories ?? 0} catégories · ${st.channels ?? 0} salons · ${st.emojis ?? 0} emojis`;

/* -------------------------------------------------------------------------- */
/*  Pages                                                                     */
/* -------------------------------------------------------------------------- */

function diagnostics(guild, cfg) {
  const issues = [];
  const me = guild.members.me;

  if (me) {
    const needed = [
      [PermissionFlagsBits.ManageRoles, 'Gérer les rôles'],
      [PermissionFlagsBits.KickMembers, 'Expulser des membres'],
      [PermissionFlagsBits.ViewAuditLog, 'Voir les logs du serveur'],
    ];
    for (const [flag, label] of needed) {
      if (!me.permissions.has(flag)) issues.push(`Permission manquante : ${label}`);
    }
  }

  if (!cfg.quarantineRoleId) issues.push('Rôle de quarantaine non défini');
  else {
    const role = guild.roles.cache.get(cfg.quarantineRoleId);
    if (!role) issues.push('Rôle de quarantaine introuvable');
    else if (!role.editable) issues.push('Rôle de quarantaine au-dessus du rôle du bot');
  }

  if (!cfg.logChannelId) issues.push('Salon de logs non défini');
  else {
    const channel = guild.channels.cache.get(cfg.logChannelId);
    if (!channel) issues.push('Salon de logs introuvable');
    else if (me && !channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      issues.push('Le bot ne peut pas écrire dans le salon de logs');
    }
  }
  return issues;
}

function pageHome(c, guild, cfg) {
  const modules = Object.values(cfg.modules);
  const active = modules.filter((m) => m.enabled).length;
  const quarantined = Object.keys(cfg.quarantined).length;
  const last = backup.list(guild.id)[0];
  const open = (page) => button(`nav:${page}`, 'Ouvrir');

  c.addTextDisplayComponents(head('Anti-Raid', escapeMarkdown(guild.name)))
    .addSeparatorComponents(rule())
    .addSectionComponents(
      line(
        'Mode raid',
        cfg.raid.active ? `Actif · fin <t:${Math.floor(cfg.raid.until / 1000)}:R>` : 'Inactif',
        button('raid:toggle', cfg.raid.active ? 'Désactiver' : 'Activer', { danger: cfg.raid.active }),
      ),
      line('Whitelist', `${state(cfg.whitelist.enabled)} · ${Object.keys(cfg.whitelist.bots).length} bot(s)`, open('whitelist')),
      line('Protections', `${active} sur ${modules.length} actives`, open('protections')),
      line('Quarantaine', quarantined ? `${quarantined} membre(s)` : 'Aucun membre', open('quarantine')),
      line('Sauvegarde', last ? `Dernière : <t:${Math.floor(last.createdAt / 1000)}:R>` : 'Aucune sauvegarde', open('backup')),
    );

  const issues = diagnostics(guild, cfg);
  if (issues.length) {
    c.addSeparatorComponents(rule()).addTextDisplayComponents(text(`-# À corriger\n${issues.map((i) => `-# • ${i}`).join('\n')}`));
  }
}

function pageWhitelist(c, guild, cfg) {
  const entries = Object.entries(cfg.whitelist.bots);
  const list = entries.slice(0, 20).map(([id, b]) => `${escapeMarkdown(b.name || 'Bot')} · \`${id}\``);
  if (entries.length > 20) list.push(`-# … et ${entries.length - 20} autre(s)`);

  c.addTextDisplayComponents(head('Whitelist', 'Tout bot absent de la liste est expulsé à son arrivée.'))
    .addSeparatorComponents(rule())
    .addSectionComponents(
      line('Whitelist', state(cfg.whitelist.enabled), button('wl:toggle', cfg.whitelist.enabled ? 'Désactiver' : 'Activer')),
      line(
        'Sanction de l’ajouteur',
        state(cfg.punishInviter),
        button('wl:inviter', cfg.punishInviter ? 'Désactiver' : 'Activer'),
      ),
    )
    .addSeparatorComponents(rule())
    .addTextDisplayComponents(text(`Bots autorisés · ${entries.length}\n${list.length ? list.join('\n') : '-# Aucun bot.'}`))
    .addActionRowComponents(
      row(button('wl:add', 'Ajouter'), button('wl:remove', 'Retirer'), button('wl:import', 'Importer les bots présents')),
    );
}

function pageProtections(c, cfg) {
  const lines = Object.entries(MODULES).map(([key, def]) => {
    const m = cfg.modules[key];
    return m.enabled ? `${def.label} · ${m.limit} ${def.unit} / ${m.window} s` : `-# ${def.label} · désactivé`;
  });

  const select = new StringSelectMenuBuilder()
    .setCustomId('prot:select')
    .setPlaceholder('Configurer un module…')
    .addOptions(
      Object.entries(MODULES).map(([key, def]) => {
        const m = cfg.modules[key];
        return {
          label: def.label,
          value: key,
          description: `${state(m.enabled)} · ${m.limit} ${def.unit} en ${m.window} s`,
        };
      }),
    );

  c.addTextDisplayComponents(head('Protections', 'Un dépassement de seuil met l’auteur en quarantaine.'))
    .addSeparatorComponents(rule())
    .addTextDisplayComponents(text(lines.join('\n')))
    .addSeparatorComponents(rule())
    .addActionRowComponents(row(select))
    .addActionRowComponents(
      row(button('prot:all_on', 'Tout activer'), button('prot:all_off', 'Tout désactiver'), button('prot:reset', 'Valeurs par défaut')),
    );
}

function pageModule(c, cfg, key) {
  const def = MODULES[key];
  const m = cfg.modules[key];
  const threshold = `${m.limit} ${def.unit} en ${m.window} s${key === 'joinFlood' ? ` · mode raid ${m.duration} min` : ''}`;

  c.addTextDisplayComponents(head(def.label, def.desc))
    .addSeparatorComponents(rule())
    .addSectionComponents(
      line('Statut', state(m.enabled), button(`mod:toggle:${key}`, m.enabled ? 'Désactiver' : 'Activer')),
      line('Seuil', threshold, button(`mod:edit:${key}`, 'Modifier')),
    )
    .addTextDisplayComponents(text('-# Sanction : quarantaine automatique'))
    .addActionRowComponents(row(button('nav:protections', 'Retour')));
}

function pageQuarantine(c, cfg) {
  const entries = Object.entries(cfg.quarantined).sort((a, b) => b[1].at - a[1].at);
  const list = entries
    .slice(0, 10)
    .map(([id, r]) => `<@${id}> · ${escapeMarkdown(clip(r.reason || 'Sans motif', 80))} · <t:${Math.floor(r.at / 1000)}:R>`);
  if (entries.length > 10) list.push(`-# … et ${entries.length - 10} autre(s)`);

  c.addTextDisplayComponents(head('Quarantaine', 'Rôles retirés et remplacés par le rôle de quarantaine.'))
    .addSeparatorComponents(rule())
    .addTextDisplayComponents(text(list.length ? list.join('\n') : '-# Aucun membre en quarantaine.'));

  if (entries.length) {
    c.addActionRowComponents(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('q:release')
          .setPlaceholder('Libérer un membre…')
          .addOptions(
            entries.slice(0, 25).map(([id, r]) => ({
              label: clip(r.name || id, 100),
              value: id,
              description: clip(r.reason || 'Sans motif', 100),
            })),
          ),
      ),
    );
  }
  c.addSeparatorComponents(rule()).addSectionComponents(
    line('Quarantaine manuelle', 'Par identifiant', button('q:manual', 'Mettre en quarantaine')),
  );
}

function pageSettings(c, guild, cfg) {
  const exempt = Object.entries(cfg.exempt);
  const exemptList = exempt.slice(0, 15).map(([id, e]) => `${escapeMarkdown(e.name || 'Inconnu')} · \`${id}\``);
  if (exempt.length > 15) exemptList.push(`-# … et ${exempt.length - 15} autre(s)`);

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('set:role')
    .setPlaceholder('Rôle de quarantaine')
    .setMinValues(1)
    .setMaxValues(1);
  if (cfg.quarantineRoleId && guild.roles.cache.has(cfg.quarantineRoleId)) roleSelect.setDefaultRoles(cfg.quarantineRoleId);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('set:channel')
    .setPlaceholder('Salon de logs')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  if (cfg.logChannelId && guild.channels.cache.has(cfg.logChannelId)) channelSelect.setDefaultChannels(cfg.logChannelId);

  c.addTextDisplayComponents(head('Paramètres', 'Rôle de quarantaine, salon de logs, exemptions.'))
    .addSeparatorComponents(rule())
    .addActionRowComponents(row(roleSelect))
    .addActionRowComponents(row(channelSelect))
    .addSectionComponents(line('Logs', 'Envoyer un message de test', button('set:testlog', 'Tester')))
    .addSeparatorComponents(rule())
    .addTextDisplayComponents(
      text(`Exemptions · ${exempt.length}\n-# Ignorées par les protections automatiques\n${exemptList.length ? exemptList.join('\n') : '-# Aucune.'}`),
    )
    .addActionRowComponents(row(button('ex:add', 'Ajouter'), button('ex:remove', 'Retirer')));
}

/* ------------------------------ Sauvegarde -------------------------------- */

function pageBackup(c, guild) {
  const list = backup.list(guild.id);

  c.addTextDisplayComponents(head('Sauvegarde', 'Copie complète du serveur, restaurable après une attaque.'))
    .addSeparatorComponents(rule())
    .addSectionComponents(
      line(
        'Nouvelle sauvegarde',
        'Rôles, salons, permissions, emojis, stickers, webhooks, AutoMod, événements, bans, rôles des membres',
        button('bk:create', 'Créer'),
      ),
    )
    .addSeparatorComponents(rule());

  if (!list.length) {
    c.addTextDisplayComponents(text('-# Aucune sauvegarde pour le moment.'));
    return;
  }

  c.addTextDisplayComponents(
    text(list.map((e, i) => `${i + 1}. <t:${Math.floor(e.createdAt / 1000)}:f> · ${summary(e.stats)} · ${fmtSize(e.bytes)}`).join('\n')),
  ).addActionRowComponents(
    row(
      new StringSelectMenuBuilder()
        .setCustomId('bk:select')
        .setPlaceholder('Choisir une sauvegarde…')
        .addOptions(
          list.map((e, i) => ({
            label: `${i + 1}. ${fmtDate(e.createdAt)}`,
            value: e.id,
            description: clip(summary(e.stats), 100),
          })),
        ),
    ),
  );
}

function pageBackupDetail(c, guild, id) {
  const entry = backup.get(guild.id, id);
  if (!entry) return pageBackup(c, guild);
  const opts = backup.getOptions(guild.id);
  const st = entry.stats || {};

  c.addTextDisplayComponents(
    head('Sauvegarde', `<t:${Math.floor(entry.createdAt / 1000)}:f> · ${fmtSize(entry.bytes)}${entry.imported ? ' · importée' : ''}`),
  )
    .addTextDisplayComponents(
      text(
        `${summary(st)}\n-# ${st.stickers ?? 0} stickers · ${st.webhooks ?? 0} webhooks · ${st.automod ?? 0} règles AutoMod · ${st.events ?? 0} événements · ${st.bans ?? 0} bans · ${st.members ?? 0} membres`,
      ),
    )
    .addSeparatorComponents(rule())
    .addSectionComponents(
      line(
        'Restaurer · ajouter ce qui manque',
        'Crée les rôles, salons et éléments absents. Ne supprime rien et ne modifie pas l’existant.',
        button(`bk:merge:${id}`, 'Restaurer'),
      ),
      line(
        'Restaurer · tout reconstruire',
        'Supprime les salons et rôles actuels, puis recrée le serveur à l’identique.',
        button(`bk:wipe:${id}`, 'Reconstruire', { danger: true }),
      ),
    )
    .addSeparatorComponents(rule())
    .addSectionComponents(
      line(
        'Débannir les bannis récents',
        opts.unban ? 'Oui · les bans absents de la sauvegarde seront levés' : 'Non · seuls les bans manquants sont rétablis',
        button(`bk:unban:${id}`, opts.unban ? 'Désactiver' : 'Activer'),
      ),
      line('Exporter', 'Fichier .json.gz à conserver hors du serveur', button(`bk:export:${id}`, 'Exporter')),
      line('Supprimer', 'Retire cette sauvegarde du stockage', button(`bk:delete:${id}`, 'Supprimer')),
    )
    .addActionRowComponents(row(button('nav:backup', 'Retour')));
}

const STAT_LABELS = {
  roles: 'Rôles',
  channels: 'Salons',
  emojis: 'Emojis',
  stickers: 'Stickers',
  webhooks: 'Webhooks',
  automod: 'AutoMod',
  events: 'Événements',
  bans: 'Bans',
  members: 'Membres',
};

function pageJob(c, job) {
  const title = job.kind === 'create' ? 'Création de la sauvegarde' : 'Restauration';
  const elapsed = fmtDuration(Date.now() - job.startedAt);

  if (!job.finished) {
    const label = job.labels[job.index] || '…';
    const progress = job.total ? ` · ${job.done} / ${job.total}` : '';
    c.addTextDisplayComponents(head(title, `En cours · ${elapsed}`))
      .addSeparatorComponents(rule())
      .addTextDisplayComponents(text(`Étape ${job.index + 1} sur ${job.labels.length}\n${label}${progress}`))
      .addTextDisplayComponents(text('-# Ne modifie pas le serveur pendant l’opération.'));
    return;
  }

  if (!job.ok) {
    c.addTextDisplayComponents(head(title, 'Échec'))
      .addSeparatorComponents(rule())
      .addTextDisplayComponents(text(clip(job.error || 'Erreur inconnue.', 1500)))
      .addActionRowComponents(row(button('bk:dismiss', 'Fermer')));
    return;
  }

  const report = job.report || {};
  const stats = report.stats || {};
  const lines = Object.entries(STAT_LABELS)
    .filter(([key]) => stats[key] && (stats[key].created || stats[key].existing || stats[key].failed))
    .map(([key, label]) => {
      const s = stats[key];
      return `${label} · ${s.created} créé(s) · ${s.existing} existant(s)${s.failed ? ` · ${s.failed} échec(s)` : ''}`;
    });
  const warnings = (report.warnings || []).slice(0, 8).map((w) => `-# • ${clip(w, 180)}`);
  const hidden = (report.warnings?.length || 0) - warnings.length + (report.omitted || 0);

  c.addTextDisplayComponents(head(title, `Terminée · ${elapsed}`)).addSeparatorComponents(rule());
  c.addTextDisplayComponents(text(lines.length ? lines.join('\n') : '-# Aucun changement nécessaire.'));
  if (warnings.length) {
    c.addSeparatorComponents(rule()).addTextDisplayComponents(
      text(`-# Avertissements\n${warnings.join('\n')}${hidden > 0 ? `\n-# … et ${hidden} autre(s)` : ''}`),
    );
  }
  if (job.mode === 'wipe') {
    c.addTextDisplayComponents(text('-# Ce salon a été conservé pour afficher le rapport : tu peux le supprimer ensuite.'));
  }
  c.addActionRowComponents(row(button('bk:dismiss', 'Terminer')));
}

/** Construit le message complet du panel pour une page donnée. */
function build(guild, page = 'home') {
  const [name, arg] = String(page).split(':');
  const cfg = store.guild(guild.id);
  const c = new ContainerBuilder();

  const job = backup.getJob(guild.id);
  if (job) {
    pageJob(c, job);
    return { components: [c], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
  }

  let active = name;
  switch (name) {
    case 'whitelist':
      pageWhitelist(c, guild, cfg);
      break;
    case 'protections':
      pageProtections(c, cfg);
      break;
    case 'module':
      active = 'protections';
      if (MODULES[arg]) pageModule(c, cfg, arg);
      else pageProtections(c, cfg);
      break;
    case 'quarantine':
      pageQuarantine(c, cfg);
      break;
    case 'backup':
      if (arg) pageBackupDetail(c, guild, arg);
      else pageBackup(c, guild);
      break;
    case 'settings':
      pageSettings(c, guild, cfg);
      break;
    default:
      active = 'home';
      pageHome(c, guild, cfg);
  }

  c.addSeparatorComponents(gap()).addActionRowComponents(nav(active));
  if (active === 'home') c.addActionRowComponents(row(button('panel:close', 'Fermer')));

  return { components: [c], flags: MessageFlags.IsComponentsV2, allowedMentions: { parse: [] } };
}

/* -------------------------------------------------------------------------- */
/*  Modales                                                                   */
/* -------------------------------------------------------------------------- */

function input(id, label, { value, placeholder, min = 1, max = 20 } = {}) {
  const field = new TextInputBuilder()
    .setCustomId(id)
    .setLabel(label)
    .setStyle(TextInputStyle.Short)
    .setMinLength(min)
    .setMaxLength(max)
    .setRequired(true);
  if (value !== undefined) field.setValue(String(value));
  if (placeholder) field.setPlaceholder(placeholder);
  return new ActionRowBuilder().addComponents(field);
}

function idModal(customId, title, label) {
  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(input('value', label, { placeholder: '123456789012345678', min: 17, max: 20 }));
}

function thresholdModal(key, cfg) {
  const def = MODULES[key];
  const m = cfg.modules[key];
  const modal = new ModalBuilder()
    .setCustomId(`mod:edit_modal:${key}`)
    .setTitle(clip(def.label, 45))
    .addComponents(
      input('limit', `Seuil (${def.unit})`, { value: m.limit, max: 3 }),
      input('window', 'Fenêtre de temps (secondes)', { value: m.window, max: 4 }),
    );
  if (key === 'joinFlood') modal.addComponents(input('duration', 'Durée du mode raid (minutes)', { value: m.duration, max: 4 }));
  return modal;
}

const WIPE_WORD = 'RECONSTRUIRE';
const wipeModal = (id) =>
  new ModalBuilder()
    .setCustomId(`bk:wipe_modal:${id}`)
    .setTitle('Tout reconstruire')
    .addComponents(input('confirm', `Tape ${WIPE_WORD} pour confirmer`, { placeholder: WIPE_WORD, min: 1, max: 20 }));

/* -------------------------------------------------------------------------- */
/*  Interactions                                                              */
/* -------------------------------------------------------------------------- */

const configLog = (guild, what) =>
  sendLog(guild, {
    title: 'Configuration modifiée',
    color: COLORS.info,
    fields: [
      ['Action', what],
      ['Par', `<@${getOwnerId()}>`],
    ],
  });

const parseIntIn = (raw, min, max) => {
  const n = Number(String(raw).trim());
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
};

/** Limite la fréquence des mises à jour du message pendant une longue tâche. */
function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return () => {
    const wait = ms - (Date.now() - last);
    if (wait <= 0) {
      last = Date.now();
      fn();
    } else if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        last = Date.now();
        fn();
      }, wait);
    }
  };
}

async function handleInteraction(interaction) {
  const relevant = interaction.isButton() || interaction.isAnySelectMenu() || interaction.isModalSubmit();
  if (!relevant || !interaction.guild) return;

  if (interaction.user.id !== getOwnerId()) {
    await interaction
      .reply({ content: 'Accès refusé : seul le propriétaire du bot peut utiliser ce panel.', flags: MessageFlags.Ephemeral })
      .catch(() => {});
    return;
  }

  const guild = interaction.guild;
  const [ns, action, arg] = interaction.customId.split(':');

  try {
    // Navigation (mise à jour immédiate)
    if (ns === 'nav') {
      const target = interaction.isAnySelectMenu() ? interaction.values[0] : action;
      await interaction.update(build(guild, target));
      return;
    }

    // Ouverture de modales (doivent répondre en moins de 3 s, sans defer)
    if (interaction.isButton()) {
      const cfg = store.guild(guild.id);
      const key = `${ns}:${action}`;
      let modal = null;
      if (key === 'wl:add') modal = idModal('wl:add_modal', 'Ajouter un bot', 'Identifiant (ID) du bot');
      else if (key === 'wl:remove') modal = idModal('wl:remove_modal', 'Retirer un bot', 'Identifiant du bot (sera expulsé)');
      else if (key === 'q:manual') modal = idModal('q:manual_modal', 'Quarantaine manuelle', 'Identifiant (ID) du membre');
      else if (key === 'ex:add') modal = idModal('ex:add_modal', 'Ajouter une exemption', 'Identifiant (ID) du membre ou bot');
      else if (key === 'ex:remove') modal = idModal('ex:remove_modal', 'Retirer une exemption', 'Identifiant (ID) à retirer');
      else if (key === 'mod:edit' && MODULES[arg]) modal = thresholdModal(arg, cfg);
      else if (key === 'bk:wipe' && backup.get(guild.id, arg) && !backup.isBusy(guild.id)) modal = wipeModal(arg);
      if (modal) {
        await interaction.showModal(modal);
        return;
      }
    }

    await interaction.deferUpdate();
    const cfg = store.guild(guild.id);
    const notify = (content) => interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    const refresh = (p) => interaction.message?.edit(build(guild, p)).catch(() => {});
    let page = 'home';

    /** Lance une tâche longue en rafraîchissant le message toutes les 3 s. */
    const runJob = async (fn) => {
      const onChange = throttle(() => refresh('backup'), 3000);
      return fn(onChange);
    };

    switch (`${ns}:${action}`) {
      case 'panel:close':
        await interaction.message.delete().catch(() => {});
        return;

      case 'raid:toggle':
        if (cfg.raid.active) await protection.deactivateRaid(guild, { reason: 'Désactivation manuelle' });
        else await protection.activateRaid(guild, { reason: 'Activation manuelle' });
        page = 'home';
        break;

      /* ------------------------------ Whitelist ------------------------------ */
      case 'wl:toggle':
        cfg.whitelist.enabled = !cfg.whitelist.enabled;
        store.save();
        configLog(guild, `Whitelist des bots : ${cfg.whitelist.enabled ? 'activée' : 'désactivée'}`);
        page = 'whitelist';
        break;

      case 'wl:inviter':
        cfg.punishInviter = !cfg.punishInviter;
        store.save();
        configLog(guild, `Sanction de l’ajouteur : ${cfg.punishInviter ? 'activée' : 'désactivée'}`);
        page = 'whitelist';
        break;

      case 'wl:import': {
        await guild.members.fetch().catch(() => null);
        let added = 0;
        for (const member of guild.members.cache.values()) {
          if (member.user.bot && member.id !== guild.client.user.id && !cfg.whitelist.bots[member.id]) {
            cfg.whitelist.bots[member.id] = { name: member.user.username, addedAt: Date.now() };
            added++;
          }
        }
        store.save();
        if (added) configLog(guild, `${added} bot(s) présent(s) importé(s) dans la whitelist`);
        notify(added ? `${added} bot(s) importé(s) dans la whitelist.` : 'Aucun nouveau bot à importer.');
        page = 'whitelist';
        break;
      }

      case 'wl:add_modal': {
        page = 'whitelist';
        const id = interaction.fields.getTextInputValue('value').trim();
        if (!ID_RE.test(id)) return void notify('Identifiant invalide.');
        if (cfg.whitelist.bots[id]) return void notify('Ce bot est déjà dans la whitelist.');
        const user = await interaction.client.users.fetch(id).catch(() => null);
        if (!user) return void notify('Aucun utilisateur trouvé avec cet identifiant.');
        if (!user.bot) return void notify('Cet identifiant n’appartient pas à un bot.');
        cfg.whitelist.bots[id] = { name: user.username, addedAt: Date.now() };
        store.save();
        configLog(guild, `Bot ajouté à la whitelist : ${user.username} (\`${id}\`)`);
        break;
      }

      case 'wl:remove_modal': {
        page = 'whitelist';
        const id = interaction.fields.getTextInputValue('value').trim();
        if (!ID_RE.test(id)) return void notify('Identifiant invalide.');
        const entry = cfg.whitelist.bots[id];
        if (!entry) return void notify('Ce bot n’est pas dans la whitelist.');
        delete cfg.whitelist.bots[id];
        store.save();
        configLog(guild, `Bot retiré de la whitelist : ${entry.name || 'Bot'} (\`${id}\`)`);
        const kicked = cfg.whitelist.enabled ? await protection.kickUnauthorizedBot(guild, id, 'Retrait de la whitelist') : false;
        notify(kicked ? 'Bot retiré de la whitelist et expulsé du serveur.' : 'Bot retiré de la whitelist.');
        break;
      }

      /* ------------------------------ Protections ---------------------------- */
      case 'prot:select':
        page = MODULES[interaction.values[0]] ? `module:${interaction.values[0]}` : 'protections';
        break;

      case 'prot:all_on':
      case 'prot:all_off': {
        const enabled = action === 'all_on';
        for (const m of Object.values(cfg.modules)) m.enabled = enabled;
        store.save();
        configLog(guild, `Tous les modules ${enabled ? 'activés' : 'désactivés'}`);
        page = 'protections';
        break;
      }

      case 'prot:reset': {
        const defaults = store.defaultModules();
        for (const key of Object.keys(cfg.modules)) cfg.modules[key] = defaults[key];
        store.save();
        configLog(guild, 'Modules réinitialisés aux valeurs par défaut');
        page = 'protections';
        break;
      }

      case 'mod:toggle':
        if (cfg.modules[arg]) {
          cfg.modules[arg].enabled = !cfg.modules[arg].enabled;
          store.save();
          configLog(guild, `Module « ${MODULES[arg].label} » ${cfg.modules[arg].enabled ? 'activé' : 'désactivé'}`);
          page = `module:${arg}`;
        } else page = 'protections';
        break;

      case 'mod:edit_modal': {
        const m = cfg.modules[arg];
        if (!m) return void notify('Module inconnu.');
        page = `module:${arg}`;
        const limit = parseIntIn(interaction.fields.getTextInputValue('limit'), 1, 100);
        const windowSec = parseIntIn(interaction.fields.getTextInputValue('window'), 1, 3600);
        if (limit === null) return void notify('Seuil invalide (entier entre 1 et 100).');
        if (windowSec === null) return void notify('Fenêtre invalide (entier entre 1 et 3600 secondes).');
        let duration = m.duration;
        if (arg === 'joinFlood') {
          duration = parseIntIn(interaction.fields.getTextInputValue('duration'), 1, 1440);
          if (duration === null) return void notify('Durée invalide (entier entre 1 et 1440 minutes).');
          m.duration = duration;
        }
        m.limit = limit;
        m.window = windowSec;
        store.save();
        configLog(guild, `Seuil « ${MODULES[arg].label} » : ${limit} en ${windowSec} s`);
        break;
      }

      /* ------------------------------ Quarantaine ---------------------------- */
      case 'q:release': {
        page = 'quarantine';
        const result = await releaseMember(guild, interaction.values[0]);
        notify(
          result.ok
            ? result.present
              ? `Quarantaine levée, ${result.restored} rôle(s) restauré(s).`
              : 'Quarantaine levée (le membre a quitté le serveur).'
            : result.error,
        );
        break;
      }

      case 'q:manual_modal': {
        page = 'quarantine';
        const id = interaction.fields.getTextInputValue('value').trim();
        if (!ID_RE.test(id)) return void notify('Identifiant invalide.');
        const result = await quarantineMember(guild, id, {
          reason: 'Quarantaine manuelle',
          trigger: 'Panel',
          manual: true,
        });
        notify(result.ok ? 'Membre mis en quarantaine.' : result.error || 'Échec de la mise en quarantaine.');
        break;
      }

      /* ------------------------------- Sauvegarde ---------------------------- */
      case 'bk:select':
        page = backup.get(guild.id, interaction.values[0]) ? `backup:${interaction.values[0]}` : 'backup';
        break;

      case 'bk:dismiss':
        backup.dismissJob(guild.id);
        page = 'backup';
        break;

      case 'bk:unban':
        backup.setOption(guild.id, 'unban', !backup.getOptions(guild.id).unban);
        page = `backup:${arg}`;
        break;

      case 'bk:delete':
        await backup.remove(guild.id, arg);
        configLog(guild, 'Sauvegarde supprimée');
        page = 'backup';
        break;

      case 'bk:export': {
        page = `backup:${arg}`;
        const raw = await backup.readRaw(guild.id, arg);
        if (!raw) return void notify('Sauvegarde introuvable.');
        const stamp = new Date(Number(arg)).toISOString().slice(0, 10);
        await interaction
          .followUp({
            content: 'Garde ce fichier en lieu sûr : il contient la structure complète du serveur.',
            files: [{ attachment: raw, name: `sauvegarde-${guild.id}-${stamp}.json.gz` }],
            flags: MessageFlags.Ephemeral,
          })
          .catch((err) => notify(`Envoi du fichier impossible : ${err.message}`));
        break;
      }

      case 'bk:create': {
        page = 'backup';
        if (backup.isBusy(guild.id)) return void notify('Une opération est déjà en cours.');
        try {
          await runJob(async (onChange) => {
            const p = backup.createBackup(guild, { by: interaction.user.id, onChange });
            refresh('backup');
            await p;
          });
          backup.dismissJob(guild.id);
          notify('Sauvegarde créée.');
        } catch (err) {
          backup.dismissJob(guild.id);
          notify(`Sauvegarde impossible : ${err.message}`);
        }
        break;
      }

      case 'bk:merge':
      case 'bk:wipe_modal': {
        page = 'backup';
        const wipe = action === 'wipe_modal';
        if (wipe && interaction.fields.getTextInputValue('confirm').trim() !== WIPE_WORD) {
          return void notify('Confirmation incorrecte : rien n’a été modifié.');
        }
        if (!backup.get(guild.id, arg)) return void notify('Sauvegarde introuvable.');
        if (backup.isBusy(guild.id)) return void notify('Une opération est déjà en cours.');
        await runJob(async (onChange) => {
          const p = backup
            .restore(guild, arg, {
              mode: wipe ? 'wipe' : 'merge',
              keepChannelId: interaction.channelId,
              by: interaction.user.id,
              onChange,
            })
            .catch(() => null);
          refresh('backup');
          await p;
        });
        break; // le rapport reste affiché jusqu'à « Terminer »
      }

      /* ------------------------------ Paramètres ----------------------------- */
      case 'set:role': {
        page = 'settings';
        const role = guild.roles.cache.get(interaction.values[0]);
        if (!role || role.id === guild.id) return void notify('Ce rôle ne peut pas être utilisé.');
        if (role.managed) return void notify('Un rôle géré par une intégration ne peut pas être utilisé.');
        cfg.quarantineRoleId = role.id;
        store.save();
        configLog(guild, `Rôle de quarantaine : ${role}`);
        if (!role.editable) notify('Ce rôle est au-dessus du rôle du bot : place le rôle du bot plus haut dans la hiérarchie.');
        break;
      }

      case 'set:channel': {
        page = 'settings';
        const channel = guild.channels.cache.get(interaction.values[0]);
        if (!channel) return void notify('Salon introuvable.');
        cfg.logChannelId = channel.id;
        store.save();
        const ok = await configLog(guild, `Salon de logs défini : ${channel}`);
        if (!ok) notify('Le bot ne peut pas écrire dans ce salon (permissions manquantes).');
        break;
      }

      case 'set:testlog': {
        page = 'settings';
        const ok = await sendLog(guild, {
          title: 'Test des logs',
          color: COLORS.success,
          fields: [['Statut', 'Les logs fonctionnent correctement.']],
        });
        notify(ok ? 'Log de test envoyé.' : 'Envoi impossible : salon non défini ou permissions manquantes.');
        break;
      }

      case 'ex:add_modal': {
        page = 'settings';
        const id = interaction.fields.getTextInputValue('value').trim();
        if (!ID_RE.test(id)) return void notify('Identifiant invalide.');
        if (cfg.exempt[id]) return void notify('Cet identifiant est déjà exempté.');
        const user = await interaction.client.users.fetch(id).catch(() => null);
        if (!user) return void notify('Aucun utilisateur trouvé avec cet identifiant.');
        cfg.exempt[id] = { name: user.username, addedAt: Date.now() };
        store.save();
        configLog(guild, `Exemption ajoutée : ${user.username} (\`${id}\`)`);
        break;
      }

      case 'ex:remove_modal': {
        page = 'settings';
        const id = interaction.fields.getTextInputValue('value').trim();
        if (!cfg.exempt[id]) return void notify('Cet identifiant n’est pas dans les exemptions.');
        const entry = cfg.exempt[id];
        delete cfg.exempt[id];
        store.save();
        configLog(guild, `Exemption retirée : ${entry.name || 'Inconnu'} (\`${id}\`)`);
        break;
      }

      default:
        page = 'home';
    }

    const payload = build(guild, page);
    await interaction.editReply(payload).catch(() => interaction.message?.edit(payload).catch(() => {}));
  } catch (err) {
    console.error('[panel] Erreur d’interaction :', err);
    const payload = { content: 'Une erreur est survenue. Réessaie dans un instant.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}

module.exports = { build, handleInteraction };
