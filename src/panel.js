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
const { quarantineMember, releaseMember } = require('./quarantine');
const { sendLog, clip } = require('./logger');
const { COLORS, ID_RE, MODULES, getOwnerId } = require('./constants');

/* -------------------------------------------------------------------------- */
/*  Helpers de construction                                                   */
/* -------------------------------------------------------------------------- */

const text = (content) => new TextDisplayBuilder().setContent(content);
const divider = () => new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small);
const row = (...components) => new ActionRowBuilder().addComponents(...components);
const button = (id, label, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
const toggle = (id, label, on) => button(id, `${label} · ${on ? 'ON' : 'OFF'}`, on ? ButtonStyle.Success : ButtonStyle.Secondary);

const PAGES = [
  ['home', 'Accueil'],
  ['whitelist', 'Whitelist'],
  ['protections', 'Protections'],
  ['quarantine', 'Quarantaine'],
  ['settings', 'Paramètres'],
];

function navRow(active) {
  return row(...PAGES.map(([id, label]) => button(`nav:${id}`, label, id === active ? ButtonStyle.Primary : ButtonStyle.Secondary)));
}

const header = (title, subtitle) => text(`## ${title}\n-# ${subtitle}`);

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

  return issues.length
    ? `**Diagnostic**\n${issues.map((i) => `• ${i}`).join('\n')}`
    : '**Diagnostic** — Configuration opérationnelle';
}

function pageHome(c, guild, cfg) {
  const modules = Object.values(cfg.modules);
  const active = modules.filter((m) => m.enabled).length;
  const raid = cfg.raid.active ? `**Actif** · fin <t:${Math.floor(cfg.raid.until / 1000)}:R>` : 'Inactif';

  const lines = [
    `**Whitelist des bots** — ${cfg.whitelist.enabled ? 'Active' : 'Désactivée'} · ${Object.keys(cfg.whitelist.bots).length} bot(s)`,
    `**Modules de protection** — ${active}/${modules.length} actifs`,
    `**Mode raid** — ${raid}`,
    `**Membres en quarantaine** — ${Object.keys(cfg.quarantined).length}`,
    '',
    `**Rôle de quarantaine** — ${cfg.quarantineRoleId ? `<@&${cfg.quarantineRoleId}>` : '`Non défini`'}`,
    `**Salon de logs** — ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '`Non défini`'}`,
  ];

  c.addTextDisplayComponents(header('Anti-Raid', `${escapeMarkdown(guild.name)} · Panel de contrôle`))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(lines.join('\n')))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(diagnostics(guild, cfg)))
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(
        button('raid:toggle', cfg.raid.active ? 'Désactiver le mode raid' : 'Activer le mode raid', cfg.raid.active ? ButtonStyle.Danger : ButtonStyle.Secondary),
        button('panel:close', 'Fermer'),
      ),
    );
}

function pageWhitelist(c, guild, cfg) {
  const entries = Object.entries(cfg.whitelist.bots);
  const list = entries.slice(0, 20).map(([id, b]) => `• **${escapeMarkdown(b.name || 'Bot')}** · \`${id}\``);
  if (entries.length > 20) list.push(`… et ${entries.length - 20} autre(s)`);

  const body = [
    `**Whitelist** — ${cfg.whitelist.enabled ? 'Active' : 'Désactivée'}`,
    `**Sanction de l’ajouteur** — ${cfg.punishInviter ? 'Activée' : 'Désactivée'}`,
    '',
    `**Bots autorisés** (${entries.length})`,
    list.length ? list.join('\n') : '`Aucun bot whitelisté.`',
  ].join('\n');

  c.addTextDisplayComponents(
    header('Whitelist des bots', 'Tout bot absent de cette liste est expulsé dès son arrivée.'),
  )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(body))
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(
        button('wl:add', 'Ajouter un bot', ButtonStyle.Primary),
        button('wl:remove', 'Retirer un bot'),
        button('wl:import', 'Importer les bots présents'),
      ),
    )
    .addActionRowComponents(
      row(toggle('wl:toggle', 'Whitelist', cfg.whitelist.enabled), toggle('wl:inviter', 'Sanction de l’ajouteur', cfg.punishInviter)),
    );
}

function pageProtections(c, cfg) {
  const lines = Object.entries(MODULES).map(([key, def]) => {
    const m = cfg.modules[key];
    return `\`${m.enabled ? 'ON ' : 'OFF'}\` **${def.label}** · ${m.limit} ${def.unit} / ${m.window} s`;
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
          description: `${m.enabled ? 'Actif' : 'Inactif'} · ${m.limit} ${def.unit} en ${m.window} s`,
        };
      }),
    );

  c.addTextDisplayComponents(
    header('Protections', 'Chaque dépassement de seuil met l’auteur en quarantaine.'),
  )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(lines.join('\n')))
    .addSeparatorComponents(divider())
    .addActionRowComponents(row(select))
    .addActionRowComponents(
      row(button('prot:all_on', 'Tout activer'), button('prot:all_off', 'Tout désactiver'), button('prot:reset', 'Valeurs par défaut')),
    );
}

function pageModule(c, cfg, key) {
  const def = MODULES[key];
  const m = cfg.modules[key];
  const lines = [
    def.desc,
    '',
    `**Statut** — ${m.enabled ? 'Actif' : 'Inactif'}`,
    `**Seuil** — ${m.limit} ${def.unit} en ${m.window} s`,
  ];
  if (key === 'joinFlood') lines.push(`**Durée du mode raid** — ${m.duration} min`);
  lines.push('**Sanction** — Quarantaine automatique');

  c.addTextDisplayComponents(header(def.label, 'Module de protection'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(lines.join('\n')))
    .addSeparatorComponents(divider())
    .addActionRowComponents(
      row(
        toggle(`mod:toggle:${key}`, 'Module', m.enabled),
        button(`mod:edit:${key}`, 'Modifier le seuil', ButtonStyle.Primary),
        button('nav:protections:back', 'Retour'),
      ),
    );
}

function pageQuarantine(c, cfg) {
  const entries = Object.entries(cfg.quarantined).sort((a, b) => b[1].at - a[1].at);
  const list = entries
    .slice(0, 10)
    .map(([id, r]) => `• <@${id}> · ${escapeMarkdown(clip(r.reason || 'Sans motif', 80))} · <t:${Math.floor(r.at / 1000)}:R>`);
  if (entries.length > 10) list.push(`… et ${entries.length - 10} autre(s)`);

  c.addTextDisplayComponents(
    header('Quarantaine', 'Rôles retirés et remplacés par le rôle de quarantaine.'),
  )
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(list.length ? list.join('\n') : '`Aucun membre en quarantaine.`'))
    .addSeparatorComponents(divider());

  if (entries.length) {
    c.addActionRowComponents(
      row(
        new StringSelectMenuBuilder()
          .setCustomId('q:release')
          .setPlaceholder('Libérer un membre (restaure ses rôles)…')
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
  c.addActionRowComponents(row(button('q:manual', 'Quarantaine manuelle')));
}

function pageSettings(c, guild, cfg) {
  const exempt = Object.entries(cfg.exempt);
  const exemptList = exempt.slice(0, 15).map(([id, e]) => `• **${escapeMarkdown(e.name || 'Inconnu')}** · \`${id}\``);
  if (exempt.length > 15) exemptList.push(`… et ${exempt.length - 15} autre(s)`);

  const body = [
    `**Rôle de quarantaine** — ${cfg.quarantineRoleId ? `<@&${cfg.quarantineRoleId}>` : '`Non défini`'}`,
    `**Salon de logs** — ${cfg.logChannelId ? `<#${cfg.logChannelId}>` : '`Non défini`'}`,
    '',
    `**Exemptions** (${exempt.length}) — ignorées par les protections automatiques`,
    exemptList.length ? exemptList.join('\n') : '`Aucune exemption.`',
  ].join('\n');

  const roleSelect = new RoleSelectMenuBuilder()
    .setCustomId('set:role')
    .setPlaceholder('Choisir le rôle de quarantaine')
    .setMinValues(1)
    .setMaxValues(1);
  if (cfg.quarantineRoleId && guild.roles.cache.has(cfg.quarantineRoleId)) roleSelect.setDefaultRoles(cfg.quarantineRoleId);

  const channelSelect = new ChannelSelectMenuBuilder()
    .setCustomId('set:channel')
    .setPlaceholder('Choisir le salon de logs')
    .setChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
    .setMinValues(1)
    .setMaxValues(1);
  if (cfg.logChannelId && guild.channels.cache.has(cfg.logChannelId)) channelSelect.setDefaultChannels(cfg.logChannelId);

  c.addTextDisplayComponents(header('Paramètres', 'Rôle de quarantaine, salon de logs et exemptions.'))
    .addSeparatorComponents(divider())
    .addTextDisplayComponents(text(body))
    .addSeparatorComponents(divider())
    .addActionRowComponents(row(roleSelect))
    .addActionRowComponents(row(channelSelect))
    .addActionRowComponents(
      row(
        button('set:testlog', 'Tester les logs'),
        button('ex:add', 'Ajouter une exemption'),
        button('ex:remove', 'Retirer une exemption'),
      ),
    );
}

/** Construit le message complet du panel pour une page donnée. */
function build(guild, page = 'home') {
  const [name, arg] = String(page).split(':');
  const cfg = store.guild(guild.id);
  const c = new ContainerBuilder().setAccentColor(COLORS.panel);
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
    case 'settings':
      pageSettings(c, guild, cfg);
      break;
    default:
      active = 'home';
      pageHome(c, guild, cfg);
  }

  c.addSeparatorComponents(divider()).addActionRowComponents(navRow(active));

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
      await interaction.update(build(guild, action));
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
      if (modal) {
        await interaction.showModal(modal);
        return;
      }
    }

    await interaction.deferUpdate();
    const cfg = store.guild(guild.id);
    const notify = (content) => interaction.followUp({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
    let page = 'home';

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

    await interaction.editReply(build(guild, page));
  } catch (err) {
    console.error('[panel] Erreur d’interaction :', err);
    const payload = { content: 'Une erreur est survenue. Réessaie dans un instant.', flags: MessageFlags.Ephemeral };
    if (interaction.deferred || interaction.replied) await interaction.followUp(payload).catch(() => {});
    else await interaction.reply(payload).catch(() => {});
  }
}

module.exports = { build, handleInteraction };
