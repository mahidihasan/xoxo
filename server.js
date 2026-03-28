require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const { spawn } = require("child_process");
const { Readable } = require("stream");
const { pipeline } = require("stream/promises");
const fs = require("fs");
const path = require("path");
const os = require("os");

const PORT = process.env.PORT || 3000;
const YTDLP_BIN = process.env.YTDLP_BIN || "yt-dlp";
const YTDLP_BIN_CONFIG = process.env.YTDLP_BIN || "";
const YTDLP_COOKIES = process.env.YTDLP_COOKIES || "";
const YTDLP_COOKIES_TEXT = process.env.YTDLP_COOKIES_TEXT || "";
const YTDLP_COOKIES_B64 = process.env.YTDLP_COOKIES_B64 || "";
const YTDLP_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || "youtube:player_client=android,web";
const YTDLP_FORCE_IPV4 = String(process.env.YTDLP_FORCE_IPV4 || "false").toLowerCase() === "true";
const FFMPEG_BIN = process.env.FFMPEG_BIN || "";
const FFMPEG_DISABLE_STATIC = String(process.env.FFMPEG_DISABLE_STATIC || "false").toLowerCase() === "true";
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 30000);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 60_000);
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 60);
const INFO_CACHE_TTL_MS = Number(process.env.INFO_CACHE_TTL_MS || 60_000);
const BASIC_AUTH_USER = process.env.BASIC_AUTH_USER || "";
const BASIC_AUTH_PASS = process.env.BASIC_AUTH_PASS || "";

const app = express();
const infoCache = new Map();
app.disable("x-powered-by");
// Required behind reverse proxies (Render/Vercel) for correct client IP/rate-limit behavior.
app.set("trust proxy", 1);
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": ["'self'"],
      "script-src-attr": ["'none'"],
      "style-src": ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      "img-src": ["'self'", "https:", "data:", "blob:"],
      "connect-src": ["'self'", "https:"],
      "font-src": ["'self'", "https://fonts.gstatic.com", "data:"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "frame-ancestors": ["'none'"],
    },
  },
}));
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

app.get("/favicon.ico", (_req, res) => res.redirect(302, "/xox-logo.png"));

app.use(express.static(require("path").join(process.cwd(), "public"), { extensions: ["html"] }));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});
app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/runtime", (_req, res) => {
  try {
    const resolved = resolveYtDlpBin();
    const ffmpeg = resolveFfmpegBin();
    const cookiesInfo = resolveCookiesFile();
    res.json({
      ok: true,
      node: process.version,
      platform: process.platform,
      ytdlpBinConfigured: YTDLP_BIN_CONFIG || null,
      ytdlpResolvedPath: resolved,
      ytdlpResolvedExists: !!(resolved && fs.existsSync(resolved)),
      ytdlpResolvedBase: resolved ? path.basename(resolved) : null,
      ffmpegBinConfigured: FFMPEG_BIN || null,
      ffmpegResolvedPath: ffmpeg,
      ffmpegResolvedExists: !!(ffmpeg && fs.existsSync(ffmpeg)),
      cookiesConfigured: !!(cookiesInfo && cookiesInfo.path),
      cookiesSource: cookiesInfo ? cookiesInfo.source : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "runtime check failed" });
  }
});

app.get("/api/selftest", async (_req, res) => {
  try {
    const version = await runYtDlp(["--version"]);
    res.json({ ok: true, version });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || "selftest failed" });
  }
});

const limiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api", limiter, basicAuthMiddleware);

app.post("/api/info", async (req, res) => {
  try {
    const { url, type } = req.body || {};
    if (!url || !isValidUrl(url)) {
      return res.status(400).json({ error: "Invalid URL" });
    }

    const cacheKey = `${type || "video"}|${url}`;
    const cached = infoCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return res.json(cached.payload);
    }

    const infoRaw = await runYtDlp(["-J", "--no-playlist", url]);
    const info = JSON.parse(infoRaw);

    const platform = detectPlatform(url) || info.extractor || "unknown";
    const title = info.title || "Unknown media";
    const duration = info.duration_string || formatDuration(info.duration);
    const thumb = info.thumbnail || null;

    let formats = buildFormats(info, type || "video", url, title, platform);
    if (!Array.isArray(formats) || formats.length === 0) {
      formats = buildDefaultFormats(type || "video", url, title, info, platform);
    }

    const payload = {
      title,
      thumb,
      duration,
      platform,
      formats
    };

    infoCache.set(cacheKey, { payload, expiresAt: Date.now() + INFO_CACHE_TTL_MS });
    res.json(payload);
  } catch (err) {
    const msg = err.message || "Failed to fetch media info";
    if (isYouTubeBlockedError(msg)) {
      return res.status(429).json({
        error: "YouTube is rate-limiting this server right now. Try another video, wait a few minutes, or configure YTDLP_COOKIES on the backend."
      });
    }
    res.status(500).json({ error: msg });
  }
});

app.get("/api/download", async (req, res) => {
  try {
    const direct = req.query.direct;
    const sourceUrl = req.query.url;
    const formatId = req.query.format;
    const title = req.query.title || "download";
    const ext = req.query.ext || "";
    const type = req.query.type || "video";
    const viaYtdlp = String(req.query.via || "").toLowerCase() === "ytdlp";

    let downloadUrl = null;
    let multiStream = false;
    if (direct) {
      if (!isValidUrl(direct)) {
        return res.status(400).json({ error: "Invalid direct URL" });
      }
      downloadUrl = direct;
    } else {
      if (!sourceUrl || !formatId || !isValidUrl(sourceUrl)) {
        return res.status(400).json({ error: "Missing url or format" });
      }
      const out = await runYtDlp(["-f", String(formatId), "-g", "--no-playlist", sourceUrl]);
      const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      downloadUrl = lines[0];
      multiStream = lines.length > 1;
      if (!downloadUrl) {
        return res.status(500).json({ error: "Failed to resolve download URL" });
      }
    }

    const isM3U8 = isLikelyM3U8(downloadUrl);

    if (!direct && (multiStream || viaYtdlp || isM3U8)) {
      return await downloadAndMergeWithYtDlp({
        res,
        sourceUrl,
        formatId: String(formatId),
        title,
        ext,
        type,
      });
    }

    const resp = await fetch(downloadUrl, { redirect: "follow" });
    if (!resp.ok) {
      return res.status(resp.status).json({ error: "Upstream download failed" });
    }

    const filename = sanitizeFilename(title) + (ext ? "." + ext : "");
    res.setHeader("Content-Disposition", `attachment; filename=\"${filename}\"`);
    const contentType = resp.headers.get("content-type");
    if (contentType) {
      res.setHeader("Content-Type", contentType);
      if (!direct && isLikelyM3U8(downloadUrl, contentType)) {
        return await downloadAndMergeWithYtDlp({
          res,
          sourceUrl,
          formatId: String(formatId),
          title,
          ext,
          type,
        });
      }
    }
    if (resp.headers.get("content-length")) {
      res.setHeader("Content-Length", resp.headers.get("content-length"));
    }
    res.setHeader("Cache-Control", "no-store");

    if (!resp.body) {
      return res.status(502).json({ error: "Upstream returned an empty body" });
    }

    const nodeStream = Readable.fromWeb(resp.body);
    nodeStream.on("error", (streamErr) => {
      if (!res.headersSent) {
        res.status(502).json({ error: streamErr.message || "Stream failed" });
      } else {
        res.destroy(streamErr);
      }
    });

    await pipeline(nodeStream, res);
  } catch (err) {
    res.status(500).json({ error: err.message || "Download failed" });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`xoxo downloader backend listening on http://localhost:${PORT}`);
  });
}

module.exports = app;

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const bin = resolveYtDlpBin();
    if (YTDLP_BIN_CONFIG && !fs.existsSync(bin)) {
      return reject(new Error(`YTDLP_BIN is set but file not found at: ${bin}`));
    }
    const extraArgs = [];
    if (YTDLP_FORCE_IPV4) extraArgs.push("-4");
    if (YTDLP_EXTRACTOR_ARGS) extraArgs.push("--extractor-args", YTDLP_EXTRACTOR_ARGS);
    const cookiesInfo = resolveCookiesFile();
    if (cookiesInfo && cookiesInfo.path) extraArgs.push("--cookies", cookiesInfo.path);
    const child = spawn(bin, [...extraArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp timeout"));
    }, REQUEST_TIMEOUT_MS);

    child.stdout.on("data", d => { stdout += d.toString(); });
    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", err => {
      clearTimeout(timer);
      if (err && err.code === "ENOENT") {
        return reject(new Error("yt-dlp not found. Set YTDLP_BIN or add yt-dlp to PATH."));
      }
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
      resolve(stdout.trim());
    });
  });
}

function runYtDlpToFile(args) {
  return new Promise((resolve, reject) => {
    const bin = resolveYtDlpBin();
    if (YTDLP_BIN_CONFIG && !fs.existsSync(bin)) {
      return reject(new Error(`YTDLP_BIN is set but file not found at: ${bin}`));
    }
    const extraArgs = [];
    if (YTDLP_FORCE_IPV4) extraArgs.push("-4");
    if (YTDLP_EXTRACTOR_ARGS) extraArgs.push("--extractor-args", YTDLP_EXTRACTOR_ARGS);
    const cookiesInfo = resolveCookiesFile();
    if (cookiesInfo && cookiesInfo.path) extraArgs.push("--cookies", cookiesInfo.path);
    const ffmpeg = resolveFfmpegBin();
    if (ffmpeg && fs.existsSync(ffmpeg)) {
      extraArgs.push("--ffmpeg-location", ffmpeg);
    }

    const child = spawn(bin, [...extraArgs, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("yt-dlp timeout"));
    }, REQUEST_TIMEOUT_MS);

    child.stderr.on("data", d => { stderr += d.toString(); });
    child.on("error", err => {
      clearTimeout(timer);
      if (err && err.code === "ENOENT") {
        return reject(new Error("yt-dlp not found. Set YTDLP_BIN or add yt-dlp to PATH."));
      }
      reject(err);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr || `yt-dlp exited with code ${code}`));
      }
      resolve();
    });
  });
}

async function downloadAndMergeWithYtDlp({ res, sourceUrl, formatId, title, ext, type }) {
  const safeTitle = sanitizeFilename(title) || "download";
  const fileExt = ext || "mp4";
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "xoxo-"));
  const outPath = path.join(tmpDir, `${safeTitle}.${fileExt}`);

  try {
    const args = [
      "-f", formatId,
      "--no-playlist",
      "-o", outPath,
      sourceUrl
    ];
    if (type === "video" && fileExt) {
      args.splice(4, 0, "--merge-output-format", fileExt);
    }
    await runYtDlpToFile(args);

    if (!fs.existsSync(outPath)) {
      return res.status(500).json({ error: "Download failed to produce output file" });
    }

    res.setHeader("Content-Disposition", `attachment; filename=\"${safeTitle}.${fileExt}\"`);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");

    const stream = fs.createReadStream(outPath);
    stream.on("error", (err) => {
      if (!res.headersSent) {
        res.status(502).json({ error: err.message || "Stream failed" });
      } else {
        res.destroy(err);
      }
    });
    stream.on("close", () => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
    return stream.pipe(res);
  } catch (err) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return res.status(500).json({ error: err.message || "Merge download failed" });
  }
}

function resolveYtDlpBin() {
  if (YTDLP_BIN_CONFIG) return YTDLP_BIN_CONFIG;

  const bundled = resolveBundledYtDlpBin();
  if (bundled) return bundled;

  if (YTDLP_BIN && fs.existsSync(YTDLP_BIN)) return YTDLP_BIN;
  const candidates = [
    "C:\\Users\\Asus\\AppData\\Local\\Microsoft\\WinGet\\Packages\\yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe\\yt-dlp.exe",
    "C:\\Program Files\\yt-dlp\\yt-dlp.exe",
    "C:\\Program Files (x86)\\yt-dlp\\yt-dlp.exe",
    "/opt/render/project/.local/bin/yt-dlp",
    "/usr/bin/yt-dlp",
    "/usr/local/bin/yt-dlp",
    "/opt/homebrew/bin/yt-dlp"
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return "yt-dlp";
}

function resolveBundledYtDlpBin() {
  const disableStatic = String(process.env.YTDLP_DISABLE_STATIC || "false").toLowerCase() === "true";
  if (disableStatic) return "";

  try {
    const bundled = require("yt-dlp-static");
    if (typeof bundled === "string" && fs.existsSync(bundled)) {
      return bundled;
    }
    if (bundled && bundled.path && fs.existsSync(bundled.path)) {
      return bundled.path;
    }
  } catch (_err) {
    // Optional dependency path resolution; fall back to env/PATH checks.
  }
  return "";
}

function resolveFfmpegBin() {
  if (FFMPEG_BIN) return FFMPEG_BIN;
  if (FFMPEG_DISABLE_STATIC) return "ffmpeg";

  try {
    const ffmpeg = require("ffmpeg-static");
    if (typeof ffmpeg === "string" && fs.existsSync(ffmpeg)) {
      return ffmpeg;
    }
  } catch (_err) {
    // Optional dependency path resolution; fall back to PATH.
  }
  return "ffmpeg";
}

function resolveCookiesFile() {
  if (YTDLP_COOKIES && fs.existsSync(YTDLP_COOKIES)) {
    return { path: YTDLP_COOKIES, source: "file" };
  }

  if (YTDLP_COOKIES_TEXT) {
    return { path: ensureCookiesFile(YTDLP_COOKIES_TEXT), source: "text" };
  }

  if (YTDLP_COOKIES_B64) {
    try {
      const text = Buffer.from(YTDLP_COOKIES_B64, "base64").toString("utf8");
      if (text) return { path: ensureCookiesFile(text), source: "base64" };
    } catch {
      return { path: "", source: "invalid-base64" };
    }
  }

  return { path: "", source: "none" };
}

function shouldUseYtdlpDownload(platform) {
  const force = String(process.env.YTDLP_FORCE_DOWNLOAD || "false").toLowerCase() === "true";
  const cookiesInfo = resolveCookiesFile();
  if (force) return true;
  if (cookiesInfo && cookiesInfo.path) return true;
  if (!platform) return false;

  const p = String(platform).toLowerCase();
  return [
    "pornhub",
    "xvideos",
    "xnxx",
    "xhamster",
    "youporn",
    "redtube",
    "tube8",
    "spankbang",
    "beeg",
    "eporner",
    "hentaifox",
    "hanime",
    "redgifs"
  ].includes(p);
}

function ensureCookiesFile(content) {
  const dir = path.join(os.tmpdir(), "xoxo-cookies");
  const file = path.join(dir, "cookies.txt");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, content, "utf8");
  }
  return file;
}

function basicAuthMiddleware(req, res, next) {
  if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) return next();
  const auth = req.headers.authorization || "";
  const [type, value] = auth.split(" ");
  if (type !== "Basic" || !value) {
    res.setHeader("WWW-Authenticate", "Basic");
    return res.status(401).json({ error: "Authentication required" });
  }
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  if (user !== BASIC_AUTH_USER || pass !== BASIC_AUTH_PASS) {
    res.setHeader("WWW-Authenticate", "Basic");
    return res.status(401).json({ error: "Invalid credentials" });
  }
  return next();
}

function buildFormats(info, type, sourceUrl, title, platform) {
  const baseVia = shouldUseYtdlpDownload(platform) ? "&via=ytdlp" : "";
  const typeParam = `&type=${encodeURIComponent(type)}`;
  if (type === "image") {
    const thumbs = Array.isArray(info.thumbnails) ? [...info.thumbnails] : [];
    if (info.thumbnail) {
      thumbs.push({ url: info.thumbnail, width: info.width || 0 });
    }
    const sorted = thumbs
      .filter(t => t && t.url)
      .sort((a, b) => (b.width || 0) - (a.width || 0));
    const list = uniqueBy(sorted, t => t.url).slice(0, 20);
    return list.map((t) => ({
      url: `/api/download?direct=${encodeURIComponent(t.url)}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent(guessExt(t.url) || "jpg")}${typeParam}`,
      label: t.width ? `${t.width}px` : "Image",
      ext: guessExt(t.url) || "jpg",
      type: "image",
    }));
  }

  const formats = (Array.isArray(info.formats) ? info.formats : []).filter(f => f && f.format_id);

  if (type === "audio") {
    const audioOnly = formats.filter(f => f.acodec && f.acodec !== "none" && (f.vcodec === "none" || !f.vcodec));
    const audioFallback = formats.filter(f => f.acodec && f.acodec !== "none");
    const audio = (audioOnly.length ? audioOnly : audioFallback)
      .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))
      .slice(0, 20);
    return uniqueBy(audio, f => f.format_id).map((f) => ({
      url: `/api/download?url=${encodeURIComponent(sourceUrl)}&format=${encodeURIComponent(f.format_id)}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent(f.ext || f.audio_ext || "m4a")}${typeParam}${baseVia}`,
      label: f.abr ? `${Math.round(f.abr)} kbps` : "Audio",
      ext: f.ext || f.audio_ext || "m4a",
      type: "audio",
    }));
  }

  const videoCombined = formats.filter(f => f.vcodec && f.vcodec !== "none" && f.acodec && f.acodec !== "none");
  const videoOnly = formats.filter(f => f.vcodec && f.vcodec !== "none" && (f.acodec === "none" || !f.acodec));
  const selected = (videoCombined.length ? videoCombined : videoOnly)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || (b.tbr || 0) - (a.tbr || 0))
    .slice(0, 20);

  return uniqueBy(selected, f => f.format_id).map((f) => {
    const formatSelector = (videoCombined.length || !videoOnly.length) ? f.format_id : `${f.format_id}+bestaudio/best`;
    const via = (baseVia || isM3U8Format(f)) ? "&via=ytdlp" : "";
    return {
      url: `/api/download?url=${encodeURIComponent(sourceUrl)}&format=${encodeURIComponent(formatSelector)}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent(f.ext || "mp4")}${typeParam}${via}`,
      label: f.height ? `${f.height}p` : (f.format_note || "Video"),
      ext: f.ext || "mp4",
      type: "video",
    };
  });
}

function buildDefaultFormats(type, sourceUrl, title, info, platform) {
  const useYtdlpDownload = shouldUseYtdlpDownload(platform);
  const via = useYtdlpDownload ? "&via=ytdlp" : "";
  const typeParam = `&type=${encodeURIComponent(type)}`;
  if (type === "audio") {
    return [{
      url: `/api/download?url=${encodeURIComponent(sourceUrl)}&format=${encodeURIComponent("bestaudio/best")}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent("mp3")}${typeParam}${via}`,
      label: "Best audio",
      ext: "mp3",
      type: "audio",
    }];
  }

  if (type === "image") {
    const thumb = info && info.thumbnail;
    if (thumb) {
      return [{
        url: `/api/download?direct=${encodeURIComponent(thumb)}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent(guessExt(thumb) || "jpg")}${typeParam}`,
        label: "Original",
        ext: guessExt(thumb) || "jpg",
        type: "image",
      }];
    }
  }

  return [{
    url: `/api/download?url=${encodeURIComponent(sourceUrl)}&format=${encodeURIComponent("bestvideo*+bestaudio/best")}&title=${encodeURIComponent(title)}&ext=${encodeURIComponent("mp4")}${typeParam}${via}`,
    label: "Best available",
    ext: "mp4",
    type: "video",
  }];
}

function uniqueBy(list, keyFn) {
  const seen = new Set();
  const output = [];
  for (const item of list) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function detectPlatform(url) {
  const u = url.toLowerCase();

  if (u.includes("youtube.com") || u.includes("youtu.be")) return "youtube";
  if (u.includes("facebook.com") || u.includes("fb.watch")) return "facebook";
  if (u.includes("instagram.com")) return "instagram";
  if (u.includes("twitter.com") || u.includes("x.com")) return "twitter";
  if (u.includes("tiktok.com")) return "tiktok";
  if (u.includes("vimeo.com")) return "vimeo";
  if (u.includes("dailymotion.com") || u.includes("dai.ly")) return "dailymotion";

  // 🔥 Adult / media platforms
  if (u.includes("pornhub.com")) return "pornhub";
  if (u.includes("xvideos.com")) return "xvideos";
  if (u.includes("xnxx.com")) return "xnxx";
  if (u.includes("xhamster.com")) return "xhamster";
  if (u.includes("spankbang.com")) return "spankbang";
  if (u.includes("youporn.com")) return "youporn";
  if (u.includes("redtube.com")) return "redtube";
  if (u.includes("tube8.com")) return "tube8";
  if (u.includes("tnaflix.com")) return "tnaflix";
  if (u.includes("thumbzilla.com")) return "thumbzilla";
  if (u.includes("hqporner.com")) return "hqporner";
  if (u.includes("sunporno.com")) return "sunporno";
  if (u.includes("porntrex.com")) return "porntrex";
  if (u.includes("eporner.com")) return "eporner";
  if (u.includes("beeg.com")) return "beeg";
  if (u.includes("daftsex.com")) return "daftsex";
  if (u.includes("gotporn.com")) return "gotporn";
  if (u.includes("vporn.com")) return "vporn";
  if (u.includes("motherless.com")) return "motherless";
  if (u.includes("pornone.com")) return "pornone";
  if (u.includes("porn300.com")) return "porn300";
  if (u.includes("fapster.com")) return "fapster";
  if (u.includes("nuvid.com")) return "nuvid";
  if (u.includes("yespornplease.com")) return "yespornplease";
  if (u.includes("pornhat.com")) return "pornhat";
  if (u.includes("iceporn.com")) return "iceporn";
  if (u.includes("pornhd.com")) return "pornhd";
  if (u.includes("keezmovies.com")) return "keezmovies";
  if (u.includes("drtuber.com")) return "drtuber";
  if (u.includes("slutload.com")) return "slutload";
  if (u.includes("yourporn.com")) return "yourporn";
  if (u.includes("spankwire.com")) return "spankwire";
  if (u.includes("alphaporno.com")) return "alphaporno";
  if (u.includes("trendyporn.com")) return "trendyporn";
  if (u.includes("megaporn.com")) return "megaporn";
  if (u.includes("xfreehd.com")) return "xfreehd";
  if (u.includes("pornhits.com")) return "pornhits";
  if (u.includes("freepornvideos.com")) return "freepornvideos";
  if (u.includes("sexvid.xxx")) return "sexvid";
  if (u.includes("hqtube.xxx")) return "hqtube";
  if (u.includes("camwhores.tv")) return "camwhores";
  if (u.includes("fux.com")) return "fux";
  if (u.includes("pornflip.com")) return "pornflip";
  if (u.includes("pornrabbit.com")) return "pornrabbit";
  if (u.includes("pornmd.com")) return "pornmd";
  if (u.includes("pornheed.com")) return "pornheed";
  if (u.includes("pornbest.org")) return "pornbest";
  if (u.includes("pornrox.com")) return "pornrox";
  if (u.includes("pornburst.xxx")) return "pornburst";
  if (u.includes("pornjam.com")) return "pornjam";

  // 🔥 Cam sites
  if (u.includes("chaturbate.com")) return "chaturbate";
  if (u.includes("stripchat.com")) return "stripchat";
  if (u.includes("bongacams.com")) return "bongacams";
  if (u.includes("cam4.com")) return "cam4";
  if (u.includes("myfreecams.com")) return "myfreecams";
  if (u.includes("livejasmin.com")) return "livejasmin";
  if (u.includes("flirt4free.com")) return "flirt4free";
  if (u.includes("streamate.com")) return "streamate";
  if (u.includes("camsoda.com")) return "camsoda";

  // 🔥 Reddit / GIF / galleries
  if (u.includes("reddit.com") || u.includes("redd.it")) return "reddit";
  if (u.includes("redgifs.com")) return "redgifs";
  if (u.includes("erome.com")) return "erome";
  if (u.includes("imagefap.com")) return "imagefap";
  if (u.includes("pornpics.com")) return "pornpics";

  // 🔥 Hentai / anime
  if (u.includes("nhentai.net")) return "nhentai";
  if (u.includes("hanime.tv")) return "hanime";
  if (u.includes("hentaifox.com")) return "hentaifox";
  if (u.includes("fakku.net")) return "fakku";
  if (u.includes("moviebox.ph")) return "moviebox";
  if (u.includes("moviebox.ph")) return "moviebox";
  if (u.includes("erothots.co")) return "erothots";
  if (u.includes("it.youporn.com")) return "it.youporn";
  if (u.includes("fpo.xxx")) return "fpo";
  if (u.includes("xxbrits.com")) return "xxbrits";
  

  return "unknown";
}

function isYouTubeBlockedError(message) {
  if (!message) return false;
  return /Too Many Requests|Sign in to confirm you're not a bot|Sign in to confirm you’re not a bot|HTTP Error 429/i.test(message);
}

function isValidUrl(value) {
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return "";
  const s = Math.floor(Number(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function sanitizeFilename(name) {
  return String(name)
    .replace(/[^a-z0-9\-_\. ]/gi, "")
    .replace(/\s+/g, "_")
    .slice(0, 80) || "download";
}

function guessExt(url) {
  try {
    const u = new URL(url);
    const p = u.pathname.split(".").pop();
    if (p && p.length <= 5) return p;
  } catch {}
  return "";
}

function isLikelyM3U8(url, contentType = "") {
  const u = String(url || "").toLowerCase();
  const ct = String(contentType || "").toLowerCase();
  if (u.includes(".m3u8")) return true;
  return ct.includes("application/vnd.apple.mpegurl") || ct.includes("application/x-mpegurl") || ct.includes("audio/mpegurl");
}

function isM3U8Format(format) {
  if (!format) return false;
  const protocol = String(format.protocol || "").toLowerCase();
  const ext = String(format.ext || "").toLowerCase();
  return protocol.includes("m3u8") || ext === "m3u8";
}
