require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  RoleSelectMenuBuilder,
  PermissionFlagsBits,
  ChannelType
} = require("discord.js");

const {
  clientId,
  guildId,
  supportCategoryId,
  mmCategoryId,
  supportRoles,
  mmRoles,
  adminRoles,
  logChannelId
} = require("./config.json");

const token = process.env.STAR_TOKEN;

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
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
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
  } catch (e) {
    console.error("Failed writing JSON:", file, e);
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

function normalizeArray(arr) {
  return Array.isArray(arr) ? arr.filter(isValidSnowflake) : [];
}

function getDefaultConfig() {
  return {
    supportCategoryId: supportCategoryId || null,
    mmCategoryId: mmCategoryId || null,
    logChannelId: logChannelId || null,
    supportRoles: normalizeArray(supportRoles),
    mmRoles: normalizeArray(mmRoles),
    adminRoles: normalizeArray(adminRoles)
  };
}

function getGuildConfig(guildId) {
  const def = getDefaultConfig();
  const saved = GUILD_CONFIGS[guildId] || {};
  return {
    ...def,
    ...saved,
    supportRoles: normalizeArray(saved.supportRoles ?? def.supportRoles),
    mmRoles: normalizeArray(saved.mmRoles ?? def.mmRoles),
    adminRoles: normalizeArray(saved.adminRoles ?? def.adminRoles)
  };
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
  writeJsonSafe(GUILD_CFG_FILE, GUILD_CONFIGS);
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
  new SlashCommandBuilder()
    .setName("toptrade")
    .setDescription("Show top trade staff by rating"),
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
    )
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

  console.log(`${client.user.tag} is online!`);
}

// Discord.js v15 renamed "ready" to "clientReady".
// We listen to BOTH so it works on v14/v15 without crashing.
client.once("clientReady", () => registerAllCommands().catch(console.error));
client.once("ready", () => registerAllCommands().catch(console.error));


// ----------------------
// Helpers
// ----------------------
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
  const list = Array.isArray(cfg.adminRoles) ? cfg.adminRoles : adminRoles;
  return member.roles.cache.some(r => list.includes(r.id));
}
function isSupport(member) {
  const cfg = getGuildConfig(member.guild.id);
  const list = Array.isArray(cfg.supportRoles) ? cfg.supportRoles : supportRoles;
  return member.roles.cache.some(r => list.includes(r.id));
}
function isTradeStaff(member) {
  const cfg = getGuildConfig(member.guild.id);
  const list = Array.isArray(cfg.mmRoles) ? cfg.mmRoles : mmRoles;
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


// central close logic (used by button + /close)
async function closeTicket(channel, closedByMember, reason = null) {
  if (!channel || channel.type !== ChannelType.GuildText) return;

  const { opened, claimed } = parseTopic(channel.topic);

  // DM summary + rating buttons
  await dmSummaryAndRating(opened, claimed, closedByMember.user.tag, reason).catch(() => {});

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
function buildSupportMenu() {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ticket_type")
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
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("ticket_type")
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
// Message triggers (?support, ?trade)
// ----------------------
// ----------------------
// Setup Panel Helpers
// ----------------------
function buildSetupEmbed(guild, cfg) {
  return new EmbedBuilder()
    .setTitle("⚙️ Ticket Bot — Server Setup")
    .setColor("#3498db")
    .setDescription(
      "This setup is **per-server** and saves automatically.\n" +
      "Use the buttons below to configure where tickets are created and who can manage them."
    )
    .addFields(
      { name: "Support Category", value: cfg.supportCategoryId ? `<#${cfg.supportCategoryId}>` : "Not set", inline: true },
      { name: "Trade Category", value: cfg.mmCategoryId ? `<#${cfg.mmCategoryId}>` : "Not set", inline: true },
      { name: "Log Channel", value: cfg.logChannelId ? `<#${cfg.logChannelId}>` : "Not set", inline: true },
      {
        name: "Support Roles",
        value: (cfg.supportRoles?.length ? cfg.supportRoles.map(r => `<@&${r}>`).join(" ") : "Not set"),
        inline: false
      },
      {
        name: "Trade Roles",
        value: (cfg.mmRoles?.length ? cfg.mmRoles.map(r => `<@&${r}>`).join(" ") : "Not set"),
        inline: false
      },
      {
        name: "Admin Roles",
        value: (cfg.adminRoles?.length ? cfg.adminRoles.map(r => `<@&${r}>`).join(" ") : "Not set"),
        inline: false
      }
    )
    .setFooter({ text: "Setup is saved per server • Owner only" });
}

function buildSetupMainComponents(ownerId) {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_set_support:${ownerId}`).setLabel("Set Support Category").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`setup_set_mm:${ownerId}`).setLabel("Set Trade Category").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`setup_set_log:${ownerId}`).setLabel("Set Log Channel").setStyle(ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_set_roles:${ownerId}`).setLabel("Set Roles").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`setup_done:${ownerId}`).setLabel("Done").setStyle(ButtonStyle.Success)
  );

  return [row1, row2];
}

function buildSetupMainPayload(guild, ownerId) {
  const cfg = getGuildConfig(guild.id);
  const embed = buildSetupEmbed(guild, cfg);
  const components = buildSetupMainComponents(ownerId);
  return { embeds: [embed], components };
}

function buildSetupBackRow(ownerId) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`setup_back:${ownerId}`).setLabel("⬅️ Back").setStyle(ButtonStyle.Secondary)
  );
}

client.on("messageCreate", async message => {
  if (message.author.bot) return;

  const content = message.content.trim();

  // Owner help (prefix) — shows ALL commands (including secret ones)
  // Everyone else should use /help (public).
  if (content === "?help") {
    // If used in DMs or outside a guild, just show the public /help tip.
    if (!message.guild) {
      return message.reply("Use **/help** to open my Help Panel. ✅").catch(() => {});
    }

    const isOwner = message.guild.ownerId === message.author.id;
    if (!isOwner) {
      return message.reply("Use **/help** to open my Help Panel. ✅").catch(() => {});
    }

    const embed = new EmbedBuilder()
      .setTitle("🔒 Owner Help — Full Command List")
      .setColor("#e74c3c")
      .setDescription(`**Public (Slash) Commands:**
• \`/help\` — Open help panel
• \`/close\` — Close a ticket (staff only)
• \`/toptrade\` — Top ratings leaderboard

**Owner (Prefix) Commands:**
• \`?setup\` — Post panels in this server (owner only)
• \`?trade\` — Create a Trade ticket (secret)
• \`?support\` — Create a Support ticket (secret)

⚠️ Keep owner-only commands private.`)
      .setFooter({ text: "Dragon Services • Owner Tools" });

    return message.reply({ embeds: [embed] }).catch(() => {});
  }

  // Owner-only setup for this server (prefix)
  // This lets the bot work in ANY server without editing config.json every time.
  if (content === "?setup") {
    if (!message.guild) return;
    const ownerId = message.guild.ownerId;
    if (message.author.id !== ownerId) {
      return message.reply("⛔ Only the **server owner** can use `?setup`.").catch(() => {});
    }

    const payload = buildSetupMainPayload(message.guild, ownerId);
    return message.reply(payload).catch(() => {});
  }

  // Support panel
  if (content === "?support") {
    const menu = buildSupportMenu();

    const embed = new EmbedBuilder()
      .setTitle("🛠️ Support Panel")
      .setDescription(
        "Thank you for contacting support.\n" +
          "Please describe your issue clearly and wait for a staff response.\n\n" +
          "✅ Appropriate for:\n" +
          "• Server or role issues\n" +
          "• Questions about rules or system\n" +
          "• Reporting bugs or problems\n\n" +
          "❌ Not for:\n" +
          "• Random chatting\n" +
          "• Trade assistance (use `?trade` instead)\n"
      )
      .setColor("#2F3136")
      .setFooter({ text: "Dragon services | Professional support" });

    await message.channel.send({ embeds: [embed], components: [menu] });
  }

  // Trade help panel
  if (content === "?trade") {
    const menu = buildTradeMenu();

    const embed = new EmbedBuilder()
      .setTitle("🤝 Request Trade Help")
      .setDescription(
        "🛡️ Dragon Services — Official Trade Panel 🐉\n\n" +
          "This panel exists strictly for secure Trade Requests.\n" +
          "Before opening a ticket, please go through the guidelines:\n\n" +
          "__Trade-Assist Tickets Are Accepted For ✔__\n" +
          "• Server acquisitions, digital assets & scripts\n" +
          "• Premium account or product trades\n" +
          "• Paid commissions & project deals\n" +
          "• Verified exchanges between two parties\n\n" +
          "__Will NOT Be Accepted ❌__\n" +
          "• Random chats or friendship talks\n" +
          "• Free deals / non-paid trades\n" +
          "• Items with unclear ownership\n" +
          "• Already disputed cases\n\n" +
          "__📝 When Opening a Trade Ticket, Provide:__\n" +
          "• Your Discord @ + Opponent’s Discord @\n" +
          "• What you are exchanging or purchasing\n" +
          "• Agreed amount / service terms\n" +
          "• Proof or screenshot of agreement\n\n" +
          "Both parties must confirm inside the ticket.\n\n" +
          "__💳 Service Fee:__\n" +
          "Will be mentioned by staff after verification.\n" +
          "Fees vary depending on value & risk involved.\n\n" +
          "⏱ **Average Response Time:** 5–20 mins\n" +
          "Stay patient — no spam, no ping flooding.\n\n" +
          "🔥 We ensure safe, bias-free, protected trades.\n" +
          "**Team Dragon Services — Trade staff Division 🐲**"
      )
      .setColor("#9b59b6")
      .setFooter({ text: "Dragon services | Official Trade Panel" });

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
      .setTitle("🐉 Dragon Services — Help Center")
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
      .setFooter({ text: "Dragon Services • Secure • Professional" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_help_panel")
        .setLabel("📖 Open Help Panel")
        .setStyle(ButtonStyle.Danger)
    );

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
  // ==================================================
  // HELP PANEL UI — PRIVATE TABBED MENU
  // ==================================================
  if (interaction.isButton()) {
    // open main help panel (ephemeral)
    if (interaction.customId === "open_help_panel") {
      const embed = new EmbedBuilder()
        .setTitle("📘 | Dragon Help Panel")
        .setColor("#e74c3c")
        .setDescription(
          "Welcome to your **private help menu**! 🐉\n\n" +
            "Use the tabs below to explore what I can do.\n\n" +
            "🔻 **Choose a category below**"
        )
        .setFooter({ text: "Dragon Services Help Center 🐉" });

      const tabs = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("tab_description")
          .setLabel("📘 Description")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_features")
          .setLabel("⚙️ Features")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_ticket")
          .setLabel("🎫 Tickets")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_trade")
          .setLabel("🤝 Trade Help")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_ratings")
          .setLabel("⭐ Ratings")
          .setStyle(ButtonStyle.Secondary)
      );

      return interaction.reply({
        embeds: [embed],
        components: [tabs],
        ephemeral: true
      });
    }

    // tab switching for help menu
    if (
      interaction.customId === "tab_description" ||
      interaction.customId === "tab_features" ||
      interaction.customId === "tab_ticket" ||
      interaction.customId === "tab_trade" ||
      interaction.customId === "tab_ratings"
    ) {
      const makeEmbed = (title, text) =>
        new EmbedBuilder()
          .setTitle(title)
          .setColor("#f1c40f")
          .setDescription(text)
          .setFooter({ text: "Dragon Services Help Center 🐉" });

      const tabs = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId("tab_description")
          .setLabel("📘 Description")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_features")
          .setLabel("⚙️ Features")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_ticket")
          .setLabel("🎫 Tickets")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_trade")
          .setLabel("🤝 Trade Help")
          .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
          .setCustomId("tab_ratings")
          .setLabel("⭐ Ratings")
          .setStyle(ButtonStyle.Secondary)
      );

      if (interaction.customId === "tab_description") {
        return interaction.update({
          embeds: [
            makeEmbed(
              "📘 Bot Description",
              "Hi! I'm **Dragon Services Bot** 🐉\n\n" +
                "✨ I help with:\n" +
                "• Secure **trade-assist deals**\n" +
                "• 🔧 Support issues\n" +
                "• 🎫 Ticket management\n" +
                "• ⭐ Rating and Trade leaderboard\n\n" +
                "Use the tabs below to learn more about each system."
            )
          ],
          components: [tabs]
        });
      }

      if (interaction.customId === "tab_features") {
        return interaction.update({
          embeds: [
            makeEmbed(
              "⚙️ Features",
              "Here is what I can do:\n\n" +
                "🔧 **Support tickets** – private channels with staff\n" +
                "🤝 **Trade tickets** – safe trades with verified staff\n" +
                "⭐ **Ratings** – rate the service & trade staff\n" +
                "📊 **Top Trade** – leaderboard based on ratings\n" +
                "🧾 **Logs** – all actions are logged in a staff channel\n"
            )
          ],
          components: [tabs]
        });
      }

      if (interaction.customId === "tab_ticket") {
        return interaction.update({
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
          components: [tabs]
        });
      }

      if (interaction.customId === "tab_trade") {
        return interaction.update({
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
          components: [tabs]
        });
      }

      if (interaction.customId === "tab_ratings") {
        return interaction.update({
          embeds: [
            makeEmbed(
              "⭐ Rating System",
              "After a ticket is closed, you can rate:\n\n" +
                "• ⭐ **Helper performance** (if staff was involved)\n" +
                "• ⭐ **Overall service quality**\n\n" +
                "These ratings are saved and used for:\n" +
                "• 📊 Building the **Top Trade Helpers leaderboard**\n" +
                "• 🛡 More trust & transparency in the community\n"
            )
          ],
          components: [tabs]
        });
      }
    }
  }


  // ==================================================
  // SETUP PANEL (owner only, per-server) — buttons + selects
  // ==================================================
  if (interaction.isButton() && interaction.customId && interaction.customId.startsWith("setup_")) {
    const [action, ownerId] = interaction.customId.split(":");
    if (!interaction.guild) return interaction.reply({ content: "Guild only.", ephemeral: true });

    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⛔ Only the server owner who ran `?setup` can use this panel.", ephemeral: true });
    }

    const guild = interaction.guild;

    // Back to main panel
    if (action === "setup_back") {
      return interaction.update(buildSetupMainPayload(guild, ownerId));
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
      return interaction.update({ ...buildSetupMainPayload(guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
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
      return interaction.update({ ...buildSetupMainPayload(guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
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
      return interaction.update({ ...buildSetupMainPayload(guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
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
      return interaction.update({ ...buildSetupMainPayload(interaction.guild, ownerId), components: [buildSetupBackRow(ownerId), row] });
    }

    if (action === "setup_done") {
      const cfg = getGuildConfig(guild.id);
      const missing = [];
      if (!cfg.supportCategoryId) missing.push("Support Category");
      if (!cfg.mmCategoryId) missing.push("Trade Category");
      if (!cfg.logChannelId) missing.push("Log Channel");

      return interaction.update({
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
    const [id, ownerId] = interaction.customId.split(":");
    if (!interaction.guild) return interaction.reply({ content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⛔ Only the setup owner can use this.", ephemeral: true });
    }

    const picked = interaction.values?.[0];
    if (!picked) return interaction.reply({ content: "Nothing selected.", ephemeral: true });

    if (id === "setup_pick_support") saveGuildConfig(interaction.guild.id, { supportCategoryId: picked });
    if (id === "setup_pick_mm") saveGuildConfig(interaction.guild.id, { mmCategoryId: picked });
    if (id === "setup_pick_log") saveGuildConfig(interaction.guild.id, { logChannelId: picked });

    await interaction.update(buildSetupMainPayload(interaction.guild, ownerId)).catch(() => {});

    return interaction.followUp({ content: "✅ Saved!", ephemeral: true }).catch(() => {});
  }

  // Role list chooser
  if (interaction.isStringSelectMenu() && interaction.customId && interaction.customId.startsWith("setup_roles_step:")) {
    const [, ownerId] = interaction.customId.split(":");
    if (!interaction.guild) return interaction.reply({ content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⛔ Only the setup owner can use this.", ephemeral: true });
    }

    const which = interaction.values?.[0];
    const row = new ActionRowBuilder().addComponents(
      new RoleSelectMenuBuilder()
        .setCustomId(`setup_pick_roles:${ownerId}:${which}`)
        .setPlaceholder(`Select ${which} roles…`)
        .setMinValues(0)
        .setMaxValues(10)
    );

    return interaction.update({ components: [row] });
  }

  // Role picker
  if (interaction.isRoleSelectMenu() && interaction.customId && interaction.customId.startsWith("setup_pick_roles:")) {
    const parts = interaction.customId.split(":");
    const ownerId = parts[1];
    const which = parts[2];

    if (!interaction.guild) return interaction.reply({ content: "Guild only.", ephemeral: true });
    if (interaction.user.id !== ownerId) {
      return interaction.reply({ content: "⛔ Only the setup owner can use this.", ephemeral: true });
    }

    const roleIds = (interaction.values || []).filter(isValidSnowflake);

    if (which === "support") saveGuildConfig(interaction.guild.id, { supportRoles: roleIds });
    if (which === "trade") saveGuildConfig(interaction.guild.id, { mmRoles: roleIds });
    if (which === "admin") saveGuildConfig(interaction.guild.id, { adminRoles: roleIds });

    await interaction.update(buildSetupMainPayload(interaction.guild, ownerId)).catch(() => {});

    return interaction.followUp({ content: "✅ Roles saved!", ephemeral: true }).catch(() => {});
  }

  // /add inside ticket
  if (interaction.isChatInputCommand() && interaction.commandName === "add") {
    const user = interaction.options.getUser("user");
    const channel = interaction.channel;

    if (!channel || channel.type !== ChannelType.GuildText || !channel.name.startsWith("ticket-")) {
      return interaction.reply({
        content: "This command can only be used inside a ticket channel.",
        ephemeral: true
      });
    }

    await channel.permissionOverwrites
      .edit(user.id, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true
      })
      .catch(() => {});

    await channel.send(`👤 ${interaction.user} added ${user} to this ticket.`).catch(() => {});

    return interaction.reply({ content: `✅ Added ${user} to this ticket.`, ephemeral: true });
  }

  // toptrade command
  if (interaction.isChatInputCommand() && interaction.commandName === "toptrade") {
    const entries = Object.entries(REVIEWS.trade || {});
    if (!entries.length) {
      return interaction.reply({ content: "No trade-help reviews yet.", ephemeral: true });
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

    return interaction.reply({ embeds: [embed], ephemeral: false });
  }

  // /help — open private help panel
  if (interaction.isChatInputCommand() && interaction.commandName === "help") {
    const embed = new EmbedBuilder()
      .setTitle("🐉 Dragon Services — Help Center")
      .setColor("#e74c3c")
      .setDescription(`👋 **Hey ${interaction.user.username}!**

Click below to open your **private Help Panel**.
Only **you** can see it.`)
      .setFooter({ text: "Dragon Services • Secure • Professional" });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_help_panel")
        .setLabel("📖 Open Help Panel")
        .setStyle(ButtonStyle.Danger)
    );

    return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
  }

  // /close — close ticket via command (staff only)
  if (interaction.isChatInputCommand() && interaction.commandName === "close") {
    const channel = interaction.channel;
    const member = interaction.member;

    if (!channel || channel.type !== ChannelType.GuildText || !channel.name.startsWith("ticket-")) {
      return interaction.reply({ content: "⛔ Use this only inside a ticket channel.", ephemeral: true });
    }
    if (!canManageTicket(member, channel)) {
      return interaction.reply({ content: "⛔ You are not allowed to close this ticket.", ephemeral: true });
    }

    const reason = interaction.options.getString("reason") || null;

    await interaction.reply({ content: "✅ Closing ticket...", ephemeral: true }).catch(() => {});
    await closeTicket(channel, member, reason).catch(console.error);
    return;
  }

  // Dropdown selection -> show modal
  if (interaction.isStringSelectMenu() && interaction.customId === "ticket_type") {
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

    return interaction.showModal(modal);
  }

  // Modal submit -> create ticket
  if (
    interaction.isModalSubmit() &&
    (interaction.customId === "modal_support" || interaction.customId === "modal_mm")
  ) {
    await interaction.deferReply({ ephemeral: true }).catch(() => {});

    const type = interaction.customId === "modal_support" ? "Support" : "Trade";
    const player = interaction.fields.getTextInputValue("player");
    const details = interaction.fields.getTextInputValue("details");

    const guild = interaction.guild;
    const cfg = getGuildConfig(guild.id);
    const categoryId = type === "Support" ? cfg.supportCategoryId : cfg.mmCategoryId;

    // If categories are not configured in this server, stop with a clear message
    if (!categoryId) {
      return interaction.editReply({
        content:
          "❌ Ticket system is not configured in **this server**.\n" +
          "Ask the **server owner** to run `?setup` and set the ticket categories first."
      }).catch(() => {});
    }


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

      const channel = await guild.channels.create({
        name: `ticket-${interaction.user.username}`.toLowerCase(),
        type: ChannelType.GuildText,
        parent: categoryId,
        permissionOverwrites: overwrites
      });

      await channel.setTopic(makeTopic(interaction.user.id)).catch(() => {});

      const embed = new EmbedBuilder()
        .setTitle(type === "Support" ? "🛠️ Support Ticket" : "🤝 Trade Ticket")
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

      await channel.send("@here").catch(() => {});
      await channel.send({ embeds: [embed], components: [row] });

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
                c.components && c.components.some(inner => inner.customId === "ticket_type")
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

      await interaction.editReply({
        content: `✅ Your ${type} ticket has been created: ${channel}`
      }).catch(() => {});
    } catch (err) {
      console.error("Ticket create error:", err);
      await interaction.editReply({
        content:
          "❌ I couldn't create the ticket channel.\n" +
          "Most common reason: one of your role IDs/category IDs is wrong or not in this server.\n" +
          "Run `?setup` (server owner) to configure categories/roles for THIS server, or fix the defaults in `config.json`."
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
      return interaction.editReply({ content: "❌ Invalid channel." }).catch(() => {});
    }

    if (!canManageTicket(member, channel)) {
      return interaction.editReply({
        content: "⛔ You do not have permission to claim this ticket."
      }).catch(() => {});
    }

    const t = parseTopic(channel.topic);
    if (t.claimed) {
      return interaction.editReply({
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
    return interaction.editReply({ content: "✅ You claimed this ticket." }).catch(() => {});
  }

  // Close ticket (no reason)
  if (interaction.isButton() && interaction.customId === "close_ticket") {
    const member = interaction.member;
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) return;

    if (!canManageTicket(member, channel)) {
      return interaction.reply({
        content: "⛔ You are not allowed to close this ticket.",
        ephemeral: true
      });
    }

    // reply instantly so Discord doesn’t show “interaction failed”
    await interaction.reply({ content: "✅ Closing ticket...", ephemeral: true }).catch(() => {});
    // unified close logic
    await closeTicket(channel, member, null).catch(() => {});
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
      return interaction.reply({ content: "⛔ Invalid channel.", ephemeral: true });
    }
    if (!canManageTicket(interaction.member, channel)) {
      return interaction.reply({
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
  if (interaction.isModalSubmit() && interaction.customId === "modal_close_reason") {
    const reason = interaction.fields.getTextInputValue("reason");
    const member = interaction.member;
    const channel = interaction.channel;
    if (!channel || channel.type !== ChannelType.GuildText) return;

    if (!canManageTicket(member, channel)) {
          }

    return interaction.reply({
        content: "⛔ You are not allowed to close this ticket.",
        ephemeral: true
      });
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

    return interaction.reply({ content: "📝 Closing with reason...", ephemeral: true });
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
          return interaction.reply({ content: "Invalid rating data.", ephemeral: true });
        }
        const key = `${ticketName}_${interaction.user.id}_mm`;
        if (RATED[key]) {
          return interaction.reply({
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

        await interaction.reply({
          content: `Thanks — you rated the Trade Help ${score} ⭐`,
          ephemeral: true
        });
      } else if (kind === "service") {
        const ticketName = parts[2];
        const score = parseInt(parts[3], 10);
        if (!ticketName || !score) {
          return interaction.reply({ content: "Invalid rating data.", ephemeral: true });
        }
        const key = `${ticketName}_${interaction.user.id}_service`;
        if (RATED[key]) {
          return interaction.reply({
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

        await interaction.reply({
          content: `Thanks — you rated our service ${score} ⭐`,
          ephemeral: true
        });
      } else {
        return interaction.reply({ content: "Unknown rating type.", ephemeral: true });
      }
    } catch (e) {
      console.error("Rate handler error:", e);
      return interaction.reply({ content: "Failed to record rating.", ephemeral: true });
    }
  }
});

// ----------------------
// DM summary + rating UI
// ----------------------
async function dmSummaryAndRating(openerId, claimedId, closerTag, reason = null) {
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

// ----------------------
// Login
// ----------------------
client.login(token);