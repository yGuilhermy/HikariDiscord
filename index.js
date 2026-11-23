require('dotenv').config();
const { Client, GatewayIntentBits, Partials, Collection } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('./src/config');
const { logger, init } = require('./src/utils/logger');
init(config.logWebhookUrl);

const { startActivityUpdater } = require('./src/utils/activity');
const { setDiscordClient } = require('./src/handlers/llmHandler');

process.on('unhandledRejection', (reason) => {
    logger.event('ERROR', 'fatal', reason);
});

process.on('uncaughtException', (err) => {
    logger.event('ERROR', 'fatal', err);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User, Partials.Reaction],
});

setDiscordClient(client);

const eventsPath = path.join(__dirname, 'src/events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
    } else {
        client.on(event.name, (...args) => event.execute(...args, client));
    }
}

startActivityUpdater(client);

client.login(config.discordToken).catch(err => {
    logger.event('ERROR', 'fatal', err);
});