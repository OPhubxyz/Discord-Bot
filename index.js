
const {
    Client,
    GatewayIntentBits
} = require("discord.js");

const {
    joinVoiceChannel,
    getVoiceConnection
} = require("@discordjs/voice");

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const PREFIX = "!";

client.once("ready", () => {
    console.log(`Bot online: ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
    if (message.author.bot) return;
    if (!message.guild) return;
    if (!message.content.startsWith(PREFIX)) return;

    const args = message.content
        .slice(PREFIX.length)
        .trim()
        .split(/ +/);

    const command = args.shift().toLowerCase();

    // Lệnh !join
    if (command === "join") {
        const voiceChannel = message.member.voice.channel;

        if (!voiceChannel) {
            return message.reply(
                "❌ Bạn phải vào Voice Channel trước!"
            );
        }

        try {
            joinVoiceChannel({
                channelId: voiceChannel.id,
                guildId: message.guild.id,
                adapterCreator:
                    message.guild.voiceAdapterCreator,
                selfDeaf: false,
                selfMute: false
            });

            message.reply(
                `✅ Đã join voice: **${voiceChannel.name}**`
            );
        } catch (error) {
            console.error(error);
            message.reply("❌ Không thể join voice!");
        }
    }

    // Lệnh !leave
    if (command === "leave") {
        const connection = getVoiceConnection(
            message.guild.id
        );

        if (!connection) {
            return message.reply(
                "❌ Bot hiện không ở trong voice!"
            );
        }

        connection.destroy();

        message.reply("👋 Bot đã rời Voice Channel!");
    }
});

client.login(process.env.DISCORD_TOKEN);
          
