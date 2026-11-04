const { Client, GatewayIntentBits, Events } = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType
} = require("@discordjs/voice");

const { spawn } = require("child_process");

// Dùng ffmpeg-static nếu có, không có thì dùng ffmpeg cài sẵn trên máy
let ffmpegPath;
try {
  ffmpegPath = require("ffmpeg-static");
} catch (e) {
  console.warn("Không tìm thấy ffmpeg-static, dùng ffmpeg của hệ thống.");
}
if (!ffmpegPath) ffmpegPath = "ffmpeg";

// Đặt TOKEN trong biến môi trường BOT_TOKEN trên FadeHost
const TOKEN = process.env.BOT_TOKEN;
const PREFIX = "!";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

const music = new Map();

function getMusic(guildId) {
  if (!music.has(guildId)) {
    const player = createAudioPlayer({
      behaviors: {
        noSubscriber: NoSubscriberBehavior.Pause
      }
    });

    music.set(guildId, {
      player,
      queue: [],
      current: null,
      loop: "off",
      autoplay: false,
      ffmpeg: null
    });

    player.on(AudioPlayerStatus.Idle, () => {
      const data = music.get(guildId);
      if (!data) return;

      if (data.loop === "song" && data.current) {
        data.queue.unshift(data.current);
      } else if (data.loop === "queue" && data.current) {
        data.queue.push(data.current);
      }

      data.current = null;
      playNext(guildId);
    });

    // Sau lỗi player tự chuyển sang Idle nên không gọi playNext ở đây
    player.on("error", (error) => {
      console.error("Player error:", error.message);
    });
  }

  return music.get(guildId);
}

function playNext(guildId) {
  const data = music.get(guildId);
  if (!data) return;

  if (data.queue.length === 0) {
    data.current = null;
    return;
  }

  const song = data.queue.shift();
  data.current = song;

  // URL phải là link audio trực tiếp, được phép phát
  const ffmpeg = spawn(ffmpegPath, [
    "-reconnect", "1",
    "-reconnect_streamed", "1",
    "-reconnect_delay_max", "5",
    "-re",
    "-i", song.url,
    "-vn",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  ]);

  data.ffmpeg = ffmpeg;

  // FFmpeg ghi log vào stderr, bỏ qua để tránh spam console
  ffmpeg.stderr.on("data", () => {});

  ffmpeg.on("error", (error) => {
    console.error("FFmpeg error:", error.message);
  });

  ffmpeg.on("close", (code) => {
    if (code !== 0 && code !== null) {
      console.log("FFmpeg exited:", code);
    }
  });

  const resource = createAudioResource(ffmpeg.stdout, {
    inputType: StreamType.Raw,
    metadata: song
  });

  data.player.play(resource);
}

function stopFFmpeg(guildId) {
  const data = music.get(guildId);
  if (data?.ffmpeg) {
    data.ffmpeg.kill("SIGKILL");
    data.ffmpeg = null;
  }
}

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  const data = getMusic(message.guild.id);
  const memberVoice = message.member?.voice?.channel;
  const connection = getVoiceConnection(message.guild.id);

  // JOIN
  if (command === "join") {
    if (!memberVoice) {
      return message.reply("Bạn phải vào voice channel trước.");
    }

    const voiceConnection = joinVoiceChannel({
      channelId: memberVoice.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });

    voiceConnection.subscribe(data.player);
    return message.reply(`Đã vào voice: **${memberVoice.name}**`);
  }

  // LEAVE
  if (command === "leave") {
    data.queue = [];
    data.loop = "off";
    data.current = null;
    stopFFmpeg(message.guild.id);
    data.player.stop(true);
    if (connection) connection.destroy();
    return message.reply("Bot đã rời voice.");
  }

  // PLAY
  if (command === "play") {
    const url = args[0];

    if (!url || !/^https?:\/\//i.test(url)) {
      return message.reply("Dùng: `!play <link-audio-trực-tiếp>`");
    }

    if (!memberVoice) {
      return message.reply("Bạn cần vào voice channel trước.");
    }

    if (!connection) {
      const voiceConnection = joinVoiceChannel({
        channelId: memberVoice.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });

      voiceConnection.subscribe(data.player);
    }

    const song = {
      url,
      title: url,
      requestedBy: message.author.username
    };

    data.queue.push(song);

    if (!data.current) {
      playNext(message.guild.id);
      return message.reply("Đang phát audio!");
    }

    return message.reply("Đã thêm vào hàng chờ.");
  }

  // PAUSE
  if (command === "pause") {
    data.player.pause();
    return message.reply("Đã tạm dừng.");
  }

  // RESUME
  if (command === "resume") {
    data.player.unpause();
    return message.reply("Đã phát tiếp.");
  }

  // SKIP
  if (command === "skip") {
    // Tạm tắt loop bài hiện tại để skip thật sự bỏ qua
    if (data.loop === "song") data.current = null;
    stopFFmpeg(message.guild.id);
    data.player.stop(true);
    return message.reply("Đã bỏ qua bài.");
  }

  // STOP
  if (command === "stop") {
    data.queue = [];
    data.loop = "off";
    data.current = null;
    stopFFmpeg(message.guild.id);
    data.player.stop(true);
    return message.reply("Đã dừng nhạc và xóa queue.");
  }

  // QUEUE
  if (command === "queue") {
    if (!data.current && data.queue.length === 0) {
      return message.reply("Queue đang trống.");
    }

    const current = data.current
      ? `🎵 Đang phát: ${data.current.title}\n`
      : "";

    const upcoming = data.queue
      .map((song, i) => `${i + 1}. ${song.title}`)
      .join("\n");

    return message.reply(
      `${current}${upcoming || "Không có bài tiếp theo."}`
    );
  }

  // NOW PLAYING
  if (command === "nowplaying") {
    return message.reply(
      data.current
        ? `🎵 Đang phát: ${data.current.title}`
        : "Hiện không có bài nào đang phát."
    );
  }

  // LOOP
  if (command === "loop") {
    const mode = (args[0] || "song").toLowerCase();

    if (["song", "queue", "off"].includes(mode)) {
      data.loop = mode;
      return message.reply(`Loop mode: **${mode}**`);
    }

    return message.reply("Dùng: `!loop song`, `!loop queue`, `!loop off`");
  }

  // AUTOPLAY TOGGLE
  if (command === "autoplay") {
    data.autoplay = !data.autoplay;
    return message.reply(
      `Autoplay: **${data.autoplay ? "ON" : "OFF"}**`
    );
  }

  // HELP
  if (command === "help") {
    return message.reply(
      [
        "**Lệnh Music Bot**",
        "`!join` - Vào voice",
        "`!leave` - Rời voice",
        "`!play <link>` - Phát audio trực tiếp",
        "`!pause` - Tạm dừng",
        "`!resume` - Phát tiếp",
        "`!skip` - Bỏ bài",
        "`!queue` - Xem queue",
        "`!stop` - Dừng và xóa queue",
        "`!nowplaying` - Xem bài đang phát",
        "`!loop song|queue|off` - Chế độ lặp",
        "`!autoplay` - Bật/tắt autoplay"
      ].join("\n")
    );
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Bot online: ${client.user.tag}`);
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

if (!TOKEN) {
  console.error("Thiếu biến môi trường BOT_TOKEN!");
  process.exit(1);
}

client.login(TOKEN);
