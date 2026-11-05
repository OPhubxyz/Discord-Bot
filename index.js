const { Client, GatewayIntentBits, Events, EmbedBuilder } = require("discord.js");

const {
  joinVoiceChannel,
  getVoiceConnection,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  StreamType,
  VoiceConnectionStatus,
  generateDependencyReport
} = require("@discordjs/voice");

const { spawn, execFile } = require("child_process");
const path = require("path");

// Tìm ffmpeg: ưu tiên bản đóng gói sẵn trong npm, không có thì dùng ffmpeg của hệ thống
const fs = require("fs");
let ffmpegPath = "ffmpeg";
for (const mod of ["@ffmpeg-installer/ffmpeg", "ffmpeg-static"]) {
  try {
    const m = require(mod);
    const p = typeof m === "string" ? m : m.path;
    if (p && fs.existsSync(p)) {
      ffmpegPath = p;
      break;
    }
  } catch (e) {}
}
console.log("FFmpeg dùng:", ffmpegPath);

// ===== yt-dlp (SoundCloud) =====
const BLOCKED_SITES = /(youtube\.com|youtu\.be|youtube-nocookie\.com)/i;
const YTDLP_PATH = path.join(__dirname, "yt-dlp");
const YTDLP_URL =
  "https://github.com/yt-dlp/yt-dlp/releases/latest/download/" +
  (process.arch === "arm64" ? "yt-dlp_linux_aarch64" : "yt-dlp_linux");

// Tự tải yt-dlp về nếu chưa có
async function ensureYtDlp() {
  if (fs.existsSync(YTDLP_PATH)) return;
  console.log("Đang tải yt-dlp...");
  const res = await fetch(YTDLP_URL);
  if (!res.ok) throw new Error("Tải yt-dlp thất bại: HTTP " + res.status);
  fs.writeFileSync(YTDLP_PATH, Buffer.from(await res.arrayBuffer()));
  fs.chmodSync(YTDLP_PATH, 0o755);
  console.log("Đã tải xong yt-dlp.");
}

function ytdlpArgs(extra) {
  return ["--no-playlist", "--no-warnings"].concat(extra);
}

// Lấy metadata bài hát (tên, URL, tác giả, ảnh bìa) từ SoundCloud
function getInfo(input) {
  const target = /^https?:\/\//i.test(input) ? input : `scsearch1:${input}`;
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_PATH,
      ytdlpArgs(["--dump-single-json", "-f", "bestaudio/best", target]),
      { timeout: 45000, maxBuffer: 2 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).split("\n").filter(Boolean).pop();
          return reject(new Error(msg));
        }
        try {
          const info = JSON.parse(stdout);
          if (!info.webpage_url) return reject(new Error("Không tìm thấy kết quả."));
          resolve({
            title: info.title || "Bài hát không rõ tên",
            url: info.webpage_url,
            artist: info.artist || info.creator || info.uploader || "Không rõ tác giả",
            thumbnail: info.thumbnail || null
          });
        } catch (parseError) {
          reject(new Error("Không đọc được thông tin bài hát."));
        }
      }
    );
  });
}

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

// Gắn log trạng thái kết nối voice để dễ tìm lỗi
function watchConnection(conn) {
  if (conn.__watched) return;
  conn.__watched = true;
  conn.on("stateChange", (o, n) => {
    console.log(`Voice: ${o.status} -> ${n.status}`, n.closeCode ? `(close ${n.closeCode})` : "");
  });
  conn.on("error", (e) => console.error("Voice error:", e.message));
}

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
      ffmpeg: null,
      ytdlp: null
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

  const direct = song.direct;
  const inputArgs = direct
    ? ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "5", "-re", "-i", song.url]
    : ["-i", "pipe:0"];

  const ffmpeg = spawn(ffmpegPath, [
    ...inputArgs,
    "-vn",
    "-f", "s16le",
    "-ar", "48000",
    "-ac", "2",
    "pipe:1"
  ]);

  data.ffmpeg = ffmpeg;

  // YouTube / SoundCloud: yt-dlp tải audio rồi đẩy vào ffmpeg
  if (!direct) {
    const ytdlp = spawn(YTDLP_PATH, ytdlpArgs(["-q", "-f", "bestaudio/best", "-o", "-", song.url]));
    data.ytdlp = ytdlp;
    ytdlp.stdout.pipe(ffmpeg.stdin);
    ytdlp.stdout.on("error", () => {});
    ffmpeg.stdin.on("error", () => {});
    ytdlp.stderr.on("data", (c) => console.error("yt-dlp:", c.toString().trim()));
    ytdlp.on("error", (e) => console.error("yt-dlp spawn error:", e.message));
  }

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
  if (data?.ytdlp) {
    data.ytdlp.kill("SIGKILL");
    data.ytdlp = null;
  }
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

  // ===== ADMIN MODERATION COMMANDS =====
  const isAdmin = message.member.permissions.has("Administrator");
  const requireAdmin = () => {
    if (!isAdmin) {
      message.reply("Lệnh này chỉ dành cho Admin server nha ☹️");
      return false;
    }
    return true;
  };

  // BAN: !ban @user [lý do]
  if (command === "ban") {
    if (!requireAdmin()) return;
    const target = message.mentions.members.first() ||
      await message.guild.members.fetch(args[0]).catch(() => null);
    if (!target) return message.reply("Tag hoặc nhập ID thành viên cần ban nha.");
    if (target.id === message.author.id) return message.reply("Bob không ban chính bạn được đâu ☹️");
    if (!target.bannable) return message.reply("Bob không đủ quyền ban thành viên này. Kiểm tra role của Bob nha.");
    const reason = args.slice(1).join(" ") || "Không ghi lý do";
    await target.ban({ reason: reason.slice(0,  reason.length > 500 ? 500 : reason.length) });
    return message.reply(`🔨 Đã ban **${target.user.tag}**. Lý do: ${reason}`);
  }

  // MUTE/TIMEOUT: !mute @user [số phút] [lý do]
  if (command === "mute") {
    if (!requireAdmin()) return;
    const target = message.mentions.members.first() ||
      await message.guild.members.fetch(args[0]).catch(() => null);
    if (!target) return message.reply("Tag hoặc nhập ID thành viên cần mute nha.");
    if (target.id === message.author.id) return message.reply("Bạn không thể tự mute mình đâu ☹️");
    if (!target.moderatable) return message.reply("Bob không đủ quyền timeout thành viên này.");
    const minutes = /^\d+$/.test(args[1] || "") ? Number(args[1]) : 10;
    if (minutes < 1 || minutes > 40320) return message.reply("Thời gian mute từ 1 đến 40320 phút (28 ngày) nha.");
    const reason = args.slice(/^\d+$/.test(args[1] || "") ? 2 : 1).join(" ") || "Không ghi lý do";
    await target.timeout(minutes * 60 * 1000, reason.slice(0, 500));
    return message.reply(`🔇 Đã mute **${target.user.tag}** trong ${minutes} phút. Lý do: ${reason}`);
  }

  // UNMUTE: !unmute @user
  if (command === "unmute") {
    if (!requireAdmin()) return;
    const target = message.mentions.members.first() ||
      await message.guild.members.fetch(args[0]).catch(() => null);
    if (!target) return message.reply("Tag hoặc nhập ID thành viên cần unmute nha.");
    if (!target.moderatable) return message.reply("Bob không đủ quyền gỡ timeout thành viên này.");
    await target.timeout(null, "Timeout được gỡ bởi Admin");
    return message.reply(`🔊 Đã unmute **${target.user.tag}** rồi nha.`);
  }

  // PURGE/CLEAR: !purge [số tin] — tối đa 1000, gồm cả tin cũ hơn 14 ngày
  if (command === "purge") {
    if (!requireAdmin()) return;
    const amount = Number(args[0]);
    if (!Number.isInteger(amount) || amount < 1 || amount > 1000) {
      return message.reply("Dùng `!purge <1-1000>` nha.");
    }

    const collected = [];
    let before;
    while (collected.length < amount) {
      const batch = await message.channel.messages.fetch({
        limit: Math.min(100, amount - collected.length),
        ...(before ? { before } : {})
      });
      if (batch.size === 0) break;

      const eligible = [...batch.values()].filter((msg) => msg.id !== message.id);
      collected.push(...eligible);
      before = batch.last()?.id;
      if (!before || batch.size < Math.min(100, amount - collected.length + eligible.length)) break;
    }

    const selected = collected.slice(0, amount);
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - fourteenDays;
    const recent = selected.filter((msg) => msg.createdTimestamp > cutoff);
    const old = selected.filter((msg) => msg.createdTimestamp <= cutoff);

    let deletedCount = 0;
    for (let i = 0; i < recent.length; i += 100) {
      const group = recent.slice(i, i + 100);
      if (group.length >= 2) {
        const result = await message.channel.bulkDelete(group, true);
        deletedCount += result.size;
      } else if (group.length === 1) {
        await group[0].delete().catch(() => null);
        deletedCount += 1;
      }
    }

    for (const msg of old) {
      await msg.delete().catch(() => null);
      deletedCount += 1;
    }

    await message.delete().catch(() => {});
    const notice = await message.channel.send(`🧹 Bob đã xử lý xoá ${deletedCount} tin nhắn nha.`);
    setTimeout(() => notice.delete().catch(() => {}), 8000);
    return;
  }

  // JOIN
  if (command === "join") {
    if (!memberVoice) {
      return message.reply("Bạn phải vào voice channel trước đã nha, Bob 🐙 không biết vào đâu hết á ☹️");
    }

    const voiceConnection = joinVoiceChannel({
      channelId: memberVoice.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator
    });

    watchConnection(voiceConnection);
    voiceConnection.subscribe(data.player);
    return message.reply(`Bob 🐙 đã vào voice: **${memberVoice.name}** rồi nè <3`);
  }

  // LEAVE
  if (command === "leave") {
    data.queue = [];
    data.loop = "off";
    data.current = null;
    stopFFmpeg(message.guild.id);
    data.player.stop(true);
    if (connection) connection.destroy();
    return message.reply("Bob 🐙 đi ngủ đây, đã rời voice và xoá hàng chờ ☹️");
  }

  // PLAY
  if (command === "play") {
    const query = args.join(" ").trim();

    if (!query) {
      return message.reply("Bob 🐙 chưa biết hát gì hết á, dùng: `!play <link/tên bài sound cloud>` nha :)))");
    }

    if (!memberVoice) {
      return message.reply("Bạn vào voice channel trước đã nha, Bob 🐙 mới hát được <3");
    }

    if (!connection) {
      const voiceConnection = joinVoiceChannel({
        channelId: memberVoice.id,
        guildId: message.guild.id,
        adapterCreator: message.guild.voiceAdapterCreator
      });

      watchConnection(voiceConnection);
      voiceConnection.subscribe(data.player);
    }

    if (BLOCKED_SITES.test(query)) {
      return message.reply("Bob 🐙 không hát nhạc YouTube đâu nha ☹️ Dùng link SoundCloud, link mp3 hoặc gõ tên bài nè <3");
    }

    const requestedBy = message.author.username;
    let song;
    const searchingEmbed = new EmbedBuilder()
      .setColor(0x5865F2)
      .setDescription("**Bob 🐙 đang tìm bài hát...** <a:bobsearch:1567556819155419187>\nĐợi Bob một xíu nha <3");
    const searching = await message.reply({ embeds: [searchingEmbed] });

    if (/^https?:\/\/\S+\.(mp3|ogg|wav|m4a|aac|flac|opus)(\?\S*)?$/i.test(query)) {
      song = { url: query, title: query, artist: "Không rõ tác giả", thumbnail: null, direct: true, requestedBy };
    } else {
      try {
        const info = await getInfo(query);
        song = { url: info.url, title: info.title, artist: info.artist, thumbnail: info.thumbnail, direct: false, requestedBy };
      } catch (e) {
        console.error("getInfo error:", e.message);
        return searching.edit({ embeds: [new EmbedBuilder()
          .setColor(0xED4245)
          .setDescription("Bob 🐙 không tìm được bài này ☹️\nLỗi: " + e.message.slice(0, 300))] });
      }
    }

    const resultEmbed = new EmbedBuilder()
      .setColor(0x57F287)
      .setTitle("🎵 " + song.title.slice(0, 250))
      .addFields(
        { name: "🎤 Tên tác giả", value: String(song.artist || "Không rõ tác giả").slice(0, 1024), inline: true },
        { name: "💗 Tim", value: "❤️", inline: true }
      )
      .setFooter({ text: "Bob 🐙 • Yêu cầu bởi " + requestedBy });
    if (song.thumbnail && /^https?:\/\//i.test(song.thumbnail)) {
      resultEmbed.setThumbnail(song.thumbnail);
    }
    await searching.edit({ embeds: [resultEmbed] });
    await searching.react("❤️").catch(() => {});

    data.queue.push(song);

    if (!data.current) {
      playNext(message.guild.id);
      return message.reply(`🎵 Bob 🐙 bắt đầu hát: **${song.title}** :)))`);
    }

    return message.reply(`Bob 🐙 đã thêm vào hàng chờ: **${song.title}** <3`);
  }

  // PAUSE
  if (command === "pause") {
    data.player.pause();
    return message.reply("Bob 🐙 tạm dừng rồi nè ⏸️");
  }

  // RESUME
  if (command === "resume") {
    data.player.unpause();
    return message.reply("Bob 🐙 hát tiếp nè ▶️");
  }

  // SKIP
  if (command === "skip") {
    // Tạm tắt loop bài hiện tại để skip thật sự bỏ qua
    if (data.loop === "song") data.current = null;
    stopFFmpeg(message.guild.id);
    data.player.stop(true);
    return message.reply("Bob 🐙 đã bỏ qua bài này, qua bài tiếp nha ⏭️");
  }

  // STOP
  if (command === "stop") {
    data.queue = [];
    data.loop = "off";
    data.current = null;
    stopFFmpeg(message.guild.id);
    data.player.stop(true);
    return message.reply("Bob 🐙 dừng hát và xoá hàng chờ rồi nha ☹️");
  }

  // QUEUE
  if (command === "queue") {
    if (!data.current && data.queue.length === 0) {
      return message.reply("Hàng chờ trống trơn á, thêm bài đi nè :)))");
    }

    const current = data.current
      ? `🎵 Bob 🐙 đang hát: ${data.current.title}\n`
      : "";

    const upcoming = data.queue
      .map((song, i) => `${i + 1}. ${song.title}`)
      .join("\n");

    return message.reply(
      `${current}${upcoming || "Chưa có bài nào tiếp theo hết <3"}`
    );
  }

  // NOW PLAYING
  if (command === "nowplaying") {
    return message.reply(
      data.current
        ? `🎵 Bob 🐙 đang hát: ${data.current.title}`
        : "Bob 🐙 đang rảnh, chưa hát bài nào hết á :)))"
    );
  }

  // LOOP
  if (command === "loop") {
    const mode = (args[0] || "song").toLowerCase();

    if (["song", "queue", "off"].includes(mode)) {
      data.loop = mode;
      return message.reply(`Bob 🐙 đã chỉnh chế độ lặp: **${mode}** <3`);
    }

    return message.reply("Dùng: `!loop song`, `!loop queue`, `!loop off` nha ☹️");
  }

  // AUTOPLAY TOGGLE
  if (command === "autoplay") {
    data.autoplay = !data.autoplay;
    return message.reply(
      `Bob 🐙 đã ${data.autoplay ? "bật" : "tắt"} tự động phát nhạc: **${data.autoplay ? "ON" : "OFF"}**`
    );
  }

  // HELP
  if (command === "help" || command === "cmd") {
    return message.reply(
      [
        "**📜 Danh sách lệnh Của Bob**",
        "```!cmd``` / ```!help``` - Lệnh Hỗ Trợ <3",
        "```!join``` - Bob join vào voice của bạn 🐙",
        "```!leave``` - Bob rời voice xoá hàng chờ nhạc ☹️",
        "```!play <link/tên bài chỉ sound cloud>``` - Bob 🐙 Hát :)))",
        "```!pause``` - Tạm dừng nhạc ▶️",
        "```!resume``` - Tiếp Tục Phát Nhạc ⏸️",
        "```!skip``` - Phát Bài Tiếp Theo",
        "```!stop``` - Dừng Phát Nhạc Và Xoá Hàng Chờ",
        "```!queue``` - Xem hàng chờ",
        "```!nowplaying``` - Xem bài đang phát",
        "```!loop song|queue|off``` - Chế độ lặp lại",
        "```!autoplay``` - Bật/tắt Tự Động Phát Nhạc",
        " **🛡️ Lệnh Admin**",
        "```!ban @user [lý do]``` - Ban thành viên",
        "```!mute @user [phút] [lý do]``` - Timeout thành viên (mặc định 10 phút)",
        "```!unmute @user``` - Gỡ timeout",
        "```!purge <1-1000>``` - Xoá tối đa 1000 tin (kể cả tin cũ)",

      ].join("\n")
    );
  }
});

client.once(Events.ClientReady, () => {
  console.log(`Bot online: ${client.user.tag}`);
  console.log(generateDependencyReport());
  ensureYtDlp().catch((e) => console.error("Lỗi yt-dlp:", e.message));
});

process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
});

if (!TOKEN) {
  console.error("Thiếu biến môi trường BOT_TOKEN!");
  process.exit(1);
}

client.login(TOKEN);
