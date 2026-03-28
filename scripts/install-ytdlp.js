const fs = require("fs");
const path = require("path");
const https = require("https");

const BIN_DIR = path.join(process.cwd(), "bin");
const platform = process.platform;

const skipDownload = String(process.env.YTDLP_SKIP_DOWNLOAD || "false").toLowerCase() === "true";
if (skipDownload) {
  console.log("Skipping yt-dlp download (YTDLP_SKIP_DOWNLOAD=true).");
  process.exit(0);
}

let filename = "yt-dlp";
if (platform === "win32") filename = "yt-dlp.exe";
else if (platform === "darwin") filename = "yt-dlp_macos";

const url = `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${filename}`;
const outPath = path.join(BIN_DIR, platform === "darwin" ? "yt-dlp" : filename);

if (!fs.existsSync(BIN_DIR)) {
  fs.mkdirSync(BIN_DIR, { recursive: true });
}

if (fs.existsSync(outPath)) {
  console.log(`yt-dlp already present at ${outPath}`);
  process.exit(0);
}

console.log(`Downloading yt-dlp from ${url}`);

downloadWithRedirects(url, 0);

function downloadWithRedirects(currentUrl, depth) {
  if (depth > 5) {
    console.error("Failed to download yt-dlp. Too many redirects.");
    process.exit(1);
  }

  https.get(currentUrl, { headers: { "User-Agent": "xoxo-downloader" } }, (res) => {
    const status = res.statusCode || 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      const nextUrl = new URL(res.headers.location, currentUrl).toString();
      res.resume();
      return downloadWithRedirects(nextUrl, depth + 1);
    }

    if (status !== 200) {
      console.error(`Failed to download yt-dlp. HTTP ${status}`);
      process.exit(1);
    }

    const file = fs.createWriteStream(outPath);
    res.pipe(file);
    file.on("finish", () => {
      file.close(() => {
        if (platform !== "win32") {
          fs.chmodSync(outPath, 0o755);
        }
        console.log(`yt-dlp saved to ${outPath}`);
      });
    });
    file.on("error", onError);
  }).on("error", onError);
}

function onError(err) {
  console.error("Error downloading yt-dlp:", err.message || err);
  process.exit(1);
}