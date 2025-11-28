require("dotenv").config(); // Încarcă variabilele din .env

const { 
    Client, 
    GatewayIntentBits, 
    SlashCommandBuilder, 
    REST, 
    Routes, 
    EmbedBuilder 
} = require("discord.js");

const fs = require("fs");

// Importă setările tale din config.json
const { clientId, guildId, owners } = require("./config.json");

// Tokenul botului, luat din .env
const token = process.env.STAR_TOKEN;

// ----------------------
// Load / Create Database
// ----------------------
const dbPath = "./stars.json";
let stars = {};

try {
    if (!fs.existsSync(dbPath)) fs.writeFileSync(dbPath, JSON.stringify({}));
    stars = JSON.parse(fs.readFileSync(dbPath));
} catch {
    stars = {};
    fs.writeFileSync(dbPath, JSON.stringify({}));
}

// ----------------------
// Discord Client
// ----------------------
const client = new Client({
    intents: [GatewayIntentBits.Guilds]
});

// ----------------------
// Slash Commands
// ----------------------
const commands = [
    new SlashCommandBuilder()
        .setName("addstar")
        .setDescription("⭐ Give stars to a user (Owner Only)")
        .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(opt => opt.setName("amount").setDescription("Amount").setRequired(true)),

    new SlashCommandBuilder()
        .setName("removestar")
        .setDescription("❌ Remove stars from a user (Owner Only)")
        .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true))
        .addIntegerOption(opt => opt.setName("amount").setDescription("Amount").setRequired(true)),

    new SlashCommandBuilder()
        .setName("clearstars")
        .setDescription("🧹 Remove ALL stars from EVERYONE (Owner Only)"),

    new SlashCommandBuilder()
        .setName("star")
        .setDescription("🌟 Check user star count")
        .addUserOption(opt => opt.setName("user").setDescription("User").setRequired(true)),

    new SlashCommandBuilder()
        .setName("leaderboard")
        .setDescription("🏆 Show the star leaderboard")
].map(cmd => cmd.toJSON());

// ----------------------
// Register Commands
// ----------------------
client.once("ready", async () => {
    const rest = new REST({ version: "10" }).setToken(token);

    try {
        await rest.put(Routes.applicationCommands(clientId), { body: [] }); 
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });

        console.log("⭐ Commands registered!");
    } catch (err) {
        console.error(err);
    }

    console.log(`${client.user.tag} is online!`);
});

// ----------------------
// Command Handler
// ----------------------
client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) return;

    const cmd = interaction.commandName;
    const saveDB = () => fs.writeFileSync(dbPath, JSON.stringify(stars, null, 2));
    const ensure = id => { if (!stars[id]) stars[id] = 0; };

    // Owner only commands
    const ownerOnly = ["addstar", "removestar", "clearstars"];
    if (ownerOnly.includes(cmd) && !owners.includes(interaction.user.id)) {
        return interaction.reply({
            content: "⛔ You are not allowed to use this command.",
            ephemeral: true
        });
    }

    // ---------------------- /addstar ----------------------
    if (cmd === "addstar") {
        const user = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");

        ensure(user.id);
        stars[user.id] += amount;
        saveDB();

        const embed = new EmbedBuilder()
            .setTitle("✨ Star Added")
            .setDescription(`Gave **${amount}** ⭐ to **${user.username}**`)
            .setColor("#FFD700")
            .setThumbnail(user.displayAvatarURL({ dynamic: true }));

        return interaction.reply({ embeds: [embed] });
    }

    // ---------------------- /removestar ----------------------
    if (cmd === "removestar") {
        const user = interaction.options.getUser("user");
        const amount = interaction.options.getInteger("amount");

        ensure(user.id);
        stars[user.id] = Math.max(0, stars[user.id] - amount);
        saveDB();

        const embed = new EmbedBuilder()
            .setTitle("❌ Star Removed")
            .setDescription(`Removed **${amount}** ⭐ from **${user.username}**`)
            .setColor("#FF0000")
            .setThumbnail(user.displayAvatarURL({ dynamic: true }));

        return interaction.reply({ embeds: [embed] });
    }

    // ---------------------- /clearstars ----------------------
    if (cmd === "clearstars") {
        stars = {};
        saveDB();

        const embed = new EmbedBuilder()
            .setTitle("🧹 All Stars Cleared")
            .setDescription("Every user's stars have been reset to **0**.")
            .setColor("#000000");

        return interaction.reply({ embeds: [embed] });
    }

    // ---------------------- /star ----------------------
    if (cmd === "star") {
        const user = interaction.options.getUser("user");
        ensure(user.id);

        const embed = new EmbedBuilder()
            .setTitle("🌟 Star Count")
            .setDescription(`**${user.username}** currently has **${stars[user.id]} ⭐**`)
            .setColor("#00BFFF")
            .setThumbnail(user.displayAvatarURL({ dynamic: true }));

        return interaction.reply({ embeds: [embed] });
    }

    // ---------------------- /leaderboard ----------------------
    if (cmd === "leaderboard") {
        await interaction.deferReply();

        const sorted = Object.entries(stars)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10);

        if (sorted.length === 0) {
            return interaction.editReply("No stars have been given yet!");
        }

        let desc = "";
        let pos = 1;

        for (const [id, count] of sorted) {
            const member = await interaction.guild.members.fetch(id).catch(() => null);
            const name = member ? member.user.username : "Unknown User";
            desc += `**${pos}.** ${name} — ⭐ **${count}**\n`;
            pos++;
        }

        const embed = new EmbedBuilder()
            .setTitle("🏆 Leaderboard")
            .setColor("#8A2BE2")
            .setDescription(desc);

        return interaction.editReply({ embeds: [embed] });
    }
});

// ----------------------
// Login
// ----------------------
client.login(token);