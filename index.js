require("dotenv").config();


let DISK_FULL = false; // set true when ENOSPC happens

// Build tag (helps you confirm you actually uploaded/restarted the correct file)
const BUILD_TAG = "Nozzarri Tickets FULLFIX v6";

// ---------------- SAFE INTERACTION HELPERS ----------------
// Goal: NEVER hit "Interaction failed" and NEVER double-ack interactions.
// Rules:
// - For message components (buttons/selects): prefer interaction.update() first (ack + edit in one).
// - For modals / commands: reply() or deferReply() then editReply().
// - Never call showModal() after replying/defering.
async function safeUpdate(interaction, payload) {
  try {
    // Discord does NOT allow `ephemeral` on update/editReply/message.edit.
    // If we pass it, Discord rejects the request and users see "Interaction failed".
    // Keep `ephemeral` only for the initial reply() flow.
    const cleanPayload = (() => {
      if (!payload || typeof payload !== "object") return payload;
      if (!Object.prototype.hasOwnProperty.call(payload, "ephemeral")) return payload;
      // eslint-disable-next-line no-unused-vars
      const { ephemeral, ...rest } = payload;
      return rest;
    })();

    // Message components (buttons/select menus)
    if (interaction?.isMessageComponent?.() || interaction?.isButton?.() || interaction?.isAnySelectMenu?.()) {
      // If we haven't acknowledged yet, ACK immediately to avoid "Interaction failed",
      // then edit the original message. This is more resilient than update() when
      // permissions/embeds/components cause an update payload to be rejected.
      if (!interaction.deferred && !interaction.replied) {
        try { await interaction.deferUpdate(); } catch (e) {}
        if (interaction.editReply) return await interaction.editReply(cleanPayload);
        if (interaction.message && interaction.message.edit) return await interaction.message.edit(cleanPayload);
        return null;
      }

      // If the interaction was already replied (reply/deferReply), editReply() is valid.
      if (interaction.replied) {
        if (interaction.editReply) return await interaction.editReply(cleanPayload);
      }

      // If it was deferUpdate()'d (common for components), edit the original message.
      if (interaction.message && interaction.message.edit) return await interaction.message.edit(cleanPayload);
      return null;
    }

    // Non-component interactions (slash / modal submit)
    if (!interaction.deferred && !interaction.replied) {
      // Default to ephemeral replies for setup/premium flows
      return await interaction.reply({ ...payload, ephemeral: payload?.ephemeral ?? false });
    }

    if (interaction?.editReply) return await interaction.editReply(cleanPayload);
    return null;
  } catch (e) {
    // Expired / already handled interactions
    if (e && (e.code == 10062 || e.code == 'InteractionNotReplied' || e.status == 404 || e.code == 40060)) return null;
    console.error('[safeUpdate] error:', e);
    return null;
  }
}
// ----------------------------------------------------------
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));
const {
  Client,
  GatewayIntentBits,
  Partials,
  SlashCommandBuilder,
  REST,
  Routes,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionFlagsBits,
  ChannelType,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder
} = require("discord.js");

const fs = require("fs");
// ----------------------
// Dashboard (Web Panel) dependencies
// ----------------------
const express = require("express");
const session = require("express-session");
const crypto = require("crypto");
// Node 18+ has global fetch; fallback for older Node versions:
const fetchFn = (typeof fetch === "function") ? fetch : (...args) => import("node-fetch").then(m => m.default(...args));

const path = require("path");
const clientId = process.env.CLIENT_ID;
// Per-server setup is stored automatically (see ?setup). No manual config file needed.

const token = process.env.STAR_TOKEN;

// ----------------------
// Behavior toggles
// ----------------------
// User request: do NOT DM users when a ticket is closed.
// (We keep the rating system code in the file, but disable the DM flow.)
const DISABLE_CLOSE_DMS = true;

// User request: disable any leaderboard / TopTrade feature.
// We keep code in the file, but we don't register or advertise the leaderboard commands.
const ENABLE_LEADERBOARD = false;

if (!token) {
  console.error("ERROR: STAR_TOKEN missing in .env");
  process.exit(1);
}
if (!clientId) {
  console.error("ERROR: CLIENT_ID missing in .env");
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  
  ],
  // Prevent the bot from pinging users/roles in replies by default
  allowedMentions: { parse: [], repliedUser: false },
  partials: [Partials.Channel]
});

// avoid unhandled errors killing the bot
process.on("unhandledRejection", console.error);
client.on("error", console.error);

// ----------------------
// Data files (reviews + ratedTickets to avoid duplicate ratings)
// ----------------------
const DATA_DIR = path.resolve(__dirname);
const REVIEWS_FILE = path.join(DATA_DIR, "reviews.json");
const RATED_FILE = path.join(DATA_DIR, "ratedTickets.json");

function readJsonSafe(file, def = {}) {
  try {
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(def, null, 2), "utf8");
      return def;
    }
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw || "{}");
  } catch (e) {
    console.error("Failed reading JSON:", file, e);
    return def;
  }
}

function writeJsonSafe(file, data) {
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tmp, file);
    DISK_FULL = false;
    return true;
  } catch (e) {
    if (e && e.code === 'ENOSPC') DISK_FULL = true;
    console.error(`Failed writing JSON: ${file}`, e);
    try { fs.unlinkSync(`${file}.tmp`); } catch {}
    return false;
  }
}

// Async writer (avoids blocking the event loop during interactions)
async function writeJsonSafeAsync(file, data) {
  try {
    const tmp = `${file}.tmp`;
    await fs.promises.writeFile(tmp, JSON.stringify(data, null, 2), "utf8");
    await fs.promises.rename(tmp, file);
    DISK_FULL = false;
    return true;
  } catch (e) {
    if (e && e.code === 'ENOSPC') DISK_FULL = true;
    console.error(`Failed writing JSON (async): ${file}`, e);
    try { await fs.promises.unlink(`${file}.tmp`); } catch {}
    return false;
  }
}

let REVIEWS = readJsonSafe(REVIEWS_FILE, { trade: {}, service: {} });
// Backward-compatible migration (older data used a legacy key)
const legacyKey = "m" + "m";
if (REVIEWS && !REVIEWS.trade && REVIEWS[legacyKey]) { REVIEWS.trade = REVIEWS[legacyKey]; delete REVIEWS[legacyKey]; }

let RATED = readJsonSafe(RATED_FILE, {});

// ----------------------
// Per-server config (PUBLIC BOT)
// ----------------------
// ✅ The bot can join ANY server.
// Each server can run ?setup (owner-only) to store its own category/roles/log channel.
const GUILD_CFG_FILE = path.join(DATA_DIR, "guildConfigs.json");
let GUILD_CONFIGS = readJsonSafe(GUILD_CFG_FILE, {});


// ----------------------
// Premium system (per-server unlock + branding)
// ----------------------
// ⚠️ Payments (LTC etc.) are not automatically verifiable inside this bot.
// Use a manual license key flow: you generate a key, user redeems it with ?premium-redeem <key>.
// This keeps things simple + avoids fake "payment verification" logic.
const PREMIUM_FILE = path.join(DATA_DIR, "premiumGuilds.json");
const PREMIUM_KEYS_FILE = path.join(DATA_DIR, "premiumKeys.json");

// premium state: { [guildId]: { isPremium: true, activatedAt: ISO, branding: { name, iconUrl, accent } } }
let PREMIUM_GUILDS = readJsonSafe(PREMIUM_FILE, {});
// keys state: { [key]: { createdAt: ISO, used: boolean, usedByGuildId: string|null, usedAt: ISO|null } }
let PREMIUM_KEYS = readJsonSafe(PREMIUM_KEYS_FILE, {});

// Who can generate premium keys (bot owner(s))
// Set OWNER_IDS in .env: OWNER_IDS=123,456
const OWNER_IDS = (process.env.OWNER_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

function isBotOwner(userId){
  return OWNER_IDS.includes(String(userId));
}


// ===== Middleman prefix commands (custom) =====
// Role(s) allowed to use MM commands (optional). Comma-separated role IDs.
// Example in .env: MIDDLEMAN_SUPPORT_ROLE_IDS=111,222
const MIDDLEMAN_SUPPORT_ROLE_IDS = (process.env.MIDDLEMAN_SUPPORT_ROLE_IDS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

// Role to grant when pressing the green button on ?mercy
// Put this in .env: MERCY_JOIN_ROLE_ID=123456789012345678
const MERCY_JOIN_ROLE_ID = String(process.env.MERCY_JOIN_ROLE_ID || "").trim();

// Restrict secret MM commands to the official server only.
// Recommended: set NOZZARRI_GUILD_ID in Railway Variables.
// Optional: NOZZARRI_GUILD_NAME (defaults to "Nozzarri Tickets")
const NOZZARRI_GUILD_ID = String(process.env.NOZZARRI_GUILD_ID || "").trim();
const NOZZARRI_GUILD_NAME = String(process.env.NOZZARRI_GUILD_NAME || "Nozzarri Tickets").trim();

function isNozzarriGuild(guild) {
  if (!guild) return false;
  if (NOZZARRI_GUILD_ID) return guild.id === NOZZARRI_GUILD_ID;
  const name = String(guild.name || "").toLowerCase();
  const target = String(NOZZARRI_GUILD_NAME || "").toLowerCase();
  return (target && name === target) || name.includes("nozzarri");
}


function isMMCommandAllowed(member) {
  if (!member) return false;

  // Bot owner(s)
  if (isBotOwner(member.id)) return true;

  // Server owner
  if (member.guild && member.id === member.guild.ownerId) return true;

  // Admin permission
  try {
    if (member.permissions?.has?.(PermissionsBitField.Flags.Administrator)) return true;
  } catch {}

  // Roles from ?setup (Admin / Support / Middleman)
  try{
    if (member.guild) {
      const cfg = getGuildConfig(member.guild.id);
      const roleIds = [
        ...(Array.isArray(cfg.adminRoles) ? cfg.adminRoles : []),
        ...(Array.isArray(cfg.supportRoles) ? cfg.supportRoles : []),
        ...(Array.isArray(cfg.mmRoles) ? cfg.mmRoles : []),
      ];
      if (roleIds.some(rid => member.roles?.cache?.has?.(rid))) return true;
    }
  }catch{}

  // Optional extra role IDs from .env
  if (MIDDLEMAN_SUPPORT_ROLE_IDS.length) {
    if (MIDDLEMAN_SUPPORT_ROLE_IDS.some(rid => member.roles?.cache?.has?.(rid))) return true;
  }

  return false;
}


const PREFIX = "?";

function buildMercyButtonsRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("mercy_join").setLabel("✅ Join us").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("mercy_broke").setLabel("❌ Be broke").setStyle(ButtonStyle.Danger)
  );
}


function planToDays(plan){
  const p = String(plan || "").toLowerCase();
  if (p === "15d" || p === "15days" || p === "15") return { plan:"15d", days:15 };
  if (p === "1m" || p === "1month" || p === "30d" || p === "30") return { plan:"1m", days:30 };
  if (p === "3m" || p === "3month" || p === "90d" || p === "90") return { plan:"3m", days:90 };
  const n = Number(p);
  if (Number.isFinite(n) && n > 0 && n <= 3650) return { plan:"custom", days:Math.floor(n) };
  return null;
}

function parseDurationToMs(input){
  const raw = String(input || "").trim();
  if (!raw) return null;

  // Backward compat for old plans like 15d / 1m / 3m / number-of-days
  const asPlan = planToDays(raw);
  if (asPlan) {
    const ms = asPlan.days * 24 * 60 * 60 * 1000;
    return { ms, label: `${asPlan.days}d`, plan: asPlan.plan, days: asPlan.days };
  }

  // New format examples:
  //  30s, 2m, 10m30s, 1h, 2h15m, 1d, 3d12h, 1w, 2w3d, 1mo, 1y
  // Notes:
  //  - "m" = minutes
  //  - "mo" = months (30 days)
  //  - "y" = years (365 days)
  const re = /([0-9]+)\s*(mo|y|w|d|h|m|s)\b/gi;
  let match;
  let totalMs = 0;
  let used = false;

  while ((match = re.exec(raw)) !== null) {
    used = true;
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    const unit = match[2].toLowerCase();
    switch(unit){
      case "s": totalMs += n * 1000; break;
      case "m": totalMs += n * 60 * 1000; break;
      case "h": totalMs += n * 60 * 60 * 1000; break;
      case "d": totalMs += n * 24 * 60 * 60 * 1000; break;
      case "w": totalMs += n * 7 * 24 * 60 * 60 * 1000; break;
      case "mo": totalMs += n * 30 * 24 * 60 * 60 * 1000; break;
      case "y": totalMs += n * 365 * 24 * 60 * 60 * 1000; break;
      default: break;
    }
  }

  if (!used || totalMs <= 0) return null;

  // Keep a reasonable max (10 years)
  const maxMs = 10 * 365 * 24 * 60 * 60 * 1000;
  if (totalMs > maxMs) totalMs = maxMs;

  const days = Math.max(1, Math.ceil(totalMs / (24 * 60 * 60 * 1000)));
  return { ms: totalMs, label: raw.toLowerCase(), plan: "custom", days };
}

function formatExpires(expiresAt){
  if (!expiresAt) return "Unknown";
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms)) return "Unknown";
  const diff = ms - Date.now();
  const days = Math.ceil(diff / (1000*60*60*24));
  if (days <= 0) return "Expired";
  if (days === 1) return "1 day";
  return `${days} days`;
}

function ensurePremiumActiveOrExpire(guildId){
  const s = PREMIUM_GUILDS[guildId];
  if (!s || !s.isPremium) return;
  if (!s.expiresAt) return; // old lifetime keys
  const ms = Date.parse(s.expiresAt);
  if (!Number.isFinite(ms)) return;
  if (Date.now() > ms){
    PREMIUM_GUILDS[guildId] = { ...s, isPremium:false };
    writeJsonSafe(PREMIUM_FILE, PREMIUM_GUILDS);
  }
}

function getPremiumState(guildId){
  ensurePremiumActiveOrExpire(guildId);

  const raw = PREMIUM_GUILDS[guildId] || {};
  const branding = raw.branding || {};
  const features = raw.features || {};

  return {
    isPremium: !!raw.isPremium,
    plan: raw.plan || null,
    activatedAt: raw.activatedAt || null,
    expiresAt: raw.expiresAt || null,
    branding: {
      name: (typeof branding.name === "string" && branding.name.trim()) ? branding.name : "Nozzarri Tickets",
      iconUrl: (typeof branding.iconUrl === "string") ? branding.iconUrl : null,
      accent: (typeof branding.accent === "string") ? branding.accent : null
    },
    features: {
      // Ticket ping settings (Premium): per ticket type.
      // This replaces the old pingMode/pingRoleId/pingRoleIds so you don't have 2 duplicate systems.
      // Values:
      //  - roles: array of role IDs to mention
      //  - here: mention @here
      //  - everyone: mention @everyone
      ticketPings: {
        support: {
          roles: Array.isArray(features?.ticketPings?.support?.roles)
            ? features.ticketPings.support.roles.filter(isValidSnowflake)
            : [],
          here: !!features?.ticketPings?.support?.here,
          everyone: !!features?.ticketPings?.support?.everyone,
        },
        trade: {
          roles: Array.isArray(features?.ticketPings?.trade?.roles)
            ? features.ticketPings.trade.roles.filter(isValidSnowflake)
            : [],
          here: !!features?.ticketPings?.trade?.here,
          everyone: !!features?.ticketPings?.trade?.everyone,
        }
      },

      // Legacy (kept for backwards compatibility; no longer used by ticket creation)
      pingMode: (typeof features.pingMode === "string") ? features.pingMode : "here", // off | here | role
      pingRoleId: (typeof features.pingRoleId === "string") ? features.pingRoleId : null,
      pingRoleIds: Array.isArray(features.pingRoleIds) ? features.pingRoleIds.filter(isValidSnowflake) : [],
      ticketNameTemplate: (typeof features.ticketNameTemplate === "string" && features.ticketNameTemplate.trim())
        ? features.ticketNameTemplate
        : "ticket-{user}",
      welcomeMessage: (typeof features.welcomeMessage === "string") ? features.welcomeMessage : "",
      botNickname: (typeof features.botNickname === "string") ? features.botNickname : null,
      transcripts: !!features.transcripts,
      transcriptChannelId: (typeof features.transcriptChannelId === "string") ? features.transcriptChannelId : null,
      autoCloseMinutes: Number.isFinite(features.autoCloseMinutes) ? features.autoCloseMinutes : 0,
      customCloseReasons: Array.isArray(features.customCloseReasons) ? features.customCloseReasons : [],
      autoTagClaims: !!features.autoTagClaims,
      prioritySupport: !!features.prioritySupport
    }
  };
}

function savePremiumState(guildId, patch){
  const raw = PREMIUM_GUILDS[guildId] || {};
  const nextRaw = {
    ...raw,
    ...patch,
    branding: { ...(raw.branding || {}), ...((patch && patch.branding) || {}) },
    features: { ...(raw.features || {}), ...((patch && patch.features) || {}) }
  };
  if (typeof nextRaw.isPremium !== "boolean") nextRaw.isPremium = !!raw.isPremium;
  PREMIUM_GUILDS[guildId] = nextRaw;
  writeJsonSafe(PREMIUM_FILE, PREMIUM_GUILDS);
  return getPremiumState(guildId);
}

function makeLicenseKey(){
  // Example: DS-XXXX-XXXX-XXXX
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const chunk = () => Array.from({length:4}, ()=>alphabet[Math.floor(Math.random()*alphabet.length)]).join("");
  return `DS-${chunk()}-${chunk()}-${chunk()}`;
}

function isValidHexColor(str){
  return typeof str === "string" && /^#?[0-9A-Fa-f]{6}$/.test(str.trim());
}

function normalizeHexColor(str){
  const s = str.trim();
  return s.startsWith("#") ? s : `#${s}`;
}

function looksLikeUrl(str){
  try {
    const u = new URL(str);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

// Apply branding to embeds (premium only)
function applyBranding(embed, guildId){
  try{
    const p = getPremiumState(guildId);
    if (!p.isPremium) return embed;

    const accent = p.branding.accent && isValidHexColor(p.branding.accent) ? normalizeHexColor(p.branding.accent) : null;
    if (accent) embed.setColor(accent);

    if (p.branding.iconUrl && looksLikeUrl(p.branding.iconUrl)){
      embed.setThumbnail(p.branding.iconUrl);
    }
    return embed;
  }catch{
    return embed;
  }
}

// Premium helpers
function requirePremium(message){
  if (!message.guild) return { ok:false, reason:"NO_GUILD" };
  const p = getPremiumState(message.guild.id);
  if (!p.isPremium) return { ok:false, reason:"NOT_PREMIUM", p };
  return { ok:true, p };
}

function uniq(arr){
  return Array.from(new Set(arr.filter(Boolean)));
}

function renderTicketPingMention(guildId, ticketType){
  // ticketType: "support" | "trade"
  const p = getPremiumState(guildId);
  if (!p.isPremium) return "@here";

  const t = (String(ticketType || "").toLowerCase() === "trade") ? "trade" : "support";
  const cfg = p.features.ticketPings?.[t] || { roles:[], here:false, everyone:false };

  const parts = [];
  if (cfg.everyone) parts.push("@everyone");
  if (cfg.here) parts.push("@here");
  if (Array.isArray(cfg.roles)) parts.push(...cfg.roles.map(id => `<@&${id}>`));

  // If user set nothing, default to @here
  const out = uniq(parts).join(" ");
  return out || "@here";
}

async function sendTranscriptIfEnabled(channel, closedByTag, reason){
  try{
    if (!channel?.guild) return;
    const p = getPremiumState(channel.guild.id);
    if (!p.isPremium || !p.features.transcripts) return;

    const cfg = getGuildConfig(channel.guild.id);
    const destId = p.features.transcriptChannelId || cfg.logChannelId;
    if (!destId) return;

    let dest = channel.guild.channels.cache.get(destId);
    if (!dest) dest = await channel.guild.channels.fetch(destId).catch(() => null);
    if (!dest || dest.type !== ChannelType.GuildText) return;

    const msgs = await channel.messages.fetch({ limit: 100 }).catch(() => null);
    const lines = [];
    lines.push(`Transcript for #${channel.name} (${channel.id})`);
    lines.push(`Closed by: ${closedByTag}${reason ? " | Reason: " + reason : ""}`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("----");
    if (msgs) {
      const arr = Array.from(msgs.values()).reverse();
      for (const m of arr) {
        const ts = new Date(m.createdTimestamp).toISOString();
        const author = m.author ? `${m.author.tag}` : "Unknown";
        const content = (m.content || "").replace(/\n/g, " ");
        lines.push(`[${ts}] ${author}: ${content}`);
      }
    } else {
      lines.push("(Could not fetch messages)");
    }

    const buf = Buffer.from(lines.join("\n"), "utf8");
    const filename = `transcript-${channel.id}.txt`;

    const embed = new EmbedBuilder()
      .setTitle("📄 Ticket Transcript")
      .setDescription(`Channel: <#${channel.id}>\nClosed by: **${closedByTag}**${reason ? `\nReason: **${reason}**` : ""}`)
      .setTimestamp();

    applyBranding(embed, channel.guild.id);

    await dest.send({ embeds: [embed], files: [{ attachment: buf, name: filename }] }).catch(() => {});
  }catch(e){
    console.error("sendTranscriptIfEnabled error:", e);
  }
}

function formatTemplate(template, vars){
  return String(template || "")
    .replace(/\{user\}/g, vars.user || "user")
    .replace(/\{type\}/g, vars.type || "ticket")
    .replace(/\{id\}/g, vars.id || "");
}

function sanitizeChannelName(name){
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 90) || "ticket";
}

function normalizeMinutes(n){
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  return Math.min(1440, Math.floor(x)); // max 24h
}

function isRoleInGuild(guild, roleId){
  return !!guild.roles.cache.get(roleId);
}

function looksLikeTextChannelId(id){
  return typeof id === "string" && /^\d{15,22}$/.test(id);
}

function getPremiumFeaturesText(guildId){
  const p = getPremiumState(guildId);
  const f = p.features;
  const lines = [];
  lines.push(`Premium: **${p.isPremium ? "ON ✅" : "OFF ❌"}**`);
  if (!p.isPremium) return lines.join("\n");
  lines.push(`Brand name: **${p.branding.name}**`);
  lines.push(`Ping mode: **${f.pingMode}**${f.pingMode==="role" && f.pingRoleId ? ` (<@&${f.pingRoleId}>)` : ""}`);
  lines.push(`Auto-close: **${f.autoCloseMinutes ? f.autoCloseMinutes + " min" : "OFF"}**`);
  lines.push(`Transcripts: **${f.transcripts ? "ON" : "OFF"}**${f.transcriptChannelId ? ` → <#${f.transcriptChannelId}>` : ""}`);
  lines.push(`Welcome msg: **${f.welcomeMessage ? "set" : "not set"}**`);
  lines.push(`Ticket name template: \`${f.ticketNameTemplate}\``);
  return lines.join("\n");
}

function normalizeArray(arr) {
  return Array.isArray(arr) ? arr.filter(isValidSnowflake) : [];
}

function getDefaultConfig() {
  return {
    // Core routing
    supportCategoryId: null,
    mmCategoryId: null,
    logChannelId: null,

    // Feature toggles (so the bot won't auto-create / auto-use what you don't want)
    supportEnabled: false,
    tradeEnabled: false,
    logsEnabled: false,

    // Role access
    supportRoles: [],
    mmRoles: [],
    adminRoles: [],

    // Panel text (premium-only editing; still stored here per guild)
    panelText: {
      supportDescription: null,
      tradeDescription: null
    }
  };
}

function getGuildConfig(guildId) {
  const def = getDefaultConfig();
  const saved = GUILD_CONFIGS[guildId] || {};

  // If an older config already has category/channel IDs, keep the feature effectively enabled
  // unless the owner explicitly disabled it later.
  const inferredSupportEnabled =
    saved.supportEnabled !== undefined ? !!saved.supportEnabled : !!saved.supportCategoryId;
  const inferredTradeEnabled =
    saved.tradeEnabled !== undefined ? !!saved.tradeEnabled : !!saved.mmCategoryId;
  const inferredLogsEnabled =
    saved.logsEnabled !== undefined ? !!saved.logsEnabled : !!saved.logChannelId;

  return {
    ...def,
    ...saved,
    supportEnabled: inferredSupportEnabled,
    tradeEnabled: inferredTradeEnabled,
    logsEnabled: inferredLogsEnabled,
    panelText: { ...def.panelText, ...(saved.panelText || {}) },
    supportRoles: normalizeArray(saved.supportRoles ?? def.supportRoles),
    mmRoles: normalizeArray(saved.mmRoles ?? def.mmRoles),
    adminRoles: normalizeArray(saved.adminRoles ?? def.adminRoles)
  };
}


async function ensureDefaultSetup(guild, needs = { support: false, trade: false, logs: false }) {
  // IMPORTANT:
  // The user asked to NOT auto-create channels/categories unless they explicitly set them in ?setup.
  // So here we only VALIDATE that the required setup exists.

  const cfg = getGuildConfig(guild.id);

  async function validateCategory(id, label) {
    if (!id) return { ok: false, reason: `MISSING_${label}_CATEGORY_ID` };
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildCategory) return { ok: false, reason: `INVALID_${label}_CATEGORY_ID` };
    return { ok: true, id: ch.id };
  }

  async function validateTextChannel(id, label) {
    if (!id) return { ok: false, reason: `MISSING_${label}_CHANNEL_ID` };
    const ch = await guild.channels.fetch(id).catch(() => null);
    if (!ch || ch.type !== ChannelType.GuildText) return { ok: false, reason: `INVALID_${label}_CHANNEL_ID` };
    return { ok: true, id: ch.id };
  }

  if (needs.support) {
    if (!cfg.supportEnabled) return { ok: false, reason: "SUPPORT_DISABLED" };
    const v = await validateCategory(cfg.supportCategoryId, "SUPPORT");
    if (!v.ok) return { ok: false, reason: v.reason };
  }

  if (needs.trade) {
    if (!cfg.tradeEnabled) return { ok: false, reason: "TRADE_DISABLED" };
    const v = await validateCategory(cfg.mmCategoryId, "TRADE");
    if (!v.ok) return { ok: false, reason: v.reason };
  }

  if (needs.logs) {
    if (!cfg.logsEnabled) return { ok: true, cfg }; // logs are optional; disabled means "skip"
    const v = await validateTextChannel(cfg.logChannelId, "LOG");
    if (!v.ok) return { ok: false, reason: v.reason };
  }

  return { ok: true, cfg };
}





function isOwnerOrAdmin(message) {
  try {
    if (!message.guild) return false;
  // ✅ Bot owner can use owner/admin commands too
  if (isBotOwner(message.author.id)) return true;
    const cfg = getGuildConfig(message.guild.id);
    const ownerId = message.guild.ownerId;
    if (message.author.id === ownerId) return true;
    const adminRoles = Array.isArray(cfg.adminRoles) ? cfg.adminRoles : [];
    const member = message.member;
    if (!member || !member.roles) return false;
    return adminRoles.some(rid => member.roles.cache.has(rid));
  } catch {
    return false;
  }
}



// Debounced config save: prevents spam writes (reduces Interaction timeouts)
let _cfgSaveTimer = null;
let _cfgDirty = false;

function scheduleConfigSave() {
  _cfgDirty = true;
  if (_cfgSaveTimer) clearTimeout(_cfgSaveTimer);
  _cfgSaveTimer = setTimeout(() => {
    _cfgSaveTimer = null;
    if (!_cfgDirty) return;
    _cfgDirty = false;
    if (DISK_FULL) return; // keep in memory until disk has space
    // Async write so ENOSPC / slow disks don't freeze the bot and cause interaction timeouts
    writeJsonSafeAsync(GUILD_CFG_FILE, GUILD_CONFIGS).catch(() => {});
  }, 250);
}

function saveGuildConfig(guildId, patch) {
  const current = getGuildConfig(guildId);
  const next = {
    ...current,
    ...patch
  };

  // keep arrays clean
  if ("supportRoles" in patch) next.supportRoles = normalizeArray(patch.supportRoles);
  if ("mmRoles" in patch) next.mmRoles = normalizeArray(patch.mmRoles);
  if ("adminRoles" in patch) next.adminRoles = normalizeArray(patch.adminRoles);

  GUILD_CONFIGS[guildId] = next;
  scheduleConfigSave();
return next;
}

// ----------------------
// Slash Commands
// ----------------------
const commands = [
  new SlashCommandBuilder()
    .setName("add")
    .setDescription("Add a user to the current ticket")
    .addUserOption(opt =>
      opt
        .setName("user")
        .setDescription("User to add")
        .setRequired(true)
    ),
  ...(ENABLE_LEADERBOARD ? [
  new SlashCommandBuilder()
    .setName("toptrade")
    .setDescription("Show top trade staff by rating")
] : []),
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Open the private help panel"),
  new SlashCommandBuilder()
    .setName("close")
    .setDescription("Close the current ticket (staff only)")
    .addStringOption(opt =>
      opt
        .setName("reason")
        .setDescription("Reason for closing (optional)")
        .setRequired(false)
    ),
  // Ticket claiming

  new SlashCommandBuilder()
    .setName("claim")
    .setDescription("Claim the current ticket (Support/MM staff only)"),
  new SlashCommandBuilder()
    .setName("unclaim")
    .setDescription("Unclaim the current ticket (Support/MM staff only)"),

].map(cmd => cmd.toJSON());

// ----------------------
// Startup / command registration
// ----------------------
let CMDS_REGISTERED = false;

async function registerAllCommands() {
  if (CMDS_REGISTERED) return;
  CMDS_REGISTERED = true;

  const rest = new REST({ version: "10" }).setToken(token);

  // ✅ Public bot: register GLOBAL commands (works in every server)
  // Global commands can take up to ~1 hour to fully propagate.
  await rest.put(Routes.applicationCommands(clientId), { body: commands });

  console.log(`[${BUILD_TAG}] ${client.user.tag} is online!`);
}

// Discord.js v15 renamed "ready" to "clientReady".
// We listen to BOTH so it works on v14/v15 without crashing.
client.once("clientReady", () => registerAllCommands().catch(console.error));
client.once("ready", () => {
  registerAllCommands().catch(console.error);
  applyAllSavedNicknames().catch(()=>{});
  // Start dashboard AFTER the bot is ready
  startDashboardServer();
});


// ----------------------
// Helpers
// ----------------------
async function applyBotNickname(guild){
  try{
    if (!guild) return;
    const p = getPremiumState(guild.id);
    const me = guild.members.me || (await guild.members.fetchMe().catch(()=>null));
    if (!me) return;

    // Only apply nickname if explicitly set OR if premium branding name differs from current nickname
    const desired = p.features.botNickname || null;
    if (desired === null){
      return; // do not change nickname unless configured
    }
    const clean = desired.trim();
    if (!clean) return;
    if (me.nickname === clean) return;
    await me.setNickname(clean).catch(()=>{});
  }catch{}
}

async function applyAllSavedNicknames(){
  try{
    for (const [, guild] of client.guilds.cache){
      await applyBotNickname(guild);
    }
  }catch{}
}


function makeTopic(openerId, claimerId = null) {
  return `opened:${openerId};claimed:${claimerId ?? "null"}`;
}
function parseTopic(topic) {
  const def = { opened: null, claimed: null };
  if (!topic) return def;
  const parts = topic.split(";").map(p => p.split(":"));
  for (const [k, v] of parts) {
    if (k === "opened") def.opened = v || null;
    if (k === "claimed") def.claimed = v && v !== "null" ? v : null;
  }
  return def;
}

// role helpers
function isAdmin(member) {
  const cfg = getGuildConfig(member.guild.id);
  const list = Array.isArray(cfg.adminRoles) ? cfg.adminRoles : [];
  return member.roles.cache.some(r => list.includes(r.id));
}
function isSupport(member) {
  const cfg = getGuildConfig(member.guild.id);
  const list = Array.isArray(cfg.supportRoles) ? cfg.supportRoles : [];
  return member.roles.cache.some(r => list.includes(r.id));
}
function isTradeStaff(member) {
  const cfg = getGuildConfig(member.guild.id);
  const list = Array.isArray(cfg.mmRoles) ? cfg.mmRoles : [];
  return member.roles.cache.some(r => list.includes(r.id));
}

// who can manage (claim/close) a given ticket channel
function canManageTicket(member, channel) {
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  if (isAdmin(member)) return true;

  const cfg = getGuildConfig(channel.guild.id);
  const parentId = channel.parentId;

  // Support category: only support team (admins already handled)
  if (parentId === cfg.supportCategoryId) {
    return isSupport(member);
  }

  // Trade category: support + trade roles (admins already handled)
  if (parentId === cfg.mmCategoryId) {
    return isSupport(member) || isTradeStaff(member);
  }

  return false;
}


function canUseSetup(member){
    // ✅ Bot owner can use setup in any server
  if (isBotOwner(member.id)) return true;

if (!member || !member.guild) return false;
  if (member.guild.ownerId === member.id) return true;
  return isAdmin(member);
}

function isTicketChannel(channel){
  if (!channel || channel.type !== ChannelType.GuildText) return false;
  const cfg = getGuildConfig(channel.guild.id);
  if (cfg.supportCategoryId && channel.parentId === cfg.supportCategoryId) return true;
  if (cfg.mmCategoryId && channel.parentId === cfg.mmCategoryId) return true;
  const t = parseTopic(channel.topic);
  if (t && t.opened) return true;
  const name = (channel.name || "").toLowerCase();
  return name.startsWith("ticket-") || name.startsWith("support-") || name.startsWith("trade-") || name.startsWith("mm-");
}

// central close logic (used by button + /close)
async function closeTicket(channel, closedByMember, reason = null) {
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const { opened, claimed } = parseTopic(channel.topic);

  // DM summary + rating buttons (disabled)
  if (!DISABLE_CLOSE_DMS) {
    await dmSummaryAndRating(opened, claimed, closedByMember.user.tag, reason).catch(() => {});
  }

  const logEmbed = new EmbedBuilder()
    .setTitle(reason ? "🗑️ Ticket Closed (With Reason)" : "🗑️ Ticket Closed")
    .setColor("#e74c3c")
    .addFields(
      { name: "Channel", value: `${channel.name} (${channel.id})`, inline: true },
      { name: "Closed by", value: `${closedByMember.user.tag} (${closedByMember.user.id})`, inline: true },
      { name: "Claimed by", value: claimed ? `${claimed}` : "Not claimed", inline: true },
      ...(reason ? [{ name: "Reason", value: reason }] : [])
    )
    .setTimestamp();

  await sendLog(channel.guild, logEmbed);

  // Premium: optional transcript
  await sendTranscriptIfEnabled(channel, closedByMember.user.tag, reason).catch(() => {});

  await channel.send(reason ? `✅ Ticket closed: **${reason}**` : "✅ Ticket will be closed.").catch(() => {});
  setTimeout(() => channel.delete().catch(() => {}), 2000);
}

// send to log channel if configured (no DM)
async function sendLog(guild, embed) {
  try {
        const cfg = getGuildConfig(guild.id);
    if (!cfg.logChannelId) return;
    let logCh = guild.channels.cache.get(cfg.logChannelId);
    if (!logCh) logCh = await guild.channels.fetch(cfg.logChannelId).catch(() => null);
    if (!logCh) return;
    await logCh.send({ embeds: [embed] }).catch(() => {});
  } catch (e) {
    console.error("sendLog error:", e);
  }
}

// Rating storage helper
function addReviewForStaff(staffId, score) {
  if (!REVIEWS.trade[staffId]) REVIEWS.trade[staffId] = { reviews: [], avg: 0, count: 0 };
  REVIEWS.trade[staffId].reviews.push(score);
  REVIEWS.trade[staffId].count = REVIEWS.trade[staffId].reviews.length;
  const sum = REVIEWS.trade[staffId].reviews.reduce((a, b) => a + b, 0);
  REVIEWS.trade[staffId].avg = +(sum / REVIEWS.trade[staffId].count).toFixed(2);
  writeJsonSafe(REVIEWS_FILE, REVIEWS);
}
function addReviewForService(score) {
  const key = "global";
  if (!REVIEWS.service[key]) REVIEWS.service[key] = { reviews: [], avg: 0, count: 0 };
  REVIEWS.service[key].reviews.push(score);
  REVIEWS.service[key].count = REVIEWS.service[key].reviews.length;
  const sum = REVIEWS.service[key].reviews.reduce((a, b) => a + b, 0);
  REVIEWS.service[key].avg = +(sum / REVIEWS.service[key].count).toFixed(2);
  writeJsonSafe(REVIEWS_FILE, REVIEWS);
}

// Build select menus
function makeTicketMenuCustomId() {
  return `ticket_type:${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function buildSupportMenu() {
  const customId = makeTicketMenuCustomId();
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("🛠️ Open a support ticket...")
      .addOptions([
        {
          label: "🛠️ Support",
          value: "support",
          description: "Get help from our staff"
        }
      ])
  );
}

function buildTradeMenu() {
  const customId = makeTicketMenuCustomId();
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(customId)
      .setPlaceholder("🤝 Request trade help...")
      .addOptions([
        {
          label: "🤝 Trade Help",
          value: "trade",
          description: "Request trade assistance for safe trading"
        }
      ])
  );
}


// ----------------------
// Default panel descriptions (used unless premium overrides are set)
// ----------------------
const DEFAULT_SUPPORT_PANEL_DESC = `
🛠️ **Support Ticket**

Welcome to **Nozzarri Tickets Support**.

Please describe your problem clearly so staff can help quickly.

✅ Use this for:
• Server or role issues
• Questions & help
• Bug reports / technical problems
• Staff assistance

❌ Not for:
• Trade requests
• Random chatting
• Spam / trolling

⏱️ Average response: **5–15 minutes**
Please be patient and do not spam.
`;

const DEFAULT_TRADE_PANEL_DESC = `
🤝 **Nozzarri Tickets — Trade Panel**

This is only for **secure, verified trade requests**.

✅ Allowed:
• Paid services / commissions
• Digital assets, scripts, accounts
• Product or currency exchanges
• Deals between two parties

❌ Not allowed:
• Free trades / giveaways
• Random conversations
• No proof / unclear ownership
• Already disputed deals

📝 Required info:
• Both parties’ Discord usernames
• What is being traded
• Agreed terms / amount
• Proof (screenshots) if possible

⏱️ Average response: **5–20 minutes**
Do not spam or ping staff.
`;

function getPanelDescription(guildId, which) {
  const cfg = getGuildConfig(guildId);
  const prem = getPremiumState(guildId);
  if (prem?.isPremium && cfg.panelText) {
    if (which === "support" && cfg.panelText.supportDescription) return String(cfg.panelText.supportDescription);
    if (which === "trade" && cfg.panelText.tradeDescription) return String(cfg.panelText.tradeDescription);
  }
  return which === "support" ? DEFAULT_SUPPORT_PANEL_DESC : DEFAULT_TRADE_PANEL_DESC;
}

// ----------------------
// Message triggers (?support, ?trade)
// ----------------------
// ----------------------
// Setup Panel Helpers
// ----------------------
function buildSetupEmbed(guild, cfg) {
  const prem = getPremiumState(guild.id);

  const supportStatus = cfg.supportEnabled ? "✅ Enabled" : "❌ Disabled";
  const tradeStatus = cfg.tradeEnabled ? "✅ Enabled" : "❌ Disabled";
  const logsStatus = cfg.logsEnabled ? "✅ Enabled" : "❌ Disabled";

  return new EmbedBuilder()
    .setTitle("⚙️ Ticket Bot — Server Setup")
    .setColor("#3498db")
    .setDescription(
      "This setup is **per-server** and saves automatically.\n" +
      "First **enable** what you want (Support / Trade / Logs), then set where it should go.\n\n" +
      (prem?.isPremium
        ? "⭐ **Premium unlocked** — you can edit panel descriptions from **Premium Settings**."
        : "🔒 **Premium locked** — redeem a key with `?premium-redeem <key>` to unlock panel text editing.")
    )
    .addFields(
      {
        name: `Support (${supportStatus})`,
        value:
          cfg.supportEnabled
            ? (cfg.supportCategoryId ? `<#${cfg.supportCategoryId}>` : "**Not set** (pick a category)")
            : "Disabled (no support tickets will be created)",
        inline: true
      },
      {
        name: `Trade (${tradeStatus})`,
        value:
          cfg.tradeEnabled
            ? (cfg.mmCategoryId ? `<#${cfg.mmCategoryId}>` : "**Not set** (pick a category)")
            : "Disabled (no trade tickets will be created)",
        inline: true
      },
      {
        name: `Logs (${logsStatus})`,
        value:
          cfg.logsEnabled
            ? (cfg.logChannelId ? `<#${cfg.logChannelId}>` : "**Not set** (pick a channel)")
            : "Disabled (no logs will be sent)",
        inline: true
      },
      {
        name: "Support Roles",
        value: cfg.supportEnabled
          ? (cfg.supportRoles?.length ? cfg.supportRoles.map(r => `<@&${r}>`).join(" ") : "**Not set**")
          : "—",
        inline: false
      },
      {
        name: "Trade Roles",
        value: cfg.tradeEnabled
          ? (cfg.mmRoles?.length ? cfg.mmRoles.map(r => `<@&${r}>`).join(" ") : "**Not set**")
          : "—",
        inline: false
      },
      {
        name: "Admin Roles",
        value: cfg.adminRoles?.length ? cfg.adminRoles.map(r => `<@&${r}>`).join(" ") : "**Not set**",
        inline: false
      }
    )
    .setFooter({ text: "Admins/Owner • Run ?setup anytime" });
}



function buildSetupMainComponents(ownerId) {
  const row0 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_toggle_support:${ownerId}`).setLabel("Toggle Support").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup_toggle_trade:${ownerId}`).setLabel("Toggle Trade").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup_toggle_logs:${ownerId}`).setLabel("Toggle Logs").setStyle(ButtonStyle.Secondary)
  );

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_set_support:${ownerId}`).setLabel("Set Support Category").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`setup_set_mm:${ownerId}`).setLabel("Set Trade Category").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`setup_set_log:${ownerId}`).setLabel("Set Log Channel").setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_set_roles:${ownerId}`).setLabel("Set Roles").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup_premium_settings:${ownerId}`).setLabel("Premium Settings").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup_done:${ownerId}`).setLabel("Done").setStyle(ButtonStyle.Success)
  );

  return [row0, row1, row2];
}



function buildSetupMainPayload(guild, ownerId) {
  const cfg = getGuildConfig(guild.id);
  const embed = buildSetupEmbed(guild, cfg);
  const components = buildSetupMainComponents(ownerId);
  return { embeds: [embed], components };
}

function buildPremiumSetupPayload(guild, ownerId) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_edit_support_desc:${ownerId}`).setLabel("Edit Support Description").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`setup_edit_trade_desc:${ownerId}`).setLabel("Edit Trade Description").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`setup_reset_panel_text:${ownerId}`).setLabel("Reset Text").setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`setup_back:${ownerId}`).setLabel("Back").setStyle(ButtonStyle.Secondary)
  );

  const embed = new EmbedBuilder()
    .setTitle("⭐ Premium Setup")
    .setColor("#f1c40f")
    .setDescription(
      "Customize your **Support** / **Trade** panel descriptions.\n" +
      "These descriptions are used for the `?support` and `?trade` panels."
    );

  return { embeds: [embed], components: [row] };
}


function buildPremiumPanelPayload(guild, openerId){
  const prem = getPremiumState(guild.id);
  const f = prem.features;
  const b = prem.branding;

  const embed = new EmbedBuilder()
    .setTitle("💎 Premium Control Panel")
    .setColor(b.accent || "#f1c40f")
    .setDescription(
      prem.isPremium
        ? "Manage premium features with **one click**.\nOnly **you** can use the buttons in this panel."
        : "🔒 Premium is **not active** for this server.\nRedeem a key with `?premium-redeem <key>` (server owner can redeem).\n\nYou can still preview the settings below."
    )
    .addFields(
      { name: "Status", value: prem.isPremium ? "✅ Active" : "❌ Inactive", inline: true },
      { name: "Brand", value: `**${b.name}**`, inline: true },
      { name: "Ticket Name", value: `\`${f.ticketNameTemplate || "ticket-{user}"}\``, inline: false },
      { name: "Pings", value: `Mode: **${f.pingMode || "here"}**` + (f.pingRoleId ? ` • Role: <@&${f.pingRoleId}>` : ""), inline: false },
      { name: "Transcripts", value: (f.transcripts ? "✅ On" : "❌ Off") + (f.transcriptChannelId ? ` • <#${f.transcriptChannelId}>` : ""), inline: false },
      { name: "Welcome Msg", value: f.welcomeMessage && f.welcomeMessage.trim() ? "✅ Set" : "—", inline: true },
      { name: "Auto Close", value: f.autoCloseMinutes ? `✅ ${f.autoCloseMinutes} min` : "❌ Off", inline: true }
    )
    .setFooter({ text: "Premium • Private panel • Buttons are locked to you" });

  applyBranding(embed, guild.id);

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prem_brand:${openerId}`).setLabel("🎨 Branding").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`prem_ticketname:${openerId}`).setLabel("🧩 Ticket Name").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`prem_pings:${openerId}`).setLabel("📣 Pings").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`prem_transcripts:${openerId}`).setLabel("📄 Transcripts").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`prem_welcome:${openerId}`).setLabel("👋 Welcome").setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prem_botnick:${openerId}`).setLabel("🤖 Bot Nick").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`prem_autoclose:${openerId}`).setLabel("⏱ Auto Close").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`prem_cmds:${openerId}`).setLabel("✨ Commands").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`prem_refresh:${openerId}`).setLabel("🔄 Refresh").setStyle(ButtonStyle.Success),
  );

  row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prem_close:${openerId}`).setLabel("❌ Close").setStyle(ButtonStyle.Danger),
  );

  return { embeds:[embed], components:[row1,row2,row3] };
}

function buildPremiumCommandsPayload(guild, openerId){
  const prem = getPremiumState(guild.id);
  const f = prem.features;

  const embed = new EmbedBuilder()
    .setTitle("✨ Premium Commands")
    .setColor(prem.branding.accent || "#f1c40f")
    .setDescription("Configure premium features with buttons. Only **you** can use these controls.")
    .addFields(
      { name: "Auto Tag Claims", value: f.autoTagClaims ? "✅ On" : "❌ Off", inline: true },
      { name: "Priority Support", value: f.prioritySupport ? "✅ On" : "❌ Off", inline: true },
      { name: "Close Reasons", value: (Array.isArray(f.customCloseReasons) && f.customCloseReasons.length)
          ? f.customCloseReasons.map((r,i)=>`**${i+1}.** ${String(r).slice(0,80)}`).join("\n")
          : "—", inline: false },
    )
    .setFooter({ text: "Premium • Locked to you" });

  applyBranding(embed, guild.id);

  const rowA = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`premcmd_toggle_claim:${openerId}`).setLabel(f.autoTagClaims ? "🏷️ Claim Tag: ON" : "🏷️ Claim Tag: OFF").setStyle(f.autoTagClaims ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`premcmd_toggle_priority:${openerId}`).setLabel(f.prioritySupport ? "🚀 Priority: ON" : "🚀 Priority: OFF").setStyle(f.prioritySupport ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  
  const rowB = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`prem_back:${openerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
  );

const rowC = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`premcmd_reason_add:${openerId}`).setLabel("➕ Add Close Reason").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`premcmd_reason_remove:${openerId}`).setLabel("➖ Remove Reason").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`premcmd_refresh:${openerId}`).setLabel("🔄 Refresh").setStyle(ButtonStyle.Success)
  );

  return { embeds:[embed], components:[rowA,rowB,rowC] };
}




function buildSetupBackRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_back:${ownerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
  );
}

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const content = message.content.trim();

// ===========================
// Middleman custom commands
// ===========================
if (content.startsWith(PREFIX)) {
  const parts = content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (parts.shift() || "").toLowerCase();

  const isOurCmd = (cmd === "mercy" || cmd === "mminfo" || cmd === "mmfee" || cmd === "mmfees");
  if (isOurCmd) {
    if (!message.guild || !message.member) return;
    if (!isNozzarriGuild(message.guild)) {
      return message.reply("⛔ This command can only be used in **Nozzarri Tickets**.").catch(() => {});
    }
    if (!isTicketChannel(message.channel)) {
      return message.reply("⛔ Use this command **only inside a ticket channel**.").catch(() => {});
    }
    if (!isMMCommandAllowed(message.member)) {
      return message.reply("⛔ You can’t use this command. Only **server owner**, **bot owner**, **admins**, or **middleman supporters**.").catch(() => {});
    }

    if (cmd === "mercy") {
  const embed = new EmbedBuilder()
    .setTitle("🆘 Scam Support — What to do next")
    .setDescription(
      "**If you got scammed, do this right now (in order):**\n" +
      "1) **STOP trading** with them immediately (don’t send more items / money).\n" +
      "2) **Collect proof**: screenshots, video, trade logs, usernames/IDs, timestamps.\n" +
      "3) **Keep everything inside this ticket** (no DMs, no side chats).\n\n" +
      "**Then choose one button below:**\n" +
      "✅ **Join us** → you get the server role so you can request a Middleman faster and access support.\n" +
      "❌ **Be broke** → we’ll post publicly that you clicked it (just for fun).\n\n" +
      "**Important:** A Middleman can’t always recover losses, but we can help you report correctly and avoid repeat scams."
    )
    .setFooter({ text: "Nozzarri Tickets" });

  return message.channel.send({
    embeds: [embed],
    components: [buildMercyButtonsRow()]
  }).catch(() => {});
    }
    if (cmd === "mminfo") {
  const embed = new EmbedBuilder()
    .setTitle("🧾 How Middleman Works — Exact Process")
    .setDescription(
      "**This is the exact MM flow inside THIS ticket:**\n\n" +
      "**1) Deal recap (required)**\n" +
      "• Both sides write **exactly** what they give + what they receive.\n" +
      "• Both sides confirm: **“I confirm”** (no edits after).\n\n" +
      "**2) Verification**\n" +
      "• MM checks identities + roles **in-server** (no “fake staff” from DMs).\n" +
      "• MM confirms trade method + any proofs needed.\n\n" +
      "**3) Collection**\n" +
      "• MM tells **who sends first** and where to send.\n" +
      "• The sender transfers the item/currency to the MM.\n" +
      "• MM confirms receipt **publicly in this ticket**.\n\n" +
      "**4) Second side sends**\n" +
      "• The other side sends their part to the MM (same rule: ticket proof + confirmation).\n\n" +
      "**5) Release**\n" +
      "• MM releases items to each side **only after both parts are secured**.\n\n" +
      "**6) Final confirmation**\n" +
      "• Both sides confirm received. Ticket can be closed.\n\n" +
      "**No shortcuts:** If someone insists on DMs, rushing, or “trust me”, the MM stops the trade."
    )
    .setFooter({ text: "Nozzarri Tickets" });

  return message.channel.send({ embeds: [embed] }).catch(() => {});
}

    if (cmd === "mmfee" || cmd === "mmfees") {
  const embed = new EmbedBuilder()
    .setTitle("💳 MM Fee — What You Need To Provide")
    .setDescription(
      "**To get the exact MM fee, reply with:**\n" +
      "• **Trade value** (number + currency, e.g. $50 / 10k Robux / 2 items worth X)\n" +
      "• **What game/platform** (Roblox / Crypto / Giftcards / etc.)\n" +
      "• **How many transfers/steps** (1 swap, multiple items, split payments)\n" +
      "• Any **special risk** (new accounts, chargeback risk, off-platform payments)\n\n" +
      "**How the fee is decided (simple):**\n" +
      "• Higher value = higher responsibility\n" +
      "• More steps = more time\n" +
      "• Higher risk = higher fee\n\n" +
      "**When it’s paid:**\n" +
      "• The MM tells the fee **before** starting.\n" +
      "• Fee is usually paid **before release** (or as staff instructs in-ticket).\n\n" +
      "Send the details above and staff will answer with the **exact fee** for this ticket."
    )
    .setFooter({ text: "Nozzarri Tickets" });

  return message.channel.send({ embeds: [embed] }).catch(() => {});
}


    }
}


  // Owner help (prefix) — shows ALL commands (including secret ones)
  // Everyone else should use /help (public).
  if (content === "?help") {
    return; // command disabled
  }


  // Owner-only setup for this server (prefix)
  // This lets the bot work in ANY server without editing any files every time.
  if (content === "?setup") {
    if (!message.guild) return;
    if (!canUseSetup(message.member)) {
      return message.reply("⛔ You need an **Admin Role** (set in Setup) or be the **Server Owner** to use `?setup`.").catch(() => {});
    }
    const openerId = message.author.id;
    const payload = buildSetupMainPayload(message.guild, openerId);
    return message.reply(payload).catch(() => {});
  }



  // Premium setup shortcut (owner-only)
  if (content === "?psetup" || content === "?premium-setup" || content === "?setup-premium") {
    if (!message.guild) return;
    const ownerId = message.guild.ownerId;
    if (message.author.id !== ownerId) {
      return message.reply("⛔ Only the **server owner** can use premium setup.").catch(() => {});
    }

    const prem = getPremiumState(message.guild.id);
    if (!prem?.isPremium) {
      return message.reply("🔒 Premium is not unlocked for this server. Use `?premium-redeem <key>` first.").catch(() => {});
    }

    const payload = buildPremiumSetupPayload(message.guild, ownerId);
    return message.reply(payload).catch(() => {});
  }



// ----------------------
// Premium commands (prefix)
// ----------------------
// ?premium -> show status
if (content === "?premium") {
  if (!message.guild) return;

  if (!canUseSetup(message.member)) {
    return message.reply("⛔ You need an **Admin Role** (set in Setup) or be the **Server Owner** to use `?premium`.").catch(() => {});
  }

  const openerId = message.author.id;
  return message.reply(buildPremiumPanelPayload(message.guild, openerId)).catch(() => {});
}

// ?premium-help (server owner) -> shows premium-only commands (only when Premium is active)
if (content === "?premium-help") {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can use `?premium-help`.").catch(() => {});
  }

  const p = getPremiumState(message.guild.id);
  if (!p.isPremium) {
    const embed = new EmbedBuilder()
      .setTitle("💎 Premium Required")
      .setColor("#e74c3c")
      .setDescription([
        "Premium is **NOT active** for this server.",
        "",
        "✅ To unlock premium commands:",
        "• Redeem a key: `?premium-redeem <key>`",
        "• Check status: `?premium`",
        "",
        "After Premium is active, run `?premium-help` again to see all premium commands."
      ].join("\n"))
      .setFooter({ text: "Nozzarri Tickets • Premium" });

    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  const embed = new EmbedBuilder()
    .setTitle("💎 Premium — Commands")
    .setColor(p.branding.accent || "#5865F2")
    .setDescription([
      `✅ Premium is **ACTIVE** — Expires: **${formatExpires(p.expiresAt)}**`,
      "",
      "### 1) Branding (Premium)",
      "• `?premium-name <name>` — panel/bot display name for this server",
      "• `?premium-icon <imageUrl>` — icon URL (PNG/JPG)",
      "• `?premium-accent <hex>` — embed accent (example: `#5865F2`)",
      "",
      "### 2) Ticket Pings (Premium)",
      "• `?pingmode here|role|off` — mention style for ticket pings",
      "• `?setpingrole <@role>` — role used when pingmode=role",
      "",
      "### 3) Automation (Premium)",
      "• `?autoclose <minutes>` — auto-close inactive tickets (0 disables)",
      "",
      "### 4) Transcripts (Premium)",
      "• `?transcripts on|off [#channel]` — save ticket transcripts",
      "",
      "_Tip: these are **server-wide** premium settings (only the server owner can change them)._"
    ].join("\n"))
    .setFooter({ text: "Nozzarri Tickets • Premium" });

  return message.reply({ embeds: [embed] }).catch(() => {});
}
// ?premium-redeem <key>
if (content.startsWith("?premium-redeem")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can redeem premium.").catch(() => {});
  }

  const parts = content.split(/\s+/).filter(Boolean);
  const key = parts[1];
  if (!key) {
    return message.reply("Usage: `?premium-redeem DS-XXXX-XXXX-XXXX`").catch(() => {});
  }

  const k = PREMIUM_KEYS[key];
  if (!k) return message.reply("❌ Invalid key.").catch(() => {});
  if (k.used) return message.reply("❌ This key was already used.").catch(() => {});

  PREMIUM_KEYS[key] = {
    ...k,
    used: true,
    usedByGuildId: message.guild.id,
    usedAt: new Date().toISOString()
  };
  writeJsonSafe(PREMIUM_KEYS_FILE, PREMIUM_KEYS);

  // Activate (or extend) premium for this server
  const now = Date.now();
  // Prefer ms-based durations (supports seconds/minutes/hours/etc.), fallback to days.
  const addMs = Number.isFinite(k.durationMs)
    ? k.durationMs
    : ((Number.isFinite(k.durationDays) ? k.durationDays : 30) * 24 * 60 * 60 * 1000);

  const current = PREMIUM_GUILDS[message.guild.id] || {};
  let base = now;
  if (current && current.expiresAt) {
    const curMs = Date.parse(current.expiresAt);
    if (Number.isFinite(curMs) && curMs > now) base = curMs; // extend from current expiry
  }

  const nextExpiresAt = new Date(base + addMs).toISOString();
  savePremiumState(message.guild.id, {
    isPremium: true,
    plan: k.plan || "custom",
    activatedAt: current.activatedAt || new Date().toISOString(),
    expiresAt: nextExpiresAt
  });

  return message.reply("✅ Premium activated for this server! Use `?premium` to see settings.").catch(() => {});
}

// Bot owner only: generate premium keys
// Usage (old):
//   ?premium-gen 15d
//   ?premium-gen 1m
//   ?premium-gen 3m
//   ?premium-gen 45        (custom: 45 days)
// Usage (new, flexible durations):
//   ?premium-gen 30s
//   ?premium-gen 2m
//   ?premium-gen 1h30m
//   ?premium-gen 2d12h
//   ?premium-gen 1w
//   ?premium-gen 2mo
//   ?premium-gen 1y
// Add a count at the end (max 25):
//   ?premium-gen 1h30m 5
if (content.startsWith("?premium-gen")) {
  if (!message.guild) return;
  if (!isBotOwner(message.author.id)) {
    return message.reply("⛔ This is a **bot-owner** command.").catch(() => {});
  }

  const parts = content.split(/\s+/).filter(Boolean);
  const planArg = parts[1];
  const countArg = parts[2];

  if (!planArg) {
    return message.reply(
      "Usage: `?premium-gen 15d` / `?premium-gen 1m` / `?premium-gen 3m`\n" +
      "Optional: `?premium-gen 1m 5` (make 5 keys)\n" +
      "Custom: `?premium-gen 45` (days)"
    ).catch(() => {});
  }

  const dur = parseDurationToMs(planArg);
  if (!dur) {
    return message.reply(
      "❌ Invalid duration. Examples: `15d`, `1m` (month), `45` (days), `30s`, `2m` (minutes), `1h30m`, `2d12h`, `1w`, `2mo`, `1y`."
    ).catch(() => {});
  }

  let count = 1;
  if (countArg) {
    const n = Number(countArg);
    if (!Number.isFinite(n) || n < 1 || n > 25) {
      return message.reply("❌ Count must be between 1 and 25.").catch(() => {});
    }
    count = Math.floor(n);
  }

  const keys = [];
  for (let i=0; i<count; i++){
    const key = makeLicenseKey();
    PREMIUM_KEYS[key] = {
      plan: dur.plan,
      durationMs: dur.ms,
      durationDays: dur.days, // legacy compatibility
      durationLabel: dur.label,
      createdAt: new Date().toISOString(),
      createdBy: String(message.author.id),
      used: false,
      usedByGuildId: null,
      usedAt: null
    };
    keys.push(key);
  }

  writeJsonSafe(PREMIUM_KEYS_FILE, PREMIUM_KEYS);

  const lines = keys.map(k=>`• \`${k}\``).join("\n");
  return message.reply(
    `✅ Generated **${count}** premium key(s) — duration: **${dur.label}**\n\n${lines}\n\n` +
    "Send a key to the **server owner**. They redeem with:\n" +
    "`?premium-redeem <key>`"
  ).catch(() => {});
}


// Premium branding (server owner only)
// ?brandname <text>
if (content.startsWith("?brandname ") || content.startsWith("?premium-name ") || content.startsWith("?displayname ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change branding.").catch(() => {});
  }
  const p = getPremiumState(message.guild.id);
  if (!p.isPremium) {
    return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  }
  const name = content.split(/\s+/).slice(1).join(" ").trim();
  if (!name || name.length > 40) return message.reply("❌ Name must be 1–40 characters.").catch(() => {});
  savePremiumState(message.guild.id, { branding: { name } });
  return message.reply(`✅ Saved brand name: **${name}**`).catch(() => {});
}

// ?brandicon <url>
if (content.startsWith("?brandicon ") || content.startsWith("?premium-icon ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change branding.").catch(() => {});
  }
  const p = getPremiumState(message.guild.id);
  if (!p.isPremium) {
    return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  }
  const url = content.split(/\s+/).slice(1).join(" ").trim();
  if (!looksLikeUrl(url)) return message.reply("❌ Please provide a valid http/https URL.").catch(() => {});
  savePremiumState(message.guild.id, { branding: { iconUrl: url } });
  return message.reply("✅ Saved brand icon URL.").catch(() => {});
}


// Premium: change bot's server nickname (display name in member list)
// ?botnick <name>
// ?botnick reset
if (content.startsWith("?botnick ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change the bot nickname.").catch(() => {});
  }
  const p = getPremiumState(message.guild.id);
  if (!p.isPremium) {
    return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  }

  const raw = content.slice("?botnick ".length).trim();
  if (!raw) return message.reply("Usage: `?botnick Nozzarri ticket` or `?botnick reset`").catch(() => {});
  if (raw.toLowerCase() === "reset") {
    savePremiumState(message.guild.id, { features: { botNickname: "" } });
    // clear stored nickname by removing it
    const me = message.guild.members.me || (await message.guild.members.fetchMe().catch(()=>null));
    if (me) await me.setNickname(null).catch(()=>{});
    return message.reply("✅ Bot nickname reset to default.").catch(() => {});
  }

  if (raw.length > 32) return message.reply("❌ Nickname must be 1–32 characters.").catch(() => {});
  savePremiumState(message.guild.id, { features: { botNickname: raw } });
  await applyBotNickname(message.guild);
  return message.reply(`✅ Bot nickname set to **${raw}**`).catch(() => {});
}

// ?accent <hex> (example: ?accent #6d5cff)
if (content.startsWith("?accent ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change branding.").catch(() => {});
  }
  const p = getPremiumState(message.guild.id);
  if (!p.isPremium) {
    return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  }
  const hex = content.slice("?accent ".length).trim();
  if (!isValidHexColor(hex)) return message.reply("❌ Use a hex color like `#6d5cff`.").catch(() => {});
  savePremiumState(message.guild.id, { branding: { accent: normalizeHexColor(hex) } });
  return message.reply("✅ Saved accent color.").catch(() => {});
}

// ?premium-features (server owner) — show current premium settings
if (content === "?premium-features") {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can view premium settings.").catch(() => {});
  }
  const txt = getPremiumFeaturesText(message.guild.id);
  return message.reply(`📌 **Premium Settings**\n${txt}`).catch(() => {});
}

// Premium feature: ping mode
// ?pingmode here|role|off
if (content.startsWith("?pingmode ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change premium settings.").catch(() => {});
  }
  const req = requirePremium(message);
  if (!req.ok) return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  const mode = content.slice("?pingmode ".length).trim().toLowerCase();
  if (!["here","role","off"].includes(mode)) {
    return message.reply("Usage: `?pingmode here` or `?pingmode role` or `?pingmode off`").catch(() => {});
  }
  savePremiumState(message.guild.id, { features: { pingMode: mode } });
  return message.reply(`✅ Ping mode set to **${mode}**`).catch(() => {});
}

// ?pingrole <roleId or @Role> (only used when pingmode=role)
if (content.startsWith("?pingrole ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change premium settings.").catch(() => {});
  }
  const req = requirePremium(message);
  if (!req.ok) return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  const raw = content.slice("?pingrole ".length).trim();
  const roleId = raw.replace(/[^0-9]/g, "");
  if (!roleId || !message.guild.roles.cache.get(roleId)) {
    return message.reply("❌ Please provide a valid role (mention it or paste the role ID).").catch(() => {});
  }
  savePremiumState(message.guild.id, { features: { pingRoleId: roleId } });
  return message.reply(`✅ Ping role set to <@&${roleId}>`).catch(() => {});
}

// Premium feature: auto close timer
// ?autoclose <minutes>  (0/off disables)
if (content.startsWith("?autoclose ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change premium settings.").catch(() => {});
  }
  const req = requirePremium(message);
  if (!req.ok) return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  const raw = content.slice("?autoclose ".length).trim().toLowerCase();
  if (raw === "off") {
    savePremiumState(message.guild.id, { features: { autoCloseMinutes: 0 } });
    return message.reply("✅ Auto-close disabled.").catch(() => {});
  }
  const mins = normalizeMinutes(raw);
  if (mins <= 0) return message.reply("❌ Use a number of minutes (1–1440) or `off`.").catch(() => {});
  savePremiumState(message.guild.id, { features: { autoCloseMinutes: mins } });
  return message.reply(`✅ Auto-close set to **${mins} minutes** after ticket creation.`).catch(() => {});
}

// Premium feature: transcripts
// ?transcripts on|off
if (content.startsWith("?transcripts ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change premium settings.").catch(() => {});
  }
  const req = requirePremium(message);
  if (!req.ok) return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  const mode = content.slice("?transcripts ".length).trim().toLowerCase();
  if (!["on","off"].includes(mode)) return message.reply("Usage: `?transcripts on` or `?transcripts off`").catch(() => {});
  savePremiumState(message.guild.id, { features: { transcripts: mode === "on" } });
  return message.reply(`✅ Transcripts **${mode.toUpperCase()}**`).catch(() => {});
}

// ?transcript-channel <channelId or #channel or off>
if (content.startsWith("?transcript-channel ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change premium settings.").catch(() => {});
  }
  const req = requirePremium(message);
  if (!req.ok) return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  const raw = content.slice("?transcript-channel ".length).trim().toLowerCase();
  if (raw === "off") {
    savePremiumState(message.guild.id, { features: { transcriptChannelId: null } });
    return message.reply("✅ Transcript channel cleared (will use log channel if set).").catch(() => {});
  }
  const id = raw.replace(/[^0-9]/g, "");
  if (!id) return message.reply("❌ Provide a channel mention or ID, or `off`.").catch(() => {});
  const ch = message.guild.channels.cache.get(id);
  if (!ch || ch.type !== ChannelType.GuildText) return message.reply("❌ That must be a text channel.").catch(() => {});
  savePremiumState(message.guild.id, { features: { transcriptChannelId: id } });
  return message.reply(`✅ Transcript channel set to <#${id}>`).catch(() => {});
}

// Premium feature: custom welcome message sent inside each ticket
// ?welcome <text>   (use {user} and {type})
// ?welcome off
if (content.startsWith("?welcome ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change premium settings.").catch(() => {});
  }
  const req = requirePremium(message);
  if (!req.ok) return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  const raw = content.slice("?welcome ".length);
  if (raw.trim().toLowerCase() === "off") {
    savePremiumState(message.guild.id, { features: { welcomeMessage: "" } });
    return message.reply("✅ Welcome message cleared.").catch(() => {});
  }
  if (raw.trim().length > 800) return message.reply("❌ Keep it under 800 characters.").catch(() => {});
  savePremiumState(message.guild.id, { features: { welcomeMessage: raw.trim() } });
  return message.reply("✅ Welcome message saved. Use `{user}` and `{type}` in your message.").catch(() => {});
}

// Premium feature: ticket name template
// ?ticketname <template>  e.g. ticket-{type}-{user}
// placeholders: {user} {type} {id}
// ?ticketname reset
if (content.startsWith("?ticketname ")) {
  if (!message.guild) return;
  const ownerId = message.guild.ownerId;
  if (message.author.id !== ownerId) {
    return message.reply("⛔ Only the **server owner** can change premium settings.").catch(() => {});
  }
  const req = requirePremium(message);
  if (!req.ok) return message.reply("💎 This is a **Premium** feature. Activate with `?premium-redeem <key>`.").catch(() => {});
  const raw = content.slice("?ticketname ".length).trim();
  if (raw.toLowerCase() === "reset") {
    savePremiumState(message.guild.id, { features: { ticketNameTemplate: "ticket-{user}" } });
    return message.reply("✅ Ticket name template reset to `ticket-{user}`").catch(() => {});
  }
  if (!raw || raw.length > 40) return message.reply("❌ Template must be 1–40 characters.").catch(() => {});
  savePremiumState(message.guild.id, { features: { ticketNameTemplate: raw } });
  return message.reply(`✅ Ticket name template set to \`${raw}\``).catch(() => {});
}

// Global bot identity (Bot Owner ONLY)
// ?botname <name>  (global username; rate limited by Discord)
// ?botavatar <imageUrl>
if (content.startsWith("?botname ")) {
  if (!isBotOwner(message.author.id)) return;
  const name = content.slice("?botname ".length).trim();
  if (!name || name.length > 32) return message.reply("❌ Bot username must be 1–32 characters.").catch(() => {});
  try{
    await client.user.setUsername(name);
    return message.reply(`✅ Bot username changed to **${name}**`).catch(() => {});
  }catch(e){
    return message.reply("❌ Failed to change bot username (Discord rate limits this).").catch(() => {});
  }
}
if (content.startsWith("?botavatar ")) {
  if (!isBotOwner(message.author.id)) return;
  return message.reply("❌ Removed: bot avatars are global across all servers (Discord limitation).").catch(() => {});
}

  // Support panel
  if (content === "?support") {
    if (!message.guild) return;
    if (!isOwnerOrAdmin(message)) {
      return message.reply("⛔ This command is owner-only in this server.").catch(() => {});
    }
    const cfg = getGuildConfig(message.guild.id);
    if (!cfg.supportEnabled) {
      return message.reply("❌ **Support tickets are disabled**. Server owner: run `?setup` and enable Support.").catch(() => {});
    }
    if (!cfg.supportCategoryId) {
      return message.reply("❌ Support category is not set. Server owner: run `?setup` and set Support Category.").catch(() => {});
    }

    const menu = buildSupportMenu();

    const brand = getPremiumState(message.guild.id);

    const embed = new EmbedBuilder()
      .setTitle(`🛠️ ${getPremiumState(message.guild.id).branding.name} — Support Panel`)
      .setDescription(getPanelDescription(message.guild.id, "support"))
      .setColor("#2F3136")
      .setFooter({ text: "Nozzarri services | Professional support" });

    applyBranding(embed, message.guild.id);
    applyBranding(embed, message.guild.id);
    await message.channel.send({ embeds: [embed], components: [menu] });
  }

  // Trade help panel
  if (content === "?trade") {
    if (!message.guild) return;
    if (!isOwnerOrAdmin(message)) {
      return message.reply("⛔ This command is owner-only in this server.").catch(() => {});
    }
    const cfg = getGuildConfig(message.guild.id);
    if (!cfg.tradeEnabled) {
      return message.reply("❌ **Trade tickets are disabled**. Server owner: run `?setup` and enable Trade.").catch(() => {});
    }
    if (!cfg.mmCategoryId) {
      return message.reply("❌ Trade category is not set. Server owner: run `?setup` and set Trade Category.").catch(() => {});
    }

    const menu = buildTradeMenu();

    const embed = new EmbedBuilder()
      .setTitle("🛡️ Nozzarri Tickets — Official Trade Panel 🐉")
      .setDescription(getPanelDescription(message.guild.id, "trade"))
      .setColor("#9b59b6")
      .setFooter({ text: "Nozzarri services | Official Trade Panel" });

    applyBranding(embed, message.guild.id);
    await message.channel.send({ embeds: [embed], components: [menu] });
  }
});

// ----------------------
// BOT MENTION → OPEN HELP PANEL
// ✅ FIX: trigger ONLY when bot itself is mentioned (not @everyone/@here/role pings)
// ----------------------
client.on("messageCreate", async message => {
  if (message.author.bot) return;
  if (!client.user) return;

  const botId = client.user.id;

  const mentionedBotDirectly =
    message.mentions.users?.has(botId) &&
    !message.mentions.everyone &&
    (message.content.includes(`<@${botId}>`) || message.content.includes(`<@!${botId}>`));

  if (mentionedBotDirectly) {
    const embed = new EmbedBuilder()
      .setTitle(`🐉 ${getPremiumState(message.guild.id).branding.name} — Help Center`)
      .setColor("#e74c3c")
      .setDescription(
        `👋 **Hey ${message.author.username}!**\n\n` +
          "Click the button below to open your **private Help Panel**.\n\n" +
          "There you can see:\n" +
          "• 📘 What the bot does\n" +
          "• ⚙️ Features\n" +
          "• 🎫 Tickets info\n" +
          "• 🤝 Trade help info\n" +
          "• ⭐ Ratings info\n\n" +
          "Only **you** will see the help panel."
      )
      .setFooter({ text: "Nozzarri Tickets • Secure • Professional" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_help_panel")
        .setLabel("📖 Open Help Panel")
        .setStyle(ButtonStyle.Danger)
    );

    applyBranding(embed, message.guild.id);
    return message.reply({ embeds: [embed], components: [row] });
  }
});

// ----------------------
// NEW: safe overwrites helpers (FIXES InvalidType + “thinking” freeze)
// ----------------------
function isValidSnowflake(id) {
  return typeof id === "string" && /^[0-9]{15,25}$/.test(id);
}

async function ensureRolesCached(guild, roleIds) {
  const uniq = [...new Set(roleIds.filter(isValidSnowflake))];
  const missing = uniq.filter(id => !guild.roles.cache.has(id));
  if (!missing.length) return;

  await Promise.all(missing.map(id => guild.roles.fetch(id).catch(() => null)));
}

// ✅ FIX: only include overwrites for roles that actually exist in this guild
function buildRoleOverwrites(guild, roleIds, permsAllow) {
  const uniq = [...new Set((roleIds || []).filter(isValidSnowflake))];
  const existing = uniq.filter(roleId => guild.roles.cache.has(roleId));
  return existing.map(roleId => ({
    id: roleId,
    allow: permsAllow
  }));
}

// ----------------------
// Interaction handler
// ----------------------
client.on("interactionCreate", async interaction => {

// --------------------------

// --------------------------
// ?mercy buttons
// --------------------------
if (interaction.isButton() && typeof interaction.customId === "string" && interaction.customId.startsWith("mercy_")) {
  // For buttons we ACK with deferUpdate (no "Interaction failed")
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate().catch(() => {});
  }

  const action = interaction.customId; // "mercy_join" | "mercy_broke"
  const guild = interaction.guild;
  if (!guild) return;

  // Helper: disable the buttons after one click
  const disableButtons = async () => {
    try{
      if (!interaction.message) return;
      const rows = (interaction.message.components || []).map(row => {
        const newRow = ActionRowBuilder.from(row);
        newRow.components = newRow.components.map(c => ButtonBuilder.from(c).setDisabled(true));
        return newRow;
      });
      await interaction.message.edit({ components: rows }).catch(() => {});
    }catch{}
  };

  if (action === "mercy_broke") {
    // Public message (everyone can see)
    await interaction.channel?.send(`❌ **${interaction.user.tag}** chose **Be broke**.`).catch(() => {});
    await disableButtons();
    return;
  }

  if (action === "mercy_join") {
    if (!MERCY_JOIN_ROLE_ID) {
      await interaction.followUp({ content: "⚠️ MERCY_JOIN_ROLE_ID is not set in .env", ephemeral: true }).catch(() => {});
      return;
    }

    const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
    if (!me) {
      await interaction.followUp({ content: "Bot member not found.", ephemeral: true }).catch(() => {});
      return;
    }

    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles) && !me.permissions.has(PermissionsBitField.Flags.Administrator)) {
      await interaction.followUp({ content: "I need **Manage Roles** permission.", ephemeral: true }).catch(() => {});
      return;
    }

    const role = guild.roles.cache.get(MERCY_JOIN_ROLE_ID) || (await guild.roles.fetch(MERCY_JOIN_ROLE_ID).catch(()=>null));
    if (!role) {
      await interaction.followUp({ content: "Role not found. Check MERCY_JOIN_ROLE_ID.", ephemeral: true }).catch(() => {});
      return;
    }

    if (me.roles.highest.position <= role.position) {
      await interaction.followUp({ content: "I can’t give that role because my bot role is not above it. Move my bot role higher.", ephemeral: true }).catch(() => {});
      return;
    }

    const member = await guild.members.fetch(interaction.user.id).catch(() => null);
    if (!member) {
      await interaction.followUp({ content: "Member not found.", ephemeral: true }).catch(() => {});
      return;
    }

    await member.roles.add(role, "Pressed Join us on ?mercy").catch((e) => {
      console.error("mercy_join add role error:", e);
    });

    await interaction.followUp({ content: "✅ You joined us. Role given!", ephemeral: true }).catch(() => {});
    await disableButtons();
    return;
  }
}
  // HELP PANEL UI — PRIVATE TABBED MENU
  // ==================================================
  if (interaction.isButton()) {
    // open main help panel (ephemeral)
    if (interaction.customId === "open_help_panel") {
      const embed = new EmbedBuilder()
        .setTitle("📘 | Nozzarri Help Panel")
        .setColor("#e74c3c")
        .setDescription(
          "Welcome to your **private help menu**! 🐉\n\n" +
            "Use the tabs below to explore what I can do.\n\n" +
            "🔻 **Choose a category below**"
        )
        .setFooter({ text: "Nozzarri Tickets Help Center 🐉" });

      const tabs1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tab_description").setLabel("Description").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_features").setLabel("Features").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_ticket").setLabel("Tickets").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_trade").setLabel("Trades").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_ratings").setLabel("Ratings").setStyle(ButtonStyle.Secondary),
    );

    const tabs2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tab_premium").setLabel("Premium ✨").setStyle(ButtonStyle.Primary),
    );

    const tabs = [tabs1, tabs2];

      return safeUpdate(interaction, {
        embeds: [embed],
        components: tabs,
        ephemeral: true
      });
    }

    // tab switching for help menu
    if (
      interaction.customId === "tab_description" ||
      interaction.customId === "tab_features" ||
      interaction.customId === "tab_ticket" ||
      interaction.customId === "tab_trade" ||
      interaction.customId === "tab_ratings" ||
      interaction.customId === "tab_premium"
    ) {
      const makeEmbed = (title, text) =>
        new EmbedBuilder()
          .setTitle(title)
          .setColor("#f1c40f")
          .setDescription(text)
          .setFooter({ text: "Nozzarri Tickets Help Center 🐉" });

      const tabs1 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tab_description").setLabel("Description").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_features").setLabel("Features").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_ticket").setLabel("Tickets").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_trade").setLabel("Trades").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId("tab_ratings").setLabel("Ratings").setStyle(ButtonStyle.Secondary),
    );

    const tabs2 = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("tab_premium").setLabel("Premium ✨").setStyle(ButtonStyle.Primary),
    );

    const tabs = [tabs1, tabs2];

      if (interaction.customId === "tab_description") {
        return safeUpdate(interaction, {
          embeds: [
            makeEmbed(
              "📘 Bot Description",
              "Hi! I'm **Nozzarri Tickets Bot** 🐉\n\n" +
                "✨ I help with:\n" +
                "• Secure **trade-assist deals**\n" +
                "• 🔧 Support issues\n" +
                "• 🎫 Ticket management\n" +
                "• ⭐ Rating system\n\n" +
                "Use the tabs below to learn more about each system."
            )
          ],
          components: tabs
        });
      }

      if (interaction.customId === "tab_features") {
        return safeUpdate(interaction, {
          embeds: [
            makeEmbed(
              "⚙️ Features",
              "Here is what I can do:\n\n" +
                "🔧 **Support tickets** – private channels with staff\n" +
                "🤝 **Trade tickets** – safe trades with verified staff\n" +
                "⭐ **Ratings** – rate the service & trade staff\n" +
                "🧾 **Logs** – all actions are logged in a staff channel\n"
            )
          ],
          components: tabs
        });
      }

      if (interaction.customId === "tab_ticket") {
        return safeUpdate(interaction, {
          embeds: [
            makeEmbed(
              "🎫 Ticket System",
              "How the ticket system works:\n\n" +
                "1️⃣ You choose **Support** or **Trade Help** from the panels\n" +
                "2️⃣ You fill a short form (modal) with your problem/trade\n" +
                "3️⃣ A **private ticket channel** is created\n" +
                "4️⃣ Staff joins, helps you, and closes the ticket\n" +
                "5️⃣ After closing, you receive a **DM summary + rating buttons**\n"
            )
          ],
          components: tabs
        });
      }

      if (interaction.customId === "tab_trade") {
        return safeUpdate(interaction, {
          embeds: [
            makeEmbed(
              "🤝 Trade Help System",
              "Trade tickets can protect your trades:\n\n" +
                "• Both users join the **Trade ticket**\n" +
                "• Trade terms are clearly written\n" +
                "• Staff supervises payment & delivery\n" +
                "• Only after everything is confirmed, the trade is completed\n" +
                "• You can then **rate the helper** ⭐\n"
            )
          ],
          components: tabs
        });
      }

      if (interaction.customId === "tab_ratings") {
        return safeUpdate(interaction, {
          embeds: [
            makeEmbed(
              "⭐ Rating System",
              "After a ticket is closed, you can rate:\n\n" +
                "• ⭐ **Helper performance** (if staff was involved)\n" +
                "• ⭐ **Overall service quality**\n\n" +
                "These ratings are saved and used for:\n" +
                "• 🛡 More trust & transparency in the community\n"
            )
          ],
          components: tabs
        });
      }


if (interaction.customId === "tab_premium") {
  const p = getPremiumState(interaction.guildId);
  return safeUpdate(interaction, {
    embeds: [
      makeEmbed(
        "💎 Premium",
        p.isPremium
          ? `✅ **Premium is active on this server.**

**Premium features (working):**
• 🏷️ Brand name + icon + accent color in embeds/panels
• 🧑‍💻 Bot nickname (server display name)
• 🏷️ Ticket channel name template ({user} {type} {id})
• 📣 Ticket ping: @here / role / off
• ⏳ Auto-close inactive tickets
• 📄 Transcripts on close (posted to a transcript channel)

**Owner premium commands:**
• \`?premium\` (status)
• \`?brandname <text>\`
• \`?brandicon <url>\`
• \`?accent <hex>\`
• \`?botnick <name|reset>\`
• \`?ticketname <template|reset>\`
• \`?pingmode <here|role|off>\`
• \`?pingrole <@Role|roleId>\`
• \`?autoclose <minutes|off>\`
• \`?transcripts <on|off>\`
• \`?transcript-channel <#channel|id|off>\`

Tip: Premium settings are per-server.`
          : `❌ Premium is not active.

Server owner can activate with:
• \`?premium-redeem <key>\`

After activation, open a ticket and you will see the premium ping/name features working.`
      )
    ],
    components: tabs
  });
}
    }
  }


  // ==================================================
  
  // ==================================================
  // PREMIUM CONTROL PANEL — buttons + modals (locked to panel opener)
  // ==================================================
  if (interaction.isButton() && interaction.customId && interaction.customId.startsWith("prem_")) {
    const parts = interaction.customId.split(":");
    const action = parts[0];
    const openerId = parts[parts.length - 1];
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== openerId) {
      return safeUpdate(interaction, { content: "⛔ Only the person who opened this Premium Panel can use it.", ephemeral: true });
    }

    const prem = getPremiumState(interaction.guild.id);

    // Premium Commands submenu (single working tab; pings are configured from the dedicated "Pings" page)
    if (action === "prem_cmds") {
      const payload = buildPremiumCommandsPayload(interaction.guild, openerId);
      return safeUpdate(interaction, { ...payload, ephemeral: true }).catch(() => {});
    }


    // Separate entry for Custom Buttons (same page as Commands builder)
    if (action === "prem_custombtns") {
      const payload = buildPremiumCommandsPayload(interaction.guild, openerId);
      return safeUpdate(interaction, { ...payload, ephemeral: true }).catch(() => {});
    }


    // Helpers
    const goHome = () => safeUpdate(interaction, buildPremiumPanelPayload(interaction.guild, openerId)).catch(() => {});
    const locked = () => safeUpdate(interaction, { content: "🔒 Premium is not active for this server.", ephemeral: true }).catch(() => {});

    if (action === "prem_close") {
      return safeUpdate(interaction, { content: "✅ Closed.", embeds: [], components: [] }).catch(() => {});
    }
    if (action === "prem_refresh" || action === "prem_back") {
      return goHome();
    }

    // If premium is not active, block feature edits (preview only)
    if (!prem.isPremium) {
      return locked();
    }


    // ===============================
    // Premium Custom Buttons (in ?premium → ✨ Commands)
    // ===============================
    if (action === "prem_ticketname") {
      const modal = new ModalBuilder()
        .setCustomId(`prem_modal_ticketname:${openerId}`)
        .setTitle("Ticket Channel Name Template");

      const input = new TextInputBuilder()
        .setCustomId("template")
        .setLabel("Template (use {user}, {id}, {type})")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(80)
        .setValue(String(prem.features.ticketNameTemplate || "ticket-{user}").slice(0, 80));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (action === "prem_welcome") {
      const modal = new ModalBuilder()
        .setCustomId(`prem_modal_welcome:${openerId}`)
        .setTitle("Ticket Welcome Message");

      const input = new TextInputBuilder()
        .setCustomId("msg")
        .setLabel("Message (leave empty to disable)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(false)
        .setMaxLength(1500)
        .setValue(String(prem.features.welcomeMessage || "").slice(0, 1500));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (action === "prem_botnick") {
      const modal = new ModalBuilder()
        .setCustomId(`prem_modal_botnick:${openerId}`)
        .setTitle("Bot Nickname (Server)");

      const input = new TextInputBuilder()
        .setCustomId("nick")
        .setLabel("Nickname (type reset to clear)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32)
        .setValue(String(prem.features.botNickname || "").slice(0, 32));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (action === "prem_autoclose") {
      const modal = new ModalBuilder()
        .setCustomId(`prem_modal_autoclose:${openerId}`)
        .setTitle("Auto Close Tickets");

      const input = new TextInputBuilder()
        .setCustomId("minutes")
        .setLabel("Minutes (0/off to disable)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(8)
        .setValue(prem.features.autoCloseMinutes ? String(prem.features.autoCloseMinutes) : "0");

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }

    if (action === "prem_brand") {
      const modal = new ModalBuilder()
        .setCustomId(`prem_modal_brand:${openerId}`)
        .setTitle("Branding");

      const name = new TextInputBuilder()
        .setCustomId("name")
        .setLabel("Brand Name")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(40)
        .setValue(String(prem.branding.name || "Nozzarri Tickets").slice(0, 40));

      const icon = new TextInputBuilder()
        .setCustomId("icon")
        .setLabel("Icon URL (optional)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(300)
        .setValue(String(prem.branding.iconUrl || "").slice(0, 300));

      const accent = new TextInputBuilder()
        .setCustomId("accent")
        .setLabel("Accent color hex (optional, e.g. #F1C40F)")
        .setStyle(TextInputStyle.Short)
        .setRequired(false)
        .setMaxLength(10)
        .setValue(String(prem.branding.accent || "").slice(0, 10));

      modal.addComponents(
        new ActionRowBuilder().addComponents(name),
        new ActionRowBuilder().addComponents(icon),
        new ActionRowBuilder().addComponents(accent)
      );
      return interaction.showModal(modal).catch(() => {});
    }

    if (action === "prem_pings") {
      const s = prem.features.ticketPings?.support || { roles:[], here:false, everyone:false };
      const t = prem.features.ticketPings?.trade || { roles:[], here:false, everyone:false };

      const fmt = (cfg) => {
        const parts = [];
        if (cfg.everyone) parts.push("@everyone");
        if (cfg.here) parts.push("@here");
        if (Array.isArray(cfg.roles) && cfg.roles.length) parts.push(...cfg.roles.map(id => `<@&${id}>`));
        return parts.length ? uniq(parts).join(" ") : "(default: @here)";
      };

      const embed = new EmbedBuilder()
        .setTitle("📣 Premium Ticket Pings")
        .setDescription(
          "Choose what the bot pings when a ticket is opened.\n" +
          "You can select **multiple roles** and also enable **@here / @everyone**.\n\n" +
          `**Support:** ${fmt(s)}\n` +
          `**Trade/MM:** ${fmt(t)}`
        )
        .setColor(prem.branding.accent || "#f1c40f");

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prem_ping_cfg_support:${openerId}`).setLabel("🛠️ Configure Support").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`prem_ping_cfg_trade:${openerId}`).setLabel("🤝 Configure Trade/MM").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`prem_back:${openerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
      );

      applyBranding(embed, interaction.guild.id);
      return safeUpdate(interaction, { embeds: [embed], components: [row] }).catch(() => {});
    }

    // Configure Support pings
    if (action === "prem_ping_cfg_support" || action === "prem_ping_cfg_trade") {
      const which = action === "prem_ping_cfg_trade" ? "trade" : "support";
      const cfg = prem.features.ticketPings?.[which] || { roles:[], here:false, everyone:false };

      const embed = new EmbedBuilder()
        .setTitle(which === "trade" ? "🤝 Trade/MM Pings" : "🛠️ Support Pings")
        .setDescription(
          "Select roles to ping (multi-select), and optionally toggle @here / @everyone.\n" +
          "If you select nothing, the bot will default to **@here**."
        )
        .setColor(prem.branding.accent || "#f1c40f")
        .addFields(
          { name: "@here", value: cfg.here ? "✅ On" : "❌ Off", inline: true },
          { name: "@everyone", value: cfg.everyone ? "✅ On" : "❌ Off", inline: true },
          { name: "Roles", value: (Array.isArray(cfg.roles) && cfg.roles.length) ? cfg.roles.map(id => `<@&${id}>`).join(", ") : "—", inline: false }
        );

      applyBranding(embed, interaction.guild.id);

      const roleRow = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`prem_ping_roles:${which}:${openerId}`)
          .setPlaceholder("Select roles to ping…")
          .setMinValues(0)
          .setMaxValues(25)
      );

      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prem_ping_toggle_here:${which}:${openerId}`).setLabel(cfg.here ? "@here: ON" : "@here: OFF").setStyle(cfg.here ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`prem_ping_toggle_everyone:${which}:${openerId}`).setLabel(cfg.everyone ? "@everyone: ON" : "@everyone: OFF").setStyle(cfg.everyone ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`prem_ping_clear_roles:${which}:${openerId}`).setLabel("🧹 Clear Roles").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`prem_pings:${openerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
      );

      return safeUpdate(interaction, { embeds: [embed], components: [roleRow, btnRow] }).catch(() => {});
    }

    if (action === "prem_transcripts") {
      const f = prem.features;
      const embed = new EmbedBuilder()
        .setTitle("📄 Premium Transcripts")
        .setDescription(
          "When a ticket is closed, the bot can post a transcript in a chosen channel.\n\n" +
          `Status: **${f.transcripts ? "ON ✅" : "OFF ❌"}**\n` +
          `Channel: ${f.transcriptChannelId ? `<#${f.transcriptChannelId}>` : "**Not set**"}`
        )
        .setColor(prem.branding.accent || "#f1c40f");

      const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prem_transcripts_toggle:${openerId}`).setLabel(f.transcripts ? "Turn OFF" : "Turn ON").setStyle(f.transcripts ? ButtonStyle.Danger : ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`prem_transcripts_pick:${openerId}`).setLabel("📌 Set Channel").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`prem_back:${openerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
      );

      applyBranding(embed, interaction.guild.id);
      return safeUpdate(interaction, { embeds: [embed], components: [row1] }).catch(() => {});
    }

    if (action === "prem_transcripts_toggle") {
      savePremiumState(interaction.guild.id, { features: { transcripts: !prem.features.transcripts } });
      return safeUpdate(interaction, buildPremiumPanelPayload(interaction.guild, openerId)).catch(() => {});
    }

    if (action === "prem_transcripts_pick") {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`prem_pick_transcript:${openerId}`)
          .setPlaceholder("Select transcript channel…")
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1)
      );

      return safeUpdate(interaction, { ...buildPremiumPanelPayload(interaction.guild, openerId), components: [row] }).catch(() => {});
    }

    // Ping toggles / clear (new ticketPings system)
    if (action === "prem_ping_toggle_here" || action === "prem_ping_toggle_everyone" || action === "prem_ping_clear_roles") {
      const which = parts[1] === "trade" ? "trade" : "support";
      const cur = prem.features.ticketPings?.[which] || { roles:[], here:false, everyone:false };

      if (action === "prem_ping_toggle_here") {
        savePremiumState(interaction.guild.id, { features: { ticketPings: { ...(prem.features.ticketPings || {}), [which]: { ...cur, here: !cur.here } } } });
      }
      if (action === "prem_ping_toggle_everyone") {
        savePremiumState(interaction.guild.id, { features: { ticketPings: { ...(prem.features.ticketPings || {}), [which]: { ...cur, everyone: !cur.everyone } } } });
      }
      if (action === "prem_ping_clear_roles") {
        savePremiumState(interaction.guild.id, { features: { ticketPings: { ...(prem.features.ticketPings || {}), [which]: { ...cur, roles: [] } } } });
      }

      // Re-render the same config page
      const rerender = which === "trade" ? "prem_ping_cfg_trade" : "prem_ping_cfg_support";
      const fake = { ...interaction, customId: `${rerender}:${openerId}` };
      // easiest: just call the handler by updating the message with the config UI
      const newPrem = getPremiumState(interaction.guild.id);
      const cfg = newPrem.features.ticketPings?.[which] || { roles:[], here:false, everyone:false };
      const embed = new EmbedBuilder()
        .setTitle(which === "trade" ? "🤝 Trade/MM Pings" : "🛠️ Support Pings")
        .setDescription(
          "Select roles to ping (multi-select), and optionally toggle @here / @everyone.\n" +
          "If you select nothing, the bot will default to **@here**."
        )
        .setColor(newPrem.branding.accent || "#f1c40f")
        .addFields(
          { name: "@here", value: cfg.here ? "✅ On" : "❌ Off", inline: true },
          { name: "@everyone", value: cfg.everyone ? "✅ On" : "❌ Off", inline: true },
          { name: "Roles", value: (Array.isArray(cfg.roles) && cfg.roles.length) ? cfg.roles.map(id => `<@&${id}>`).join(", ") : "—", inline: false }
        );
      applyBranding(embed, interaction.guild.id);

      const roleRow = new ActionRowBuilder().addComponents(
        new RoleSelectMenuBuilder()
          .setCustomId(`prem_ping_roles:${which}:${openerId}`)
          .setPlaceholder("Select roles to ping…")
          .setMinValues(0)
          .setMaxValues(25)
      );
      const btnRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`prem_ping_toggle_here:${which}:${openerId}`).setLabel(cfg.here ? "@here: ON" : "@here: OFF").setStyle(cfg.here ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`prem_ping_toggle_everyone:${which}:${openerId}`).setLabel(cfg.everyone ? "@everyone: ON" : "@everyone: OFF").setStyle(cfg.everyone ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`prem_ping_clear_roles:${which}:${openerId}`).setLabel("🧹 Clear Roles").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId(`prem_pings:${openerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
      );
      return safeUpdate(interaction, { embeds: [embed], components: [roleRow, btnRow] }).catch(() => {});
    }
  }

  // Premium ping role picker (RoleSelectMenu)
  if (interaction.isRoleSelectMenu() && interaction.customId && interaction.customId.startsWith("prem_ping_roles:")) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const parts = interaction.customId.split(":");
    const which = parts[1] === "trade" ? "trade" : "support";
    const openerId = parts[2];

    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== openerId) return safeUpdate(interaction, { content: "⛔ Not your panel.", ephemeral: true });

    const prem = getPremiumState(interaction.guild.id);
    if (!prem.isPremium) return safeUpdate(interaction, { content: "🔒 Premium is not active for this server.", ephemeral: true });

    const picked = (interaction.values || []).filter(isValidSnowflake);
    const cur = prem.features.ticketPings?.[which] || { roles:[], here:false, everyone:false };
    savePremiumState(interaction.guild.id, { features: { ticketPings: { ...(prem.features.ticketPings || {}), [which]: { ...cur, roles: picked } } } });

    // Re-render config UI
    const newPrem = getPremiumState(interaction.guild.id);
    const cfg = newPrem.features.ticketPings?.[which] || { roles:[], here:false, everyone:false };

    const embed = new EmbedBuilder()
      .setTitle(which === "trade" ? "🤝 Trade/MM Pings" : "🛠️ Support Pings")
      .setDescription(
        "Select roles to ping (multi-select), and optionally toggle @here / @everyone.\n" +
        "If you select nothing, the bot will default to **@here**."
      )
      .setColor(newPrem.branding.accent || "#f1c40f")
      .addFields(
        { name: "@here", value: cfg.here ? "✅ On" : "❌ Off", inline: true },
        { name: "@everyone", value: cfg.everyone ? "✅ On" : "❌ Off", inline: true },
        { name: "Roles", value: (Array.isArray(cfg.roles) && cfg.roles.length) ? cfg.roles.map(id => `<@&${id}>`).join(", ") : "—", inline: false }
      );

    applyBranding(embed, interaction.guild.id);

    const roleRow = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`prem_ping_roles:${which}:${openerId}`)
        .setPlaceholder("Select roles to ping…")
        .setMinValues(0)
        .setMaxValues(25)
    );

    const btnRow = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`prem_ping_toggle_here:${which}:${openerId}`).setLabel(cfg.here ? "@here: ON" : "@here: OFF").setStyle(cfg.here ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`prem_ping_toggle_everyone:${which}:${openerId}`).setLabel(cfg.everyone ? "@everyone: ON" : "@everyone: OFF").setStyle(cfg.everyone ? ButtonStyle.Success : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`prem_ping_clear_roles:${which}:${openerId}`).setLabel("🧹 Clear Roles").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId(`prem_pings:${openerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
    );

    return safeUpdate(interaction, { embeds: [embed], components: [roleRow, btnRow] }).catch(() => {});
  }

  // Transcript channel select
  if (interaction.isChannelSelectMenu() && interaction.customId && interaction.customId.startsWith("prem_pick_transcript:")) {
    const [, openerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== openerId) return safeUpdate(interaction, { content: "⛔ Not your panel.", ephemeral: true });

    const prem = getPremiumState(interaction.guild.id);
    if (!prem.isPremium) return safeUpdate(interaction, { content: "🔒 Premium is not active for this server.", ephemeral: true });

    const id = (interaction.values && interaction.values[0]) ? interaction.values[0] : null;
    if (id) savePremiumState(interaction.guild.id, { features: { transcriptChannelId: id, transcripts: true } });

    return safeUpdate(interaction, buildPremiumPanelPayload(interaction.guild, openerId)).catch(() => {});
  }

  // Premium modals
  if (interaction.isModalSubmit() && interaction.customId && interaction.customId.startsWith("prem_modal_")) {
    const [base, openerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== openerId) return safeUpdate(interaction, { content: "⛔ Not your panel.", ephemeral: true });

    const prem = getPremiumState(interaction.guild.id);
    if (!prem.isPremium) return safeUpdate(interaction, { content: "🔒 Premium is not active for this server.", ephemeral: true });

    if (base === "prem_modal_ticketname") {
      const template = interaction.fields.getTextInputValue("template") || "ticket-{user}";
      savePremiumState(interaction.guild.id, { features: { ticketNameTemplate: template.trim().slice(0, 80) } });
      return safeUpdate(interaction, { content: "✅ Ticket name template saved.", ephemeral: true }).catch(() => {});
    }

    if (base === "prem_modal_welcome") {
      const msg = (interaction.fields.getTextInputValue("msg") || "").trim();
      savePremiumState(interaction.guild.id, { features: { welcomeMessage: msg } });
      return safeUpdate(interaction, { content: msg ? "✅ Welcome message saved." : "✅ Welcome message cleared.", ephemeral: true }).catch(() => {});
    }

    if (base === "prem_modal_autoclose") {
      const raw = (interaction.fields.getTextInputValue("minutes") || "").trim().toLowerCase();
      const minutes = raw === "off" ? 0 : parseInt(raw, 10);
      savePremiumState(interaction.guild.id, { features: { autoCloseMinutes: Number.isFinite(minutes) ? Math.max(0, minutes) : 0 } });
      return safeUpdate(interaction, { content: "✅ Auto close updated.", ephemeral: true }).catch(() => {});
    }

    if (base === "prem_modal_pingrole") {
      const raw = (interaction.fields.getTextInputValue("role") || "").trim();
      const id = (raw.match(/\d{17,20}/) || [null])[0];
      savePremiumState(interaction.guild.id, { features: { pingRoleId: id || null, pingMode: id ? "role" : prem.features.pingMode } });
      return safeUpdate(interaction, { content: id ? "✅ Ping role saved." : "✅ Ping role cleared.", ephemeral: true }).catch(() => {});
    }

    if (base === "prem_modal_botnick") {
      const raw = (interaction.fields.getTextInputValue("nick") || "").trim();
      const nextNick = raw.toLowerCase() === "reset" ? null : raw.slice(0, 32);
      savePremiumState(interaction.guild.id, { features: { botNickname: nextNick } });

      // Try applying immediately
      try {
        const me = interaction.guild.members.me || (await interaction.guild.members.fetchMe());
        if (me) await me.setNickname(nextNick || null).catch(() => {});
      } catch {}

      return safeUpdate(interaction, { content: nextNick ? "✅ Bot nickname updated." : "✅ Bot nickname reset.", ephemeral: true }).catch(() => {});
    }

    if (base === "prem_modal_brand") {
      const name = (interaction.fields.getTextInputValue("name") || "").trim().slice(0, 40) || "Nozzarri Tickets";
      const icon = (interaction.fields.getTextInputValue("icon") || "").trim();
      const accent = (interaction.fields.getTextInputValue("accent") || "").trim();

      const patch = { branding: { name } };
      if (icon) patch.branding.iconUrl = icon;
      else patch.branding.iconUrl = null;

      if (accent) {
        if (isValidHexColor(accent)) patch.branding.accent = normalizeHexColor(accent);
      } else {
        patch.branding.accent = null;
      }

      savePremiumState(interaction.guild.id, patch);
      return safeUpdate(interaction, { content: "✅ Branding saved.", ephemeral: true }).catch(() => {});
    }
  }


  
  // ==================================================
  // PREMIUM CUSTOM BUTTONS: select menus + modals + runner
  // ==================================================

  // Select menus for edit/delete
  if (interaction.isStringSelectMenu() && interaction.customId) {
    const cid = interaction.customId;

    }

  // Modals for create/edit
  // Runner for posted buttons
  // ==================================================
  // PREMIUM COMMANDS (submenu) — buttons + modals (locked to panel opener)
  // ==================================================
  if (interaction.isButton() && interaction.customId && interaction.customId.startsWith("premcmd_")) {
    const [action, openerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== openerId) {
      return safeUpdate(interaction, { content: "⛔ Only the person who opened the Premium Panel can use these controls.", ephemeral: true });
    }

    const prem = getPremiumState(interaction.guild.id);
    if (!prem.isPremium) {
      return safeUpdate(interaction, { content: "🔒 Premium is not active for this server.", ephemeral: true }).catch(() => {});
    }

    // toggles
    if (action === "premcmd_toggle_claim") {
      savePremiumState(interaction.guild.id, { features: { autoTagClaims: !prem.features.autoTagClaims } });
      return safeUpdate(interaction, buildPremiumCommandsPayload(interaction.guild, openerId)).catch(() => {});
    }
    if (action === "premcmd_toggle_priority") {
      savePremiumState(interaction.guild.id, { features: { prioritySupport: !prem.features.prioritySupport } });
      return safeUpdate(interaction, buildPremiumCommandsPayload(interaction.guild, openerId)).catch(() => {});
    }

    // ping roles
    if (action === "premcmd_ping_add") {
      const modal = new ModalBuilder().setCustomId(`premcmd_ping_add_modal:${openerId}`).setTitle("Add Ping Role");
      const input = new TextInputBuilder()
        .setCustomId("role")
        .setLabel("Role mention or role ID")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(64)
        .setPlaceholder("@Support or 123456789012345678");
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (action === "premcmd_ping_remove") {
      const modal = new ModalBuilder().setCustomId(`premcmd_ping_remove_modal:${openerId}`).setTitle("Remove Ping Role");
      const input = new TextInputBuilder()
        .setCustomId("role")
        .setLabel("Role mention or role ID")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(64)
        .setPlaceholder("@Support or 123456789012345678");
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (action === "premcmd_ping_clear") {
      savePremiumState(interaction.guild.id, { features: { pingRoleIds: [] } });
      return safeUpdate(interaction, buildPremiumCommandsPayload(interaction.guild, openerId)).catch(() => {});
    }

    // close reasons
    if (action === "premcmd_reason_add") {
      const modal = new ModalBuilder().setCustomId(`premcmd_reason_add_modal:${openerId}`).setTitle("Add Close Reason");
      const input = new TextInputBuilder()
        .setCustomId("reason")
        .setLabel("Reason text (short)")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(200)
        .setPlaceholder("Example: Trade completed successfully.");
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }
    if (action === "premcmd_reason_remove") {
      const modal = new ModalBuilder().setCustomId(`premcmd_reason_remove_modal:${openerId}`).setTitle("Remove Reason");
      const input = new TextInputBuilder()
        .setCustomId("index")
        .setLabel("Reason number to remove (1,2,3...)")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(4)
        .setPlaceholder("1");
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal);
    }

    if (action === "premcmd_refresh") {
      return safeUpdate(interaction, buildPremiumCommandsPayload(interaction.guild, openerId)).catch(() => {});
    }
  }

  if (interaction.isModalSubmit() && interaction.customId && interaction.customId.startsWith("premcmd_")) {
    const [action, openerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== openerId) {
      return safeUpdate(interaction, { content: "⛔ Only the person who opened the Premium Panel can use these controls.", ephemeral: true });
    }

    const prem = getPremiumState(interaction.guild.id);
    if (!prem.isPremium) {
      return safeUpdate(interaction, { content: "🔒 Premium is not active for this server.", ephemeral: true }).catch(() => {});
    }

    const parseRoleId = (raw) => {
      const t = String(raw || "").trim();
      const m1 = t.match(/^<@&(\d{15,25})>$/);
      if (m1) return m1[1];
      const m2 = t.match(/^(\d{15,25})$/);
      if (m2) return m2[1];
      return null;
    };

    if (action === "premcmd_ping_add_modal") {
      const rawRole = interaction.fields.getTextInputValue("role");
      const roleId = parseRoleId(rawRole);
      if (!roleId || !interaction.guild.roles.cache.get(roleId)) {
        return safeUpdate(interaction, { content: "❌ Invalid role. Use a **role mention** or **role ID**.", ephemeral: true });
      }
      const list = Array.isArray(prem.features.pingRoleIds) ? prem.features.pingRoleIds.slice() : [];
      if (!list.includes(roleId)) list.push(roleId);
      savePremiumState(interaction.guild.id, { features: { pingRoleIds: list } });
      return safeUpdate(interaction, { content: `✅ Added ping role <@&${roleId}>`, ephemeral: true }).catch(() => {});
    }

    if (action === "premcmd_ping_remove_modal") {
      const rawRole = interaction.fields.getTextInputValue("role");
      const roleId = parseRoleId(rawRole);
      const list = Array.isArray(prem.features.pingRoleIds) ? prem.features.pingRoleIds.slice() : [];
      const next = list.filter(id => id !== roleId);
      savePremiumState(interaction.guild.id, { features: { pingRoleIds: next } });
      return safeUpdate(interaction, { content: roleId ? `✅ Removed ping role <@&${roleId}>` : "✅ Updated ping roles.", ephemeral: true }).catch(() => {});
    }

    if (action === "premcmd_reason_add_modal") {
      const reason = String(interaction.fields.getTextInputValue("reason") || "").trim();
      if (!reason) return safeUpdate(interaction, { content: "❌ Reason cannot be empty.", ephemeral: true });
      const list = Array.isArray(prem.features.customCloseReasons) ? prem.features.customCloseReasons.slice() : [];
      list.push(reason);
      savePremiumState(interaction.guild.id, { features: { customCloseReasons: list } });
      return safeUpdate(interaction, { content: "✅ Added close reason.", ephemeral: true }).catch(() => {});
    }

    if (action === "premcmd_reason_remove_modal") {
      const raw = String(interaction.fields.getTextInputValue("index") || "").trim();
      const n = parseInt(raw, 10);
      const list = Array.isArray(prem.features.customCloseReasons) ? prem.features.customCloseReasons.slice() : [];
      if (!Number.isFinite(n) || n < 1 || n > list.length) {
        return safeUpdate(interaction, { content: "❌ Invalid number.", ephemeral: true });
      }
      list.splice(n - 1, 1);
      savePremiumState(interaction.guild.id, { features: { customCloseReasons: list } });
      return safeUpdate(interaction, { content: `✅ Removed reason #${n}.`, ephemeral: true }).catch(() => {});
    }
  }


// SETUP PANEL (owner only, per-server) — buttons + selects
  // ==================================================
  if (interaction.isButton() && interaction.customId && interaction.customId.startsWith("setup_")) {
    const [action, ownerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });

    if (interaction.user.id !== ownerId) {
      return safeUpdate(interaction, { content: "⛔ Only the admin who opened this panel can use this panel.", ephemeral: true });
    }


    // Ack immediately so slow disks / JSON writes can't cause "Interaction failed".
    // IMPORTANT: do NOT ack if we are about to open a modal (modals must be the first response).
    const opensModal = (action === "setup_edit_support_desc" || action === "setup_edit_trade_desc");
    if (!opensModal && !interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const guild = interaction.guild;

    // Back to main panel
    if (action === "setup_back") {
      return safeUpdate(interaction, buildSetupMainPayload(guild, ownerId));
    }


    // Toggle features (so nothing gets created/used unless you want it)
    if (action === "setup_toggle_support") {
      const cfg = getGuildConfig(guild.id);
      saveGuildConfig(guild.id, { supportEnabled: !cfg.supportEnabled });
      return safeUpdate(interaction, buildSetupMainPayload(guild, ownerId));
    }

    if (action === "setup_toggle_trade") {
      const cfg = getGuildConfig(guild.id);
      saveGuildConfig(guild.id, { tradeEnabled: !cfg.tradeEnabled });
      return safeUpdate(interaction, buildSetupMainPayload(guild, ownerId));
    }

    if (action === "setup_toggle_logs") {
      const cfg = getGuildConfig(guild.id);
      saveGuildConfig(guild.id, { logsEnabled: !cfg.logsEnabled });
      return safeUpdate(interaction, buildSetupMainPayload(guild, ownerId));
    }

    // Premium settings panel (edit panel descriptions etc.)
    if (action === "setup_premium_settings") {
      const prem = getPremiumState(guild.id);
      if (!prem?.isPremium) {
        return safeUpdate(interaction, { content: "🔒 Premium is not unlocked for this server. Use `?premium-redeem <key>`.", ephemeral: true });
      }

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`setup_edit_support_desc:${ownerId}`).setLabel("Edit Support Description").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`setup_edit_trade_desc:${ownerId}`).setLabel("Edit Trade Description").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`setup_reset_panel_text:${ownerId}`).setLabel("Reset Text").setStyle(ButtonStyle.Danger)
      );

      const embed = new EmbedBuilder()
        .setTitle("⭐ Premium Setup")
        .setColor("#f1c40f")
        .setDescription(
          "Here you can customize your **Support** / **Trade** panel descriptions.\n" +
          "These descriptions are used for the `?support` and `?trade` panels."
        );

      return safeUpdate(interaction, { embeds: [embed], components: [buildSetupBackRow(ownerId), row] });
    }

    if (action === "setup_reset_panel_text") {
      const prem = getPremiumState(guild.id);
      if (!prem?.isPremium) {
        return safeUpdate(interaction, { content: "🔒 Premium is not unlocked for this server.", ephemeral: true });
      }
      const cfg = getGuildConfig(guild.id);
      saveGuildConfig(guild.id, { panelText: { ...cfg.panelText, supportDescription: null, tradeDescription: null } });
      return safeUpdate(interaction, { content: "✅ Panel text reset to defaults.", ephemeral: true }).catch(() => {});
    }

    if (action === "setup_edit_support_desc" || action === "setup_edit_trade_desc") {
      const prem = getPremiumState(guild.id);
      if (!prem?.isPremium) {
        return safeUpdate(interaction, { content: "🔒 Premium is not unlocked for this server.", ephemeral: true });
      }

      const which = action === "setup_edit_support_desc" ? "support" : "trade";
      const cfg = getGuildConfig(guild.id);
      const current = which === "support"
        ? (cfg.panelText?.supportDescription || DEFAULT_SUPPORT_PANEL_DESC)
        : (cfg.panelText?.tradeDescription || DEFAULT_TRADE_PANEL_DESC);

      const modal = new ModalBuilder()
        .setCustomId(`setup_modal_paneldesc_${which}:${ownerId}`)
        .setTitle(which === "support" ? "Edit Support Description" : "Edit Trade Description");

      const input = new TextInputBuilder()
        .setCustomId("desc")
        .setLabel("Panel description")
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
        .setValue(String(current).slice(0, 4000));

      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return interaction.showModal(modal).catch(() => {});
    }


    // Show a category selector for support
    if (action === "setup_set_support") {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`setup_pick_support:${ownerId}`)
          .setPlaceholder("Select Support Category…")
          .addChannelTypes(ChannelType.GuildCategory)
          .setMinValues(1)
          .setMaxValues(1)
      );
      return safeUpdate(interaction, { ...buildSetupMainPayload(guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
    }

    // Show a category selector for Trade
    if (action === "setup_set_mm") {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`setup_pick_mm:${ownerId}`)
          .setPlaceholder("Select Trade Category…")
          .addChannelTypes(ChannelType.GuildCategory)
          .setMinValues(1)
          .setMaxValues(1)
      );
      return safeUpdate(interaction, { ...buildSetupMainPayload(guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
    }

    // Show a log channel selector (text channel)
    if (action === "setup_set_log") {
      const row = new ActionRowBuilder().addComponents(
        new ChannelSelectMenuBuilder()
          .setCustomId(`setup_pick_log:${ownerId}`)
          .setPlaceholder("Select Log Channel…")
          .addChannelTypes(ChannelType.GuildText)
          .setMinValues(1)
          .setMaxValues(1)
      );
      return safeUpdate(interaction, { ...buildSetupMainPayload(guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
    }

    // Choose which role list to edit
    if (action === "setup_set_roles") {
      const row = new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(`setup_roles_step:${ownerId}`)
          .setPlaceholder("Choose which role list to edit…")
          .addOptions([
            { label: "Support roles", value: "support" },
            { label: "Trade roles", value: "trade" },
            { label: "Admin roles", value: "admin" }
          ])
      );
      return safeUpdate(interaction, { ...buildSetupMainPayload(interaction.guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
    }

    if (action === "setup_done") {
      const cfg = getGuildConfig(guild.id);
      const missing = [];

      if (cfg.supportEnabled && !cfg.supportCategoryId) missing.push("Support Category");
      if (cfg.tradeEnabled && !cfg.mmCategoryId) missing.push("Trade Category");
      if (cfg.logsEnabled && !cfg.logChannelId) missing.push("Log Channel");

      if ((cfg.supportEnabled && !cfg.supportRoles?.length) || (cfg.tradeEnabled && !cfg.mmRoles?.length) || !cfg.adminRoles?.length) {
        // We don't block setup for missing roles, but we hint it for new owners.
        // (Admin roles are optional if the server uses "Administrator" permission anyway.)
      }

      return safeUpdate(interaction, {
        embeds: [
          new EmbedBuilder()
            .setTitle("✅ Setup saved")
            .setColor("#2ecc71")
            .setDescription(
              missing.length
                ? `Saved. Missing: **${missing.join(", ")}** (you can run ?setup again anytime)`
                : "Saved. Your server is fully configured ✅"
            )
        ],
        components: []
      });
    }
  }

  // Channel selector picks
  if (interaction.isChannelSelectMenu() && interaction.customId && interaction.customId.startsWith("setup_pick_")) {

    // Ack immediately to avoid 'Interaction failed'
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }
    const [id, ownerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== ownerId) {
      return safeUpdate(interaction, { content: "⛔ Only the setup owner can use this.", ephemeral: true });
    }

    const picked = interaction.values?.[0];
    if (!picked) return safeUpdate(interaction, { content: "Nothing selected.", ephemeral: true });

    if (id === "setup_pick_support") saveGuildConfig(interaction.guild.id, { supportCategoryId: picked });
    if (id === "setup_pick_mm") saveGuildConfig(interaction.guild.id, { mmCategoryId: picked });
    if (id === "setup_pick_log") saveGuildConfig(interaction.guild.id, { logChannelId: picked });

    await safeUpdate(interaction, buildSetupMainPayload(interaction.guild, ownerId)).catch(() => {});

    return safeUpdate(interaction, { content: "✅ Saved!", ephemeral: true }).catch(() => {});
  }

  // Role list chooser
  if (interaction.isStringSelectMenu() && interaction.customId && interaction.customId.startsWith("setup_roles_step:")) {
    // Ack immediately to avoid 'Interaction failed'
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const [, ownerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== ownerId) {
      return safeUpdate(interaction, { content: "⛔ Only the setup owner can use this.", ephemeral: true });
    }

    const which = interaction.values?.[0];
    const row = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`setup_pick_roles:${ownerId}:${which}`)
        .setPlaceholder(`Select ${which} roles…`)
        .setMinValues(0)
        .setMaxValues(25)
    );

    return safeUpdate(interaction, { components: [row] });
  }

  // Role picker
  if (interaction.isRoleSelectMenu() && interaction.customId && interaction.customId.startsWith("setup_pick_roles:")) {
    // Ack immediately to avoid 'Interaction failed'
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate().catch(() => {});
    }

    const parts = interaction.customId.split(":");
    const ownerId = parts[1];
    const which = parts[2];

    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== ownerId) {
      return safeUpdate(interaction, { content: "⛔ Only the setup owner can use this.", ephemeral: true });
    }

    const roleIds = (interaction.values || []).filter(isValidSnowflake);

    if (which === "support") saveGuildConfig(interaction.guild.id, { supportRoles: roleIds });
    if (which === "trade") saveGuildConfig(interaction.guild.id, { mmRoles: roleIds });
    if (which === "admin") saveGuildConfig(interaction.guild.id, { adminRoles: roleIds });

    await safeUpdate(interaction, buildSetupMainPayload(interaction.guild, ownerId)).catch(() => {});

    return safeUpdate(interaction, { content: "✅ Roles saved!", ephemeral: true }).catch(() => {});
  }

  // /add inside ticket
  if (interaction.isChatInputCommand() && interaction.commandName === "add") {
    const user = interaction.options.getUser("user");
    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText || !isTicketChannel(channel)) {
      return safeUpdate(interaction, {
        content: "This command can only be used inside a ticket channel.",
        ephemeral: true
      });
    }

    if (!canManageTicket(interaction.member, channel)) {
      return safeUpdate(interaction, { content: "⛔ You are not allowed to add users to this ticket.", ephemeral: true });
    }

    await channel.permissionOverwrites
      .edit(user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      })
      .catch(() => {});

    await channel.send(`👤 ${interaction.user} added ${user} to this ticket.`).catch(() => {});

    return safeUpdate(interaction, { content: `✅ Added ${user} to this ticket.`, ephemeral: true });
  }

  // toptrade command
  if (interaction.isChatInputCommand() && interaction.commandName === "toptrade") {
    if (!ENABLE_LEADERBOARD) {
      return safeUpdate(interaction, { content: "⛔ The leaderboard feature is disabled on this bot.", ephemeral: true });
    }
    const entries = Object.entries(REVIEWS.trade || {});
    if (!entries.length) {
      return safeUpdate(interaction, { content: "No trade-help reviews yet.", ephemeral: true });
    }

    entries.sort((a, b) => {
      const aa = a[1].avg || 0;
      const bb = b[1].avg || 0;
      if (bb === aa) return (b[1].count || 0) - (a[1].count || 0);
      return bb - aa;
    });

    const top = entries.slice(0, 10);
    const lines = await Promise.all(
      top.map(async ([id, data], idx) => {
        let tag = id;
        try {
          const u = await client.users.fetch(id);
          tag = `${u.tag}`;
        } catch (e) {}
        return `**${idx + 1}.** ${tag} — ⭐ ${data.avg} (${data.count} reviews)`;
      })
    );

    const embed = new EmbedBuilder()
      .setTitle("🏆 Top Trade Helpers")
      .setDescription(lines.join("\n"))
      .setColor("#FFD700");

    return safeUpdate(interaction, { embeds: [embed], ephemeral: false });
  }

  

  // /claim inside ticket
  if (interaction.isChatInputCommand() && interaction.commandName === "claim") {
    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText || !isTicketChannel(channel)) {
      return safeUpdate(interaction, { content: "This command can only be used inside a ticket channel.", ephemeral: true });
    }

    if (!canManageTicket(interaction.member, channel)) {
      return safeUpdate(interaction, { content: "⛔ You are not allowed to claim this ticket.", ephemeral: true });
    }

    const topic = parseTopic(channel.topic);
    if (topic.claimed && topic.claimed !== "null") {
      return safeUpdate(interaction, { content: `⚠️ This ticket is already claimed by <@${topic.claimed}>.`, ephemeral: true });
    }

    const opened = topic.opened || "unknown";
    const newTopic = `opened:${opened};claimed:${interaction.user.id}`;
    await channel.setTopic(newTopic).catch(() => {});

    const prem = getPremiumState(channel.guild.id);
    if (prem.isPremium && prem.features.autoTagClaims) {
      const base = (channel.name || "ticket").replace(/^claimed-+/i, "");
      const nextName = (`claimed-${base}`).slice(0, 90);
      if (nextName && nextName !== channel.name) {
        await channel.setName(nextName).catch(() => {});
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("✅ Ticket Claimed")
      .setDescription(`Claimed by ${interaction.user}\n\nUse \`/unclaim\` to release it.`)
      .setColor("#2ecc71");

    applyBranding(embed, channel.guild.id);

    await safeUpdate(interaction, { embeds: [embed] }).catch(() => {});
  }

  // /unclaim inside ticket
  if (interaction.isChatInputCommand() && interaction.commandName === "unclaim") {
    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText || !isTicketChannel(channel)) {
      return safeUpdate(interaction, { content: "This command can only be used inside a ticket channel.", ephemeral: true });
    }

    if (!canManageTicket(interaction.member, channel)) {
      return safeUpdate(interaction, { content: "⛔ You are not allowed to unclaim this ticket.", ephemeral: true });
    }

    const topic = parseTopic(channel.topic);
    if (!topic.claimed) {
      return safeUpdate(interaction, { content: "⚠️ This ticket is not claimed.", ephemeral: true });
    }

    // If someone else claimed it, only admins can unclaim
    if (topic.claimed !== interaction.user.id && !isAdmin(interaction.member)) {
      return safeUpdate(interaction, { content: `⛔ Only <@${topic.claimed}> or an Admin can unclaim this ticket.`, ephemeral: true });
    }

    const opened = topic.opened || "unknown";
    const newTopic = `opened:${opened};claimed:null`;
    await channel.setTopic(newTopic).catch(() => {});

    const prem = getPremiumState(channel.guild.id);
    if (prem.isPremium && prem.features.autoTagClaims) {
      if ((channel.name || "").toLowerCase().startsWith("claimed-")) {
        const base = channel.name.replace(/^claimed-+/i, "");
        const nextName = (base || "ticket").slice(0, 90);
        await channel.setName(nextName).catch(() => {});
      }
    }

    const embed = new EmbedBuilder()
      .setTitle("🟡 Ticket Unclaimed")
      .setDescription(`Unclaimed by ${interaction.user}`)
      .setColor("#f1c40f");

    applyBranding(embed, channel.guild.id);

    await safeUpdate(interaction, { embeds: [embed] }).catch(() => {});
  }

// /help — open private help panel
  if (interaction.isChatInputCommand() && interaction.commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle(`🐉 ${getPremiumState(interaction.guildId).branding.name} — Help Center`)
      .setColor("#e74c3c")
      .setDescription(`👋 **Hey ${interaction.user.username}!**

Click below to open your **private Help Panel**.
Only **you** can see it.`)
      .setFooter({ text: "Nozzarri Tickets • Secure • Professional" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_help_panel")
        .setLabel("📖 Open Help Panel")
        .setStyle(ButtonStyle.Danger)
    );

    applyBranding(embed, interaction.guildId);
    return safeUpdate(interaction, { embeds: [embed], components: [row], ephemeral: true });
  }

  // /close — close ticket via command (staff only)
  if (interaction.isChatInputCommand() && interaction.commandName === "close") {
    const channel = interaction.channel;
    const member = interaction.member;

    if (!channel || channel.type !== ChannelType.GuildText || !isTicketChannel(channel)) {
      return safeUpdate(interaction, { content: "⛔ Use this only inside a ticket channel.", ephemeral: true });
    }
    if (!canManageTicket(member, channel)) {
      return safeUpdate(interaction, { content: "⛔ You are not allowed to close this ticket.", ephemeral: true });
    }

    const reason = interaction.options.getString("reason") || null;

    await safeUpdate(interaction, { content: "✅ Closing ticket...", ephemeral: true }).catch(() => {});
    await closeTicket(channel, member, reason).catch(console.error);
    return;
  }

  // Dropdown selection -> show modal
  // Dropdown selection -> show modal
  if (interaction.isStringSelectMenu() && interaction.customId && interaction.customId.startsWith("ticket_type:")) {
    const type = interaction.values[0];
    const modal = new ModalBuilder()
      .setCustomId(`modal_${type}`)
      .setTitle(type === "support" ? "🛠️ Support Ticket" : "🤝 Trade Ticket");

    const playerInput = new TextInputBuilder()
      .setCustomId("player")
      .setLabel("Username of the other party")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    const detailInput = new TextInputBuilder()
      .setCustomId("details")
      .setLabel(type === "support" ? "Describe your issue" : "Describe the trade")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);

    modal.addComponents(
      new ActionRowBuilder().addComponents(playerInput),
      new ActionRowBuilder().addComponents(detailInput)
    );

    // Show modal. If user cancels (X), Discord keeps the last selected option visually.
    // So we "reset" the menu back to placeholder after we open the modal, to prevent it bugging out.
    await interaction.showModal(modal);
    setTimeout(async () => {
      try {
        const row = type === "support" ? buildSupportMenu() : buildTradeMenu();
        if (interaction.message && interaction.message.edit) {
          await interaction.message.edit({ components: [row] }).catch(() => {});
        }
      } catch {}
    }, 250);
    return;
  }


  // ==================================================
  // SETUP PANEL — premium modals (edit panel descriptions)
  // ==================================================
  if (interaction.isModalSubmit() && interaction.customId && interaction.customId.startsWith("setup_modal_paneldesc_")) {
    const [id, ownerId] = interaction.customId.split(":");
    if (!interaction.guild) return safeUpdate(interaction, { content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== ownerId) {
      return safeUpdate(interaction, { content: "⛔ Only the setup owner can use this.", ephemeral: true });
    }

    const prem = getPremiumState(interaction.guild.id);
    if (!prem?.isPremium) {
      return safeUpdate(interaction, { content: "🔒 Premium is not unlocked for this server.", ephemeral: true });
    }

    const which = id.replace("setup_modal_paneldesc_", ""); // support | trade
    const desc = interaction.fields.getTextInputValue("desc");

    const cfg = getGuildConfig(interaction.guild.id);
    const nextPanel = { ...cfg.panelText };
    if (which === "support") nextPanel.supportDescription = desc;
    if (which === "trade") nextPanel.tradeDescription = desc;

    saveGuildConfig(interaction.guild.id, { panelText: nextPanel });

    return safeUpdate(interaction, { content: "✅ Saved! Your panel text was updated.", ephemeral: true }).catch(() => {});
  }

  // Modal submit -> create ticket
  if (
    interaction.isModalSubmit() &&
    (interaction.customId === "modal_support" || interaction.customId === "modal_trade")
  ) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const type = interaction.customId === "modal_support" ? "Support" : "Trade";
    const player = interaction.fields.getTextInputValue("player");
    const details = interaction.fields.getTextInputValue("details");

    const guild = interaction.guild;

// Validate that this server is configured for this ticket type
const needs = {
  support: type === "Support",
  trade: type === "Trade",
  logs: true
};

const ensured = await ensureDefaultSetup(guild, needs);
if (!ensured.ok) {
  const reason = ensured.reason || "NOT_CONFIGURED";
  let msg = "❌ Ticket system is not configured correctly. Ask the server owner to run `?setup`.";

  if (reason === "SUPPORT_DISABLED") msg = "❌ **Support tickets are disabled** in this server. Ask the owner to enable Support in `?setup`.";
  if (reason === "TRADE_DISABLED") msg = "❌ **Trade tickets are disabled** in this server. Ask the owner to enable Trade in `?setup`.";

  if (reason === "MISSING_SUPPORT_CATEGORY_ID" || reason === "INVALID_SUPPORT_CATEGORY_ID") {
    msg = "❌ Support category is not set (or invalid). Server owner: run `?setup` → enable Support → set Support Category.";
  }
  if (reason === "MISSING_TRADE_CATEGORY_ID" || reason === "INVALID_TRADE_CATEGORY_ID") {
    msg = "❌ Trade category is not set (or invalid). Server owner: run `?setup` → enable Trade → set Trade Category.";
  }
  if (reason === "MISSING_LOG_CHANNEL_ID" || reason === "INVALID_LOG_CHANNEL_ID") {
    msg = "❌ Log channel is enabled but not set (or invalid). Server owner: run `?setup` → enable Logs → set Log Channel (or disable Logs).";
  }

  return safeUpdate(interaction, { content: msg }).catch(() => {});
}

const cfg = ensured.cfg;
const categoryId = type === "Support" ? cfg.supportCategoryId : cfg.mmCategoryId;


    try {
      const rolesToCheck = [
        ...(Array.isArray(cfg.supportRoles) ? cfg.supportRoles : []),
        ...(Array.isArray(cfg.mmRoles) ? cfg.mmRoles : []),
        ...(Array.isArray(cfg.adminRoles) ? cfg.adminRoles : [])
      ];
      await ensureRolesCached(guild, rolesToCheck);

      const basePerms = [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.ReadMessageHistory
      ];

      const overwrites = [
        {
          id: guild.id,
          deny: [PermissionFlagsBits.ViewChannel]
        },
        {
          id: interaction.user.id,
          allow: basePerms
        }
      ];

      if (type === "Support") {
        overwrites.push(
          ...buildRoleOverwrites(guild, cfg.supportRoles || [], basePerms),
          ...buildRoleOverwrites(guild, cfg.adminRoles || [], basePerms)
        );
      } else {
        overwrites.push(
          ...buildRoleOverwrites(guild, cfg.mmRoles || [], basePerms),
          ...buildRoleOverwrites(guild, cfg.supportRoles || [], basePerms),
          ...buildRoleOverwrites(guild, cfg.adminRoles || [], basePerms)
        );
      }

      const pState = getPremiumState(guild.id);
      const template = (pState.isPremium && pState.features.ticketNameTemplate) ? pState.features.ticketNameTemplate : "ticket-{user}";
      const desiredName = sanitizeChannelName(
        formatTemplate(template, {
          user: interaction.user.username,
          type: type.toLowerCase(),
          id: interaction.user.id
        })
      );

      const channel = await guild.channels.create({
        name: desiredName,
        type: ChannelType.GuildText,
        parent: categoryId,
        permissionOverwrites: overwrites
      });

      await channel.setTopic(makeTopic(interaction.user.id)).catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle(type === "Support" ? `🛠️ ${getPremiumState(guild.id).branding.name} — Support Ticket` : `🤝 ${getPremiumState(guild.id).branding.name} — Trade Ticket`)
        .setColor(type === "Support" ? "#3498db" : "#9b59b6")
        .addFields(
          { name: "Opened by", value: interaction.user.tag, inline: true },
          { name: "Other party", value: player, inline: true },
          { name: type === "Support" ? "Issue" : "Trade", value: details }
        )
        .setFooter({ text: "A staff member will claim this ticket shortly." })
        .setTimestamp();

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("claim_ticket").setLabel("🎯 Claim").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("close_ticket").setLabel("❌ Close").setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("close_with_reason")
          .setLabel("📝 Close with Reason")
          .setStyle(ButtonStyle.Secondary)
      );

      const mention = renderTicketPingMention(guild.id, type === "Support" ? "support" : "trade");
      if (mention) await channel.send(mention).catch(() => {});
      applyBranding(embed, guild.id);
      await channel.send({ embeds: [embed], components: [row] });

      // Premium: optional custom welcome message in the ticket channel
      try{
        const pNow = getPremiumState(guild.id);
        if (pNow.isPremium && pNow.features.welcomeMessage && pNow.features.welcomeMessage.trim()){
          const msg = pNow.features.welcomeMessage
            .replace(/\{user\}/g, `<@${interaction.user.id}>`)
            .replace(/\{type\}/g, type);
          await channel.send(msg).catch(() => {});
        }
      }catch{}

      // Premium: optional auto-close after X minutes (simple timer; resets if bot restarts)
      try{
        const pNow = getPremiumState(guild.id);
        const mins = pNow.isPremium ? normalizeMinutes(pNow.features.autoCloseMinutes) : 0;
        if (mins > 0){
          setTimeout(async ()=>{
            try{
              const ch = await guild.channels.fetch(channel.id).catch(() => null);
              if (!ch) return;
              const me = guild.members.me || (await guild.members.fetchMe().catch(() => null));
              if (!me) return;
              await closeTicket(ch, me, `Auto-close after ${mins} minutes`).catch(() => {});
            }catch{}
          }, mins * 60 * 1000);
        }
      }catch{}

      const logEmbed = new EmbedBuilder()
        .setTitle("📥 Ticket Created")
        .setColor("#2ecc71")
        .addFields(
          { name: "Type", value: type, inline: true },
          { name: "Opened by", value: `${interaction.user.tag} (${interaction.user.id})`, inline: true },
          { name: "Channel", value: `${channel.name} (${channel.id})`, inline: true },
          { name: "Other party / Details", value: `${player} — ${details}` }
        )
        .setTimestamp();
      await sendLog(guild, logEmbed);

      // keep your menu reset logic
      try {
        const msgs = await interaction.channel.messages.fetch({ limit: 50 }).catch(() => null);
        if (msgs) {
          const newMenuRow = type === "Support" ? buildSupportMenu() : buildTradeMenu();
          for (const m of msgs.values()) {
            if (m.author && m.author.id === client.user.id && m.components && m.components.length) {
              const hasSelect = m.components.some(c =>
                c.components && c.components.some(inner => (inner.customId || "").startsWith("ticket_type:"))
              );
              if (hasSelect) {
                await m.edit({ components: [newMenuRow] }).catch(() => {});
                break;
              }
            }
          }
        }
      } catch (e) {
        console.error("Failed to reset original ticket menu:", e);
      }

      await safeUpdate(interaction, {
        content: `✅ Your ${type} ticket has been created: ${channel}`
      }).catch(() => {});
    } catch (err) {
      console.error("Ticket create error:", err);
      await safeUpdate(interaction, {
        content:
          "❌ I couldn't create the ticket channel.\n" +
          "Most common reason: one of your role IDs/category IDs is wrong or not in this server.\n" +
          "Run `?setup` (server owner) to configure categories/roles for THIS server, and set the categories/roles for THIS server."
      }).catch(() => {});
    }
  }

  // Claim ticket
  // ✅ FIX: ack immediately (prevents Unknown interaction 10062 / interaction failed)
  if (interaction.isButton() && interaction.customId === "claim_ticket") {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const member = interaction.member;
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      return safeUpdate(interaction, { content: "❌ Invalid channel." }).catch(() => {});
    }

    if (!canManageTicket(member, channel)) {
      return safeUpdate(interaction, {
        content: "⛔ You do not have permission to claim this ticket."
      }).catch(() => {});
    }

    const t = parseTopic(channel.topic);
    if (t.claimed) {
      return safeUpdate(interaction, {
        content: "⚠️ This ticket is already claimed."
      }).catch(() => {});
    }

    await channel.setTopic(makeTopic(t.opened, member.user.id)).catch(() => {});

    const lastMsg = await channel.messages
      .fetch({ limit: 1 })
      .then(c => c.first())
      .catch(() => null);

    if (lastMsg && lastMsg.author.id === client.user.id && lastMsg.components.length) {
      const oldRow = lastMsg.components[0];
      const buttons = oldRow.components.map(b => ButtonBuilder.from(b));
      const claimIdx = buttons.findIndex(b => b.data.custom_id === "claim_ticket");
      if (claimIdx !== -1) {
        buttons[claimIdx].setLabel("🎯 Claimed").setStyle(ButtonStyle.Secondary).setDisabled(true);
      }
      const newRow = new ActionRowBuilder().addComponents(...buttons);

      const newEmbed = lastMsg.embeds[0]
        ? EmbedBuilder.from(lastMsg.embeds[0]).setFooter({ text: `Claimed by ${member.user.tag}` })
        : null;

      await lastMsg.edit({ embeds: newEmbed ? [newEmbed] : undefined, components: [newRow] }).catch(() => {});
    }

    const logEmbed = new EmbedBuilder()
      .setTitle("📌 Ticket Claimed")
      .setColor("#f1c40f")
      .addFields(
        { name: "Channel", value: `${channel.name} (${channel.id})`, inline: true },
        { name: "Claimed by", value: `${member.user.tag} (${member.user.id})`, inline: true }
      )
      .setTimestamp();
    await sendLog(channel.guild, logEmbed);

    await channel.send(`🎯 Ticket claimed by **${member.user.tag}**`).catch(() => {});
    return safeUpdate(interaction, { content: "✅ You claimed this ticket." }).catch(() => {});
  }

  // Close ticket (no reason)
  if (interaction.isButton() && interaction.customId === "close_ticket") {
    const member = interaction.member;
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) return;

    if (!canManageTicket(member, channel)) {
      return safeUpdate(interaction, {
        content: "⛔ You are not allowed to close this ticket.",
        ephemeral: true
      });
    }

    // reply instantly so Discord doesn’t show “interaction failed”
    await safeUpdate(interaction, { content: "✅ Closing ticket...", ephemeral: true }).catch(() => {});
    // unified close logic
    await closeTicket(interaction.channel, member, null).catch(() => {});
    return;

    // (legacy close logic kept for backwards compatibility)
    if (false) {

    const { opened, claimed } = parseTopic(channel.topic);
    await dmSummaryAndRating(opened, claimed, member.user.tag, null).catch(() => {});

    const logEmbed = new EmbedBuilder()
      .setTitle("🗑️ Ticket Closed")
      .setColor("#e74c3c")
      .addFields(
        { name: "Channel", value: `${channel.name} (${channel.id})`, inline: true },
        { name: "Closed by", value: `${member.user.tag} (${member.user.id})`, inline: true },
        { name: "Claimed by", value: claimed ? `${claimed}` : "Not claimed", inline: true }
      )
      .setTimestamp();
    await sendLog(channel.guild, logEmbed);

    await channel.send("✅ Ticket will be closed.").catch(() => {});
    setTimeout(() => channel.delete().catch(() => {}), 2000);
    }

  }

  // Close with reason (modal + confirmation)
  if (interaction.isButton() && interaction.customId === "close_with_reason") {
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      return safeUpdate(interaction, { content: "⛔ Invalid channel.", ephemeral: true });
    }
    if (!canManageTicket(interaction.member, channel)) {
      return safeUpdate(interaction, {
        content: "⛔ Only authorized staff can close with a reason.",
        ephemeral: true
      });
    }

    const modal = new ModalBuilder()
      .setCustomId("modal_close_reason")
      .setTitle("📝 Close Ticket With Reason");
    const reasonInput = new TextInputBuilder()
      .setCustomId("reason")
      .setLabel("Reason for closing")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);
    modal.addComponents(new ActionRowBuilder().addComponents(reasonInput));
    return interaction.showModal(modal);
  }

  // Handle reason modal submit
  // Handle reason modal submit
  if (interaction.isModalSubmit() && interaction.customId === "modal_close_reason") {
    const reason = interaction.fields.getTextInputValue("reason");
    const member = interaction.member;
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) {
      return safeUpdate(interaction, { content: "⛔ Invalid channel.", ephemeral: true }).catch(() => {});
    }

    if (!canManageTicket(member, channel)) {
      return safeUpdate(interaction, {
        content: "⛔ You are not allowed to close this ticket.",
        ephemeral: true
      }).catch(() => {});
    }

    await safeUpdate(interaction, { content: "📝 Closing with reason...", ephemeral: true }).catch(() => {});
    await closeTicket(channel, member, reason).catch(() => {});
    return;
  }

    const { opened, claimed } = parseTopic(channel.topic);

    await closeTicket(channel, member, reason).catch(() => {});
    return;

    // (legacy close-with-reason logic kept)
    if (false) {
          const logEmbed = new EmbedBuilder()
      .setTitle("🗑️ Ticket Closed (With Reason)")
      .setColor("#e74c3c")
      .addFields(
        { name: "Channel", value: `${channel.name} (${channel.id})`, inline: true },
        { name: "Closed by", value: `${member.user.tag} (${member.user.id})`, inline: true },
        { name: "Claimed by", value: claimed ? `${claimed}` : "Not claimed", inline: true },
        { name: "Reason", value: reason }
      )
      .setTimestamp();
    await sendLog(channel.guild, logEmbed);

    await channel.send("✅ Ticket closed with reason.").catch(() => {});
    setTimeout(() => channel.delete().catch(() => {}), 2000);

    return safeUpdate(interaction, { content: "📝 Closing with reason...", ephemeral: true });
  }

  // Handle rating button clicks from DM
  if (interaction.isButton() && interaction.customId && interaction.customId.startsWith("rate:")) {
    const parts = interaction.customId.split(":");
    const kind = parts[1]; // trade or service
    try {
      if (kind === "trade" || kind === ("m" + "m")) {
        const ticketName = parts[2];
        const staffId = parts[3];
        const score = parseInt(parts[4], 10);
        if (!ticketName || !staffId || !score) {
          return safeUpdate(interaction, { content: "Invalid rating data.", ephemeral: true });
        }
        const key = `${ticketName}_${interaction.user.id}_mm`;
        if (RATED[key]) {
          return safeUpdate(interaction, {
            content: "You already rated this Trade Help for this ticket.",
            ephemeral: true
          });
        }
        addReviewForStaff(staffId, score);
        RATED[key] = true;
        writeJsonSafe(RATED_FILE, RATED);

        try {
          const msg = interaction.message;
          if (msg && msg.components) {
            const newComps = msg.components.map(r => {
              const ar = ActionRowBuilder.from(r);
              const comps = ar.components.map(c => ButtonBuilder.from(c).setDisabled(true));
              return new ActionRowBuilder().addComponents(...comps);
            });
            await msg.edit({ components: newComps }).catch(() => {});
          }
        } catch (e) {
          console.error("Failed to disable trade buttons:", e);
        }

        await safeUpdate(interaction, {
          content: `Thanks — you rated the Trade Help ${score} ⭐`,
          ephemeral: true
        });
      } else if (kind === "service") {
        const ticketName = parts[2];
        const score = parseInt(parts[3], 10);
        if (!ticketName || !score) {
          return safeUpdate(interaction, { content: "Invalid rating data.", ephemeral: true });
        }
        const key = `${ticketName}_${interaction.user.id}_service`;
        if (RATED[key]) {
          return safeUpdate(interaction, {
            content: "You already rated the service for this ticket.",
            ephemeral: true
          });
        }
        addReviewForService(score);
        RATED[key] = true;
        writeJsonSafe(RATED_FILE, RATED);

        try {
          const msg = interaction.message;
          if (msg && msg.components) {
            const newComps = msg.components.map(r => {
              const ar = ActionRowBuilder.from(r);
              const comps = ar.components.map(c => ButtonBuilder.from(c).setDisabled(true));
              return new ActionRowBuilder().addComponents(...comps);
            });
            await msg.edit({ components: newComps }).catch(() => {});
          }
        } catch (e) {
          console.error("Failed to disable service buttons:", e);
        }

        await safeUpdate(interaction, {
          content: `Thanks — you rated our service ${score} ⭐`,
          ephemeral: true
        });
      } else {
        return safeUpdate(interaction, { content: "Unknown rating type.", ephemeral: true });
      }
    } catch (e) {
      console.error("Rate handler error:", e);
      return safeUpdate(interaction, { content: "Failed to record rating.", ephemeral: true });
    }
  }
});

// ----------------------
// DM summary + rating UI
// ----------------------
async function dmSummaryAndRating(openerId, claimedId, closerTag, reason = null) {
  // Disabled by user request
  if (DISABLE_CLOSE_DMS) return;
  try {
    const opener = await client.users.fetch(openerId).catch(() => null);
    if (!opener) return;

    const claimedUser = claimedId ? await client.users.fetch(claimedId).catch(() => null) : null;

    const embed = new EmbedBuilder()
      .setTitle(reason ? "🎫 Ticket Closed (With Reason)" : "🎫 Ticket Closed")
      .setDescription(
        `Summary:\n` +
          `• Claimed by: **${claimedUser ? claimedUser.tag : "Not claimed"}**\n` +
          `• Closed by: **${closerTag}**\n` +
          `• Time: <t:${Math.floor(Date.now() / 1000)}:F>\n` +
          (reason ? `• Reason: ${reason}\n` : "")
      )
      .setColor("#E74C3C");

    await opener.send({ embeds: [embed] }).catch(() => {});

    const ticketNameStub = `ticket-${opener.username}`.toLowerCase();

    let components = [];
    if (claimedId) {
      const mmRow = new ActionRowBuilder();
      for (let s = 1; s <= 5; s++) {
        mmRow.addComponents(
          new ButtonBuilder()
            .setCustomId(`rate:trade:${ticketNameStub}:${claimedId}:${s}`)
            .setLabel("★".repeat(s))
            .setStyle(ButtonStyle.Primary)
        );
      }
      components.push(mmRow);
    }

    const svcRow = new ActionRowBuilder();
    for (let s = 1; s <= 5; s++) {
      svcRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`rate:service:${ticketNameStub}:${s}`)
          .setLabel("★".repeat(s))
          .setStyle(ButtonStyle.Secondary)
      );
    }
    components.push(svcRow);

    const promptEmbed = new EmbedBuilder()
      .setTitle("✳️ Please rate")
      .setDescription(
        `${
          claimedUser
            ? `Rate the Trade Help **${claimedUser.tag}** (first row) and our service (second row).`
            : `Rate our service (only row).`
        }\n\nClick the star row corresponding to the number of stars you want to give.`
      )
      .setColor("#5865F2");

    await opener.send({ embeds: [promptEmbed], components }).catch(() => {});
  } catch (e) {
    console.error("dmSummaryAndRating error:", e);
  }
}


// ======================================================
// DASHBOARD (Web Panel)
// ======================================================
// ✅ This does NOT replace your website. This is the "backend" part your site can talk to.
// It lets users login with Discord, see servers they manage, and change your bot settings.
// Your website can just link to this dashboard URL.
//
// Required .env for dashboard:
// DASHBOARD_URL=https://your-domain.com        (or http://localhost:3000 for testing)
// DASHBOARD_PORT=3000
// DASHBOARD_SESSION_SECRET=some_long_random_string
// OAUTH_REDIRECT_URI=https://your-domain.com/auth/discord/callback
// (CLIENT_ID already exists)
// CLIENT_SECRET=your_discord_app_client_secret
//
// Optional:
// DASHBOARD_ALLOWED_GUILDS= (comma separated) to limit which guilds show up (leave empty to allow all)
// DASHBOARD_REQUIRE_PREMIUM=false (if true, only premium guilds can use dashboard edit pages)

function startDashboardServer() {
  const DASHBOARD_PORT = Number(process.env.DASHBOARD_PORT || 3000);
  const DASHBOARD_URL = (process.env.DASHBOARD_URL || `http://localhost:${DASHBOARD_PORT}`).replace(/\/+$/, "");
  const CLIENT_SECRET = process.env.CLIENT_SECRET;
  const OAUTH_REDIRECT_URI = process.env.OAUTH_REDIRECT_URI || `${DASHBOARD_URL}/auth/discord/callback`;
  const SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET || crypto.randomBytes(32).toString("hex");

  const REQUIRE_PREMIUM = String(process.env.DASHBOARD_REQUIRE_PREMIUM || "false").toLowerCase() === "true";
  const ALLOWED_GUILDS = (process.env.DASHBOARD_ALLOWED_GUILDS || "")
    .split(",")
    .map(s => s.trim())
    .filter(Boolean);

  if (!clientId) {
    console.error("[DASHBOARD] CLIENT_ID missing (set in .env). Dashboard not started.");
    return;
  }
  if (!CLIENT_SECRET) {
    console.error("[DASHBOARD] CLIENT_SECRET missing in .env. Dashboard not started.");
    return;
  }

  const app = express();
  app.set("trust proxy", 1);
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());

  app.use(session({
    name: "tkdash.sid",
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: DASHBOARD_URL.startsWith("https://"),
      maxAge: 1000 * 60 * 60 * 24 * 7 // 7 days
    }
  }));

  function isLogged(req) {
    return !!(req.session && req.session.user && req.session.access_token);
  }

  function requireLogin(req, res, next) {
    if (!isLogged(req)) return res.redirect("/dashboard");
    next();
  }

  function hasManageGuild(g) {
    // Discord returns "permissions" as a string number.
    // Manage Guild permission bit = 0x20 (32)
    try {
      const p = BigInt(g.permissions);
      return (p & 32n) === 32n;
    } catch {
      return false;
    }
  }

  function allowGuildId(guildId) {
    if (!ALLOWED_GUILDS.length) return true;
    return ALLOWED_GUILDS.includes(String(guildId));
  }

  function htmlPage(title, body) {
    // Single-file dashboard UI template (no external assets required)
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="theme-color" content="#0b0d14"/>
<title>${escapeHtml(title)}</title>
<style>
  :root{
    --bg0:#07080c;
    --bg1:#0b0d14;
    --card: rgba(18, 22, 36, .78);
    --card2: rgba(12, 14, 22, .55);
    --text:#e6edf3;
    --muted:#9aa4b2;
    --line: rgba(255,255,255,.10);
    --shadow: 0 18px 60px rgba(0,0,0,.55);
    --acc:#f5b301;
    --acc2:#ff4d9d;
    --acc3:#4dd6ff;
    --radius: 18px;
  }

  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0;
    font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, "Apple Color Emoji","Segoe UI Emoji";
    color:var(--text);
    background:
      radial-gradient(1200px 650px at 18% 10%, rgba(245,179,1,.14), transparent 55%),
      radial-gradient(900px 520px at 82% 24%, rgba(255,77,157,.13), transparent 60%),
      radial-gradient(1100px 700px at 60% 92%, rgba(77,214,255,.10), transparent 55%),
      linear-gradient(180deg, var(--bg1), var(--bg0));
    overflow-x:hidden;
  }

  /* Animated orbs (subtle, optional) */
  .orbs{position:fixed; inset:-40px; pointer-events:none; z-index:0; filter: blur(26px); opacity:.75}
  .orb{position:absolute; width:520px; height:520px; border-radius:50%; background: radial-gradient(circle at 30% 30%, rgba(245,179,1,.55), rgba(245,179,1,0) 65%); animation: float 14s ease-in-out infinite}
  .orb.o2{width:640px; height:640px; left:auto; right:-160px; top:40px; background: radial-gradient(circle at 30% 30%, rgba(255,77,157,.52), rgba(255,77,157,0) 65%); animation-duration: 18s}
  .orb.o3{width:680px; height:680px; top:auto; bottom:-260px; left:18%; background: radial-gradient(circle at 35% 35%, rgba(77,214,255,.45), rgba(77,214,255,0) 65%); animation-duration: 20s}

  @keyframes float{
    0%,100%{transform: translate3d(0,0,0) scale(1)}
    50%{transform: translate3d(22px,-18px,0) scale(1.06)}
  }

  /* Layout */
  .wrap{position:relative; z-index:1; max-width:1100px; margin:0 auto; padding:26px}
  .top{
    display:flex; align-items:center; justify-content:space-between;
    gap:14px; margin-bottom:18px;
  }

  /* Brand */
  .brand{
    display:flex; align-items:center; gap:10px;
    font-weight:900; letter-spacing:.5px;
    user-select:none;
  }
  .brand .dot{
    width:12px; height:12px; border-radius:50%;
    background: linear-gradient(135deg, var(--acc), var(--acc2));
    box-shadow: 0 0 28px rgba(245,179,1,.28);
  }

  /* Pills / buttons */
  a{color:inherit; text-decoration:none}
  .pill{
    display:inline-flex; align-items:center; gap:10px;
    padding:8px 12px;
    border-radius:999px;
    border:1px solid var(--line);
    background: rgba(255,255,255,.04);
    backdrop-filter: blur(10px);
    transition: transform .15s ease, border-color .15s ease, background .15s ease;
  }
  .pill:hover{transform: translateY(-1px); border-color: rgba(245,179,1,.35); background: rgba(255,255,255,.06)}
  .btn{
    display:inline-flex; align-items:center; justify-content:center;
    padding:10px 14px;
    border-radius:14px;
    border:1px solid var(--line);
    background: linear-gradient(180deg, rgba(255,255,255,.09), rgba(255,255,255,.03));
    cursor:pointer;
    transition: transform .15s ease, border-color .15s ease, filter .15s ease;
    backdrop-filter: blur(10px);
  }
  .btn:hover{transform: translateY(-1px); border-color: rgba(245,179,1,.35); filter: brightness(1.05)}
  .btn:active{transform: translateY(0px) scale(.99)}
  .btn.primary{
    border-color: rgba(245,179,1,.40);
    background: linear-gradient(180deg, rgba(245,179,1,.24), rgba(245,179,1,.08));
    box-shadow: 0 12px 40px rgba(245,179,1,.08);
  }
  .btn.danger{border-color: rgba(255,77,157,.38); background: linear-gradient(180deg, rgba(255,77,157,.18), rgba(255,77,157,.06))}
  .btn.small{padding:8px 10px; border-radius:12px; font-size:13px}

  /* Cards / grid */
  .grid{display:grid; grid-template-columns: repeat(12, 1fr); gap:14px}
  .card{
    grid-column: span 12;
    background: linear-gradient(180deg, rgba(255,255,255,.08), rgba(255,255,255,.03));
    border:1px solid var(--line);
    border-radius: var(--radius);
    padding:16px;
    box-shadow: var(--shadow);
    backdrop-filter: blur(14px);
    transform: translateZ(0);
    animation: pop .35s ease both;
  }
  .card::before{
    content:"";
    position:absolute; inset:0;
    border-radius: var(--radius);
    pointer-events:none;
    background: radial-gradient(1200px 120px at 20% 0%, rgba(245,179,1,.10), transparent 50%);
    opacity:.8;
  }
  .card > *{position:relative}
  @keyframes pop{from{opacity:0; transform: translateY(6px)} to{opacity:1; transform: translateY(0)}}
  @media(min-width:900px){.card.half{grid-column: span 6}}

  h1{margin:0 0 10px; font-size:28px}
  h2{margin:0 0 10px; font-size:18px}
  .muted{color:var(--muted)}

  .list{display:flex; flex-direction:column; gap:10px; margin-top:10px}
  .row{
    display:flex; align-items:center; justify-content:space-between; gap:10px;
    padding:12px; border-radius:14px;
    border:1px solid var(--line);
    background: rgba(0,0,0,.18);
    transition: transform .15s ease, border-color .15s ease, background .15s ease;
  }
  .row:hover{border-color: rgba(245,179,1,.30); transform: translateY(-1px); background: rgba(0,0,0,.22)}
  .badge{
    font-size:12px; padding:4px 10px; border-radius:999px;
    border:1px solid var(--line);
    background: rgba(255,255,255,.04)
  }

  input,select,textarea{
    width:100%;
    padding:10px 12px;
    border-radius:14px;
    border:1px solid var(--line);
    background: rgba(0,0,0,.25);
    color: var(--text);
    outline:none;
    transition: border-color .15s ease, background .15s ease;
  }
  input:focus,select:focus,textarea:focus{border-color: rgba(245,179,1,.40); background: rgba(0,0,0,.30)}
  label{font-size:13px; color:var(--muted); display:block; margin:10px 0 6px}
  .two{display:grid; grid-template-columns: 1fr; gap:12px}
  @media(min-width:900px){.two{grid-template-columns: 1fr 1fr}}

  /* Flash -> toast-like */
  .flash{
    padding:10px 12px;
    border-radius:14px;
    border:1px solid rgba(245,179,1,.28);
    background: rgba(245,179,1,.08);
    margin-bottom:10px;
  }
  .toast{
    position:fixed; right:18px; bottom:18px;
    max-width:min(420px, calc(100vw - 36px));
    z-index:50;
  }
  .toast .flash{box-shadow: var(--shadow); animation: toastIn .25s ease both}
  @keyframes toastIn{from{opacity:0; transform: translateY(10px)} to{opacity:1; transform: translateY(0)}}

  /* Reduce motion preference */
  @media (prefers-reduced-motion: reduce){
    .orb,.card,.toast .flash{animation:none !important}
    .pill,.btn,.row{transition:none !important}
  }
</style>
</head>
<body>
  <div class="orbs" aria-hidden="true">
    <div class="orb o1" style="left:-180px; top:-140px;"></div>
    <div class="orb o2"></div>
    <div class="orb o3"></div>
  </div>

  <div class="wrap">
    <div class="top">
      <div class="brand"><span class="dot"></span><span>Ticket Dashboard</span></div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:flex-end">
        <a class="pill" href="/dashboard">Home</a>
        <a class="pill" href="/servers">Servers</a>
        <a class="pill" href="/logout">Logout</a>
      </div>
    </div>

    ${body}

    <div style="margin-top:18px" class="muted">© ${new Date().getFullYear()} Ticket Dashboard</div>
  </div>

<script>
(() => {
  // Move any inline .flash messages to a toast so it looks cleaner.
  const flash = document.querySelector('.flash');
  if (flash) {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.appendChild(flash);
    document.body.appendChild(toast);
    setTimeout(() => { flash.style.opacity = '0'; flash.style.transition = 'opacity .25s ease'; }, 4200);
    setTimeout(() => { toast.remove(); }, 4700);
  }
})();
</script>
</body>
</html>`;
  }


function escapeHtml(s){
    return String(s ?? "")
      .replaceAll("&","&amp;")
      .replaceAll("<","&lt;")
      .replaceAll(">","&gt;")
      .replaceAll('"',"&quot;")
      .replaceAll("'","&#039;");
  }

  async function discordApi(token, path, opts = {}) {
    const res = await fetchFn(`https://discord.com/api/v10${path}`, {
      ...opts,
      headers: {
        "Authorization": `Bearer ${token}`,
        ...(opts.headers || {})
      }
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Discord API error ${res.status}: ${t}`);
    }
    return res.json();
  }

  app.get("/dashboard", async (req, res) => {
    const flash = req.session.flash;
    req.session.flash = null;

    if (!isLogged(req)) {
      const authUrl =
        `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}` +
        `&redirect_uri=${encodeURIComponent(OAUTH_REDIRECT_URI)}` +
        `&response_type=code&scope=identify%20guilds`;

      return res.send(htmlPage("Dashboard", `
        <div class="grid">
          <div class="card">
            ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}
            <h1>Dashboard Login</h1>
            <p class="muted">Login with Discord to manage your bot settings per server.</p>
            <a class="btn primary" href="${authUrl}">Login with Discord</a>
          </div>
        </div>
      `));
    }

    const user = req.session.user;
    res.send(htmlPage("Dashboard", `
      <div class="grid">
        <div class="card half">
          <h2>Logged in</h2>
          <div class="row">
            <div>
              <div style="font-weight:700">${escapeHtml(user.username)}#${escapeHtml(user.discriminator || "0")}</div>
              <div class="muted">Discord user</div>
            </div>
            <a class="btn" href="/servers">Open Servers</a>
          </div>
        </div>
        <div class="card half">
          <h2>Bot Status</h2>
          <div class="row">
            <div>
              <div style="font-weight:700">${escapeHtml(client.user?.tag || "Online")}</div>
              <div class="muted">Connected as your bot</div>
            </div>
            <span class="pill">✅ Online</span>
          </div>
        </div>
      </div>
    `));
  });

  app.get("/auth/discord/callback", async (req, res) => {
    const code = req.query.code;
    if (!code) return res.redirect("/dashboard");

    try {
      const body = new URLSearchParams();
      body.set("client_id", clientId);
      body.set("client_secret", CLIENT_SECRET);
      body.set("grant_type", "authorization_code");
      body.set("code", String(code));
      body.set("redirect_uri", OAUTH_REDIRECT_URI);

      const tokenRes = await fetchFn("https://discord.com/api/v10/oauth2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body
      });

      const tokenJson = await tokenRes.json();
      if (!tokenRes.ok) throw new Error(JSON.stringify(tokenJson));

      req.session.access_token = tokenJson.access_token;

      // fetch user + guilds
      const user = await discordApi(req.session.access_token, "/users/@me");
      const guilds = await discordApi(req.session.access_token, "/users/@me/guilds");

      req.session.user = user;
      req.session.guilds = guilds;

      return res.redirect("/servers");
    } catch (e) {
      console.error("[DASHBOARD] OAuth callback error:", e);
      req.session.flash = "Login failed. Try again.";
      return res.redirect("/dashboard");
    }
  });

  app.get("/logout", (req, res) => {
    req.session.destroy(() => res.redirect("/dashboard"));
  });

  app.get("/servers", requireLogin, async (req, res) => {
    const flash = req.session.flash;
    req.session.flash = null;

    const guilds = Array.isArray(req.session.guilds) ? req.session.guilds : [];
    const manageable = guilds.filter(g => hasManageGuild(g) && allowGuildId(g.id));

    const rows = manageable
      .map(g => {
        const inBot = client.guilds.cache.has(g.id);
        const premium = !!(PREMIUM_GUILDS && PREMIUM_GUILDS[g.id] && PREMIUM_GUILDS[g.id].isPremium);
        return `
          <div class="row">
            <div>
              <div style="font-weight:800">${escapeHtml(g.name)}</div>
              <div class="muted">${inBot ? "✅ Bot in server" : "❌ Bot not in server"} • ${premium ? "⭐ Premium" : "Free"}</div>
            </div>
            <a class="btn ${inBot ? "primary" : ""}" href="/server/${escapeHtml(g.id)}">${inBot ? "Open" : "Invite bot"}</a>
          </div>
        `;
      })
      .join("");

    res.send(htmlPage("Servers", `
      <div class="grid">
        <div class="card">
          ${flash ? `<div class="flash">${escapeHtml(flash)}</div>` : ""}
          <h1>Your Servers</h1>
          <p class="muted">Only servers where you have “Manage Server” show up.</p>
          <div class="list">${rows || `<div class="muted">No servers found.</div>`}</div>
        </div>
      </div>
    `));
  });

  app.get("/server/:guildId", requireLogin, async (req, res) => {
    const guildId = String(req.params.guildId);
    if (!allowGuildId(guildId)) {
      req.session.flash = "This server is not allowed.";
      return res.redirect("/servers");
    }

    const guilds = Array.isArray(req.session.guilds) ? req.session.guilds : [];
    const g = guilds.find(x => String(x.id) === guildId);
    if (!g || !hasManageGuild(g)) {
      req.session.flash = "You don't have permission for that server.";
      return res.redirect("/servers");
    }

    const inBot = client.guilds.cache.has(guildId);
    if (!inBot) {
      // Invite URL (admin can invite)
      const invite = `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(clientId)}&permissions=8&scope=bot%20applications.commands&guild_id=${encodeURIComponent(guildId)}`;
      return res.send(htmlPage("Invite", `
        <div class="grid">
          <div class="card">
            <h1>${escapeHtml(g.name)}</h1>
            <p class="muted">Your bot is not in this server. Invite it first.</p>
            <a class="btn primary" href="${invite}">Invite bot</a>
            <div style="height:10px"></div>
            <a class="btn" href="/servers">Back</a>
          </div>
        </div>
      `));
    }

    if (REQUIRE_PREMIUM) {
      const prem = PREMIUM_GUILDS && PREMIUM_GUILDS[guildId] && PREMIUM_GUILDS[guildId].isPremium;
      if (!prem) {
        return res.send(htmlPage("Premium Required", `
          <div class="grid">
            <div class="card">
              <h1>Premium Required</h1>
              <p class="muted">This dashboard requires premium for edits. Ask the owner to activate premium.</p>
              <a class="btn" href="/servers">Back</a>
            </div>
          </div>
        `));
      }
    }

    const cfg = getGuildConfig(guildId);
    const prem = (PREMIUM_GUILDS && PREMIUM_GUILDS[guildId]) ? PREMIUM_GUILDS[guildId] : null;

    res.send(htmlPage("Server", `
      <div class="grid">
        <div class="card">
          <h1>${escapeHtml(g.name)}</h1>
          <p class="muted">Change bot settings for this server. (This edits the same saved config your bot already uses.)</p>

          <form method="POST" action="/server/${escapeHtml(guildId)}/save">
            <div class="two">
              <div>
                <label>Support Category ID</label>
                <input name="supportCategoryId" value="${escapeHtml(cfg.supportCategoryId || "")}" placeholder="e.g. 123..."/>
              </div>
              <div>
                <label>MM / Trade Category ID</label>
                <input name="mmCategoryId" value="${escapeHtml(cfg.mmCategoryId || "")}" placeholder="e.g. 123..."/>
              </div>

              <div>
                <label>Log Channel ID</label>
                <input name="logChannelId" value="${escapeHtml(cfg.logChannelId || "")}" placeholder="e.g. 123..."/>
              </div>
              <div>
                <label>Transcript Channel ID</label>
                <input name="transcriptChannelId" value="${escapeHtml(cfg.transcriptChannelId || "")}" placeholder="optional"/>
              </div>
            </div>

            <label>Support Roles (comma-separated role IDs)</label>
            <input name="supportRoles" value="${escapeHtml((cfg.supportRoles || []).join(","))}" placeholder="roleId1,roleId2"/>

            <label>MM Roles (comma-separated role IDs)</label>
            <input name="mmRoles" value="${escapeHtml((cfg.mmRoles || []).join(","))}" placeholder="roleId1,roleId2"/>

            <label>Admin Roles (comma-separated role IDs)</label>
            <input name="adminRoles" value="${escapeHtml((cfg.adminRoles || []).join(","))}" placeholder="roleId1,roleId2"/>

            <div style="height:12px"></div>
            <button class="btn primary" type="submit">Save Settings</button>
            <a class="btn" href="/servers">Back</a>
          </form>
        </div>

        <div class="card">
          <h2>Premium Branding (optional)</h2>
          <p class="muted">This only affects premium branding fields your bot stores.</p>
          <form method="POST" action="/server/${escapeHtml(guildId)}/branding">
            <div class="two">
              <div>
                <label>Brand Name</label>
                <input name="brandName" value="${escapeHtml(prem?.branding?.name || "")}" placeholder="e.g. Ticket King"/>
              </div>
              <div>
                <label>Accent</label>
                <input name="accent" value="${escapeHtml(prem?.branding?.accent || "")}" placeholder="#f5b301"/>
              </div>
            </div>
            <label>Icon URL</label>
            <input name="iconUrl" value="${escapeHtml(prem?.branding?.iconUrl || "")}" placeholder="https://.../icon.png"/>
            <div style="height:12px"></div>
            <button class="btn primary" type="submit">Save Branding</button>
          </form>
        </div>
      </div>
    `));
  });

  app.post("/server/:guildId/save", requireLogin, (req, res) => {
    const guildId = String(req.params.guildId);
    try {
      const patch = {
        supportCategoryId: cleanId(req.body.supportCategoryId),
        mmCategoryId: cleanId(req.body.mmCategoryId),
        logChannelId: cleanId(req.body.logChannelId),
        transcriptChannelId: cleanId(req.body.transcriptChannelId),
        supportRoles: parseIdList(req.body.supportRoles),
        mmRoles: parseIdList(req.body.mmRoles),
        adminRoles: parseIdList(req.body.adminRoles),
      };
      patchGuildConfig(guildId, patch);
      req.session.flash = "Saved ✅";
    } catch (e) {
      console.error("[DASHBOARD] Save error:", e);
      req.session.flash = "Save failed.";
    }
    res.redirect(`/server/${encodeURIComponent(guildId)}`);
  });

  app.post("/server/:guildId/branding", requireLogin, (req, res) => {
    const guildId = String(req.params.guildId);
    try {
      // Only update branding if guild is premium already.
      if (!PREMIUM_GUILDS[guildId] || !PREMIUM_GUILDS[guildId].isPremium) {
        req.session.flash = "Branding requires premium for that server.";
        return res.redirect(`/server/${encodeURIComponent(guildId)}`);
      }

      const next = PREMIUM_GUILDS[guildId];
      next.branding = next.branding || {};
      next.branding.name = String(req.body.brandName || "").trim().slice(0, 40) || next.branding.name;
      next.branding.iconUrl = String(req.body.iconUrl || "").trim().slice(0, 300) || next.branding.iconUrl;
      next.branding.accent = String(req.body.accent || "").trim().slice(0, 20) || next.branding.accent;

      PREMIUM_GUILDS[guildId] = next;
      writeJsonSafe(PREMIUM_FILE, PREMIUM_GUILDS);

      req.session.flash = "Branding saved ✅";
    } catch (e) {
      console.error("[DASHBOARD] Branding error:", e);
      req.session.flash = "Branding save failed.";
    }
    res.redirect(`/server/${encodeURIComponent(guildId)}`);
  });

  function cleanId(v) {
    const s = String(v || "").trim();
    if (!s) return null;
    return /^\d{10,25}$/.test(s) ? s : null;
  }

  function parseIdList(v) {
    const s = String(v || "").trim();
    if (!s) return [];
    return s.split(",").map(x => x.trim()).filter(x => /^\d{10,25}$/.test(x));
  }

  // health check
  app.get("/health", (req, res) => res.json({ ok: true, bot: !!client.user, ts: Date.now() }));

  app.listen(DASHBOARD_PORT, () => {
    console.log(`[DASHBOARD] Running on ${DASHBOARD_URL} (port ${DASHBOARD_PORT})`);
    console.log(`[DASHBOARD] Redirect URI: ${OAUTH_REDIRECT_URI}`);
  });
}


// ----------------------
// Login
// ----------------------
client.login(token);  