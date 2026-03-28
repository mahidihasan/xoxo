const fs = require("fs");
const path = require("path");
const https = require("https");

const BIN_DIR = path.join(process.cwd(), "bin");
const platform = process.platform;

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

https.get(url, (res) => {
  if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
    https.get(res.headers.location, handleResponse).on("error", onError);
    return;
  }
  handleResponse(res);
}).on("error", onError);

function handleResponse(res) {
  if (res.statusCode !== 200) {
    console.error(`Failed to download yt-dlp. HTTP ${res.statusCode}`);
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
}

function onError(err) {
  console.error("Error downloading yt-dlp:", err.message || err);
  process.exit(1);
}
