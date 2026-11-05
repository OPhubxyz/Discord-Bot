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

    player.on(AudioPlayerStatus.Idle, async () => {
      const data = music.get(guildId);
      if (!data) return;

      const finished = data.current;
      if (data.loop === "song" && finished) {
        data.queue.unshift(finished);
      } else if (data.loop === "queue" && finished) {
        data.queue.push(finished);
      }

      data.current = null;
      if (data.queue.length === 0 && data.autoplay && finished && !finished.direct) {
        try {
          const query = `scsearch5:${finished.artist || ""} similar to ${finished.title || ""}`;
          const info = await new Promise((resolve, reject) => {
            execFile(YTDLP_PATH, ytdlpArgs(["--dump-single-json", query]),
              { timeout: 45000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) return reject(new Error((stderr || err.message).split("\\n").filter(Boolean).pop()));
                try {
                  const result = JSON.parse(stdout);
                  const entries = result.entries || [result];
                  const next = entries.find((entry) => entry && entry.webpage_url && entry.webpage_url !== finished.url);
                  if (!next) return reject(new Error("Không tìm được bài gợi ý"));
                  resolve(next);
                } catch (e) { reject(e); }
              });
          });
          data.queue.push({
            url: info.webpage_url,
            title: info.title || "Bài gợi ý",
            artist: info.artist || info.creator || info.uploader || "Không rõ tác giả",
            thumbnail: info.thumbnail || null,
            direct: false,
            requestedBy: "Bob Autoplay"
          });
          console.log("Autoplay queued:", info.title);
        } catch (e) {
          console.error("Autoplay search failed:", e.message);
        }
      }
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

// Standard English response embed for command messages
function commandResponseEmbed(text) {
  const raw = String(text);
  const translations = [
    ["Lệnh này chỉ dành cho Admin server nha ☹️", "This command is restricted to server administrators."],
    ["Tag hoặc nhập ID thành viên cần ban nha.", "Please mention or provide the ID of the member to ban."],
    ["Bob không ban chính bạn được đâu ☹️", "You cannot ban yourself."],
    ["Bob không đủ quyền ban thành viên này. Kiểm tra role của Bob nha.", "I cannot ban this member. Please check my role permissions."],
    ["Tag hoặc nhập ID thành viên cần mute nha.", "Please mention or provide the ID of the member to mute."],
    ["Bạn không thể tự mute mình đâu ☹️", "You cannot timeout yourself."],
    ["Bob không đủ quyền timeout thành viên này.", "I do not have permission to timeout this member."],
    ["Tag hoặc nhập ID thành viên cần unmute nha.", "Please mention or provide the ID of the member to unmute."],
    ["Bob không đủ quyền gỡ timeout thành viên này.", "I do not have permission to remove this member's timeout."],
    ["Tag hoặc nhập ID thành viên cần ban nha.", "Please mention or provide the ID of the member to ban."],
    ["Bạn phải vào voice channel trước đã nha, Bob 🐙 không biết vào đâu hết á ☹️", "Please join a voice channel first."],
    ["Bạn vào voice channel trước đã nha, Bob 🐙 mới hát được <3", "Please join a voice channel before requesting playback."],
    ["Bob 🐙 không hát nhạc YouTube đâu nha ☹️ Dùng link SoundCloud, link mp3 hoặc gõ tên bài nè <3", "YouTube is not supported. Use a SoundCloud link, an MP3 link, or search by song title."],
    ["Bob 🐙 chưa biết hát gì hết á, dùng: `!play <link/tên bài sound cloud>` nha :)))", "Please provide a SoundCloud link or song title: `!play <link/song title>`."],
    ["Bob 🐙 chưa có bài nào để bỏ qua hết á ☹️", "There is no track to skip."],
    ["Hàng chờ trống trơn á, thêm bài đi nè :)))", "The queue is empty. Add a track to get started."],
    ["Bob 🐙 tạm dừng rồi nè ⏸️", "Playback has been paused."],
    ["Bob 🐙 hát tiếp nè ▶️", "Playback has resumed."],
    ["Bob 🐙 dừng hát và xoá hàng chờ rồi nha ☹️", "Playback stopped and the queue has been cleared."],
    ["Bob 🐙 đi ngủ đây, đã rời voice và xoá hàng chờ ☹️", "Disconnected from voice and cleared the queue."],
    ["Bob 🐙 đã bỏ qua bài này, qua bài tiếp nha ⏭️", "Skipped the current track."],
    ["Dùng: `!loop song`, `!loop queue`, `!loop off` nha ☹️", "Usage: `!loop song`, `!loop queue`, or `!loop off`."],
    ["Bob 🐙 đang rảnh, chưa hát bài nào hết á :)))", "No track is currently playing."],
    ["Bob 🐙 không tìm được bài này ☹️", "I could not find that track."],
  ];
  let message = raw;
  for (const [vi, en] of translations) message = message.replace(vi, en);
  message = message
    .replace(/Bob 🐙 đã vào voice: \*\*(.*?)\*\* rồi nè <3/, "Connected to voice channel: **$1**.")
    .replace(/🎵 Bob 🐙 bắt đầu hát: \*\*(.*?)\*\* :\)\)/, "Now playing: **$1**.")
    .replace(/Bob 🐙 đã thêm vào hàng chờ: \*\*(.*?)\*\* <3/, "Added to queue: **$1**.")
    .replace(/🎵 Bob 🐙 đang hát: (.*)/, "Now playing: $1")
    .replace(/Bob 🐙 đã mute \*\*(.*?)\*\* trong (\d+) phút\. Lý do: (.*)/, "Timed out **$1** for $2 minutes. Reason: $3")
    .replace(/🔊 Đã unmute \*\*(.*?)\*\* rồi nha\./, "Removed timeout for **$1**.")
    .replace(/🔨 Đã ban \*\*(.*?)\*\*\. Lý do: (.*)/, "Banned **$1**. Reason: $2")
    .replace(/Bob 🐙 đã chỉnh chế độ lặp: \*\*(.*?)\*\* <3/, "Loop mode set to **$1**.")
    .replace(/Bob 🐙 đã (bật|tắt) tự động phát nhạc: \*\*(ON|OFF)\*\*/, "Autoplay **$2**.")
    .replace(/Dùng `!purge <1-1000>` nha\./, "Usage: `!purge <1-1000>`.")
    .replace(/Thời gian mute từ 1 đến 40320 phút \(28 ngày\) nha\./, "Timeout duration must be between 1 and 40,320 minutes (28 days).");
  const lower = raw.toLowerCase();
  const fail = /không đủ quyền|không tìm|chưa có bài|chưa biết|không thể|phải vào|dùng:|thời gian mute|tag hoặc nhập|youtube/i.test(lower);
  const inProgress = /đang tìm|đợi bob/i.test(lower);
  const color = fail ? 0xED4245 : inProgress ? 0xFEE75C : 0x57F287;
  return new EmbedBuilder()
    .setColor(color)
    .setTitle("Bob • Command Menu")
    .addFields({ name: "**Message**", value: message.slice(0, 4000) });
}

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.guild) return;
  if (!message.content.startsWith(PREFIX)) return;

  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const command = args.shift()?.toLowerCase();

  const originalReply = message.reply.bind(message);
  message.reply = (payload, options) => typeof payload === "string"
    ? originalReply({ embeds: [commandResponseEmbed(payload)] }, options)
    : originalReply(payload, options);

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
    const notice = await message.channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle("Bob • Command Menu").addFields({ name: "**Message**", value: `Deleted ${deletedCount} messages.` })] });
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
      .setDescription("**Searching for a track...** <a:bobsearch:1567556819155419187>\nPlease wait.");
    const searching = await message.reply({ embeds: [searchingEmbed] });

    if (/^https?:\/\/\S+\.(mp3|ogg|wav|m4a|aac|flac|opus)(\?\S*)?$/i.test(query)) {
      song = { url: query, title: query, artist: "Không rõ tác giả", thumbnail: null, direct: true, requestedBy };
    } else {
      try {
        const info = await getInfo(query);
        song = { url: info.url, title: info.title, artist: info.artist, thumbnail: info.thumbnail, likes: info.likes, comments: info.comments, direct: false, requestedBy };
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
        { name: "🎤 Artist", value: String(song.artist || "Không rõ tác giả").slice(0, 1024), inline: true },
        { name: "💗 Likes", value: song.likes == null ? "Không rõ" : String(song.likes), inline: true },
        { name: "💬 Comments", value: song.comments == null ? "Không rõ" : String(song.comments), inline: true }
      )
      .setFooter({ text: "Bob • Requested by " + requestedBy });
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
    if (!data.current && data.queue.length === 0) {
      return message.reply("Bob 🐙 chưa có bài nào để bỏ qua hết á ☹️");
    }
    data.loop = "off";
    const wasPlaying = Boolean(data.current);
    data.current = null;
    stopFFmpeg(message.guild.id);
    if (wasPlaying) {
      data.player.stop(true); // Idle event tự chuyển sang bài tiếp
    } else {
      playNext(message.guild.id); // Player đang Idle, không có bài hiện tại
    }
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
        "**📜 Bob Command Menu**",
        "```!cmd``` / ```!help``` - Show command help",
        "```!join``` - Join your voice channel",
        "```!leave``` - Leave voice and clear the queue",
        "```!play <SoundCloud link/song title>``` - Play a track",
        "```!pause``` - Pause playback",
        "```!resume``` - Resume playback",
        "```!skip``` - Skip the current track",
        "```!stop``` - Stop playback and clear the queue",
        "```!queue``` - View the queue",
        "```!nowplaying``` - View the current track",
        "```!loop song|queue|off``` - Set repeat mode",
        "```!autoplay``` - Toggle autoplay",
        "**🛡️ Admin Commands**",
        "```!ban @user [reason]``` - Ban a member",
        "```!mute @user [minutes] [reason]``` - Timeout a member (default: 10 minutes)",
        "```!unmute @user``` - Remove a timeout",
        "```!purge <1-1000>``` - Delete up to 1,000 messages (including older messages)",

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
