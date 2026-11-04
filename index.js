const { Client, GatewayIntentBits, Events } = require("discord.js");

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

// Lấy tên + link bài (hỗ trợ cả link và từ khóa tìm kiếm)
function getInfo(input) {
  const target = /^https?:\/\//i.test(input) ? input : `scsearch1:${input}`;
  return new Promise((resolve, reject) => {
    execFile(
      YTDLP_PATH,
      ytdlpArgs([
        "--print", "%(title)s",
        "--print", "%(webpage_url)s",
        "-f", "bestaudio/best",
        target
      ]),
      { timeout: 45000, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message).split("\n").filter(Boolean).pop();
          return reject(new Error(msg));
        }
        const [title, url] = stdout.trim().split("\n");
        if (!url) return reject(new Error("Không tìm thấy kết quả."));
        resolve({ title, url });
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

    watchConnection(voiceConnection);
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
    const query = args.join(" ").trim();

    if (!query) {
      return message.reply("Dùng: `!play <link SoundCloud / mp3 hoặc tên bài>`");
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

      watchConnection(voiceConnection);
      voiceConnection.subscribe(data.player);
    }

    if (BLOCKED_SITES.test(query)) {
      return message.reply("Bot không hỗ trợ YouTube. Hãy dùng link SoundCloud, link mp3 trực tiếp, hoặc gõ tên bài.");
    }

    const requestedBy = message.author.username;
    let song;

    if (/^https?:\/\/\S+\.(mp3|ogg|wav|m4a|aac|flac|opus)(\?\S*)?$/i.test(query)) {
      song = { url: query, title: query, direct: true, requestedBy };
    } else {
      const searching = await message.reply("🔎 Đang tìm...");
      try {
        const info = await getInfo(query);
        song = { url: info.url, title: info.title, direct: false, requestedBy };
      } catch (e) {
        console.error("getInfo error:", e.message);
        return searching.edit("Không lấy được bài: " + e.message.slice(0, 300));
      }
    }

    data.queue.push(song);

    if (!data.current) {
      playNext(message.guild.id);
      return message.reply(`🎵 Đang phát: **${song.title}**`);
    }

    return message.reply(`Đã thêm vào hàng chờ: **${song.title}**`);
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
        "```!autoplay``` - Bật/tắt Tự Động Phát Nhạc"
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
