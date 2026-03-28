/* ============================================================
   xoxo downloader - Configuration
   ============================================================
   BACKEND SETUP (slot in your keys):
   ---------------------------------------------------------------------------------------------------
   Option A: RapidAPI
     - YouTube: https://rapidapi.com/ytjar/api/ytjar
     - Instagram: https://rapidapi.com/mrsonj/api/instagram-downloader-download-instagram-videos1
     - Facebook: https://rapidapi.com/pckdev/api/all-in-one-social-downloader

   Option B: Self-hosted yt-dlp
     - Run: yt-dlp --write-info-json <url>
     - Endpoint: POST /api/download { url, format }
============================================================ */
const API_BASE = document.body.getAttribute("data-api-base") || "/api";
const API_CONFIG = {
  rapidapi_key: "YOUR_RAPIDAPI_KEY_HERE",
  backend_url:  API_BASE,
  use_backend:  true,  // true = self-hosted, false = RapidAPI
};

/* Platform detection */
function detectPlatform(url) {
  if (!url) return null;
  url = url.toLowerCase();
  if (url.includes("youtube.com") || url.includes("youtu.be")) return "youtube";
  if (url.includes("facebook.com") || url.includes("fb.watch"))  return "facebook";
  if (url.includes("instagram.com"))                              return "instagram";
  if (url.includes("twitter.com") || url.includes("x.com"))      return "twitter";
  if (url.includes("tiktok.com"))                                 return "tiktok";
  if (url.includes("vimeo.com"))                                  return "vimeo";
  return "unknown";
}

function iconMarkup(id, extraClass = "") {
  const cls = extraClass ? `icon ${extraClass}` : "icon";
  return `<svg class="${cls}"><use href="#${id}"></use></svg>`;
}

const PLATFORM_ICONS = {
  youtube:   iconMarkup("i-video"),
  facebook:  iconMarkup("i-video"),
  instagram: iconMarkup("i-image"),
  twitter:   iconMarkup("i-link"),
  tiktok:    iconMarkup("i-audio"),
  vimeo:     iconMarkup("i-video"),
  unknown:   iconMarkup("i-link"),
};

const PLATFORM_COLORS = {
  youtube:   "#ff0000",
  facebook:  "#1877f2",
  instagram: "#e1306c",
  twitter:   "#1da1f2",
  tiktok:    "#69c9d0",
  vimeo:     "#19b7ea",
  unknown:   "#8b95aa",
};

/* Quality map */
const QUALITY_MAP = {
  video: [
    { label: "1080p", ext: "mp4", quality: "high" },
    { label: "720p",  ext: "mp4", quality: "medium" },
    { label: "360p",  ext: "mp4", quality: "low" },
  ],
  audio: [
    { label: "320 kbps", ext: "mp3", quality: "high" },
    { label: "192 kbps", ext: "mp3", quality: "medium" },
    { label: "128 kbps", ext: "mp3", quality: "low" },
  ],
  image: [
    { label: "Original", ext: "jpg", quality: "high" },
    { label: "1080px",   ext: "jpg", quality: "medium" },
    { label: "640px",    ext: "jpg", quality: "low" },
  ],
};

let lastUrl = "";
let currentType = "video";
let fetchStart = 0;
let fetchCountdown = null;

/* ------ Input validation ------ */
function validateInput() {
  const card  = document.getElementById("inputCard");
  const input = document.getElementById("urlInput");
  const url   = input.value.trim();
  if (url.length > 4) {
    card.classList.add("active");
    card.classList.remove("error-state");
  } else {
    card.classList.remove("active");
  }
}

document.getElementById("urlInput").addEventListener("input", validateInput);

/* ------ Show error ------ */
function showError(msg) {
  const el = document.getElementById("errorMsg");
  el.style.display = "block";
  el.textContent   = msg;
  document.getElementById("inputCard").classList.add("error-state");
  document.getElementById("inputCard").classList.remove("active");
}
function clearError() {
  document.getElementById("errorMsg").style.display = "none";
  document.getElementById("inputCard").classList.remove("error-state");
}

/* ------ Fetch / Analyse ------ */
async function fetchMedia() {
  const url     = document.getElementById("urlInput").value.trim();
  const type    = currentType;

  clearError();
  if (!url) { showError("Please enter a URL first."); return; }

  const platform = detectPlatform(url);

  // Validate URL format
  try {
    // Trigger direct download (avoid new tab redirects on mobile)
    const a = document.createElement("a");
    a.href = fmt.url;
    a.download = `${sanitizeFilename(title || "download")}.${fmt.ext}`;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();

    clearInterval(interval);
    fillEl.style.width = "100%";
    pctEl.textContent  = "100%";
    labelEl.textContent = "Download started";
    showToast("Download started");

  } catch { showError("Invalid URL - check the format."); return; }

  // Loading state
  setLoading(true);
  document.getElementById("resultCard").style.display = "none";

  try {
    // Trigger direct download (avoid new tab redirects on mobile)
    const a = document.createElement("a");
    a.href = fmt.url;
    a.download = `${sanitizeFilename(title || "download")}.${fmt.ext}`;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();

    clearInterval(interval);
    fillEl.style.width = "100%";
    pctEl.textContent  = "100%";
    labelEl.textContent = "Download started";
    showToast("Download started");

  } catch (err) {
    showError(err.message || "Failed to fetch media info. Check the URL or API key.");
  } finally {
    setLoading(false);
  }
}

/* --------- Self-hosted backend --------- */
async function fetchFromBackend(url, type, platform) {
  const resp = await fetch(`${API_CONFIG.backend_url}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url, type }),
  });
  const payload = await resp.json().catch(() => null);
  if (!resp.ok) {
    const detail = payload && payload.error ? payload.error : `Backend error: ${resp.status}`;
    throw new Error(detail);
  }
  return payload;
}

/* --------- RapidAPI routing --------- */
async function fetchFromRapidAPI(url, type, platform) {
  const headers = {
    "x-rapidapi-key": API_CONFIG.rapidapi_key,
    "Content-Type": "application/json",
  };

  if (platform === "youtube") {
    // Using yt-api on RapidAPI
    const encoded = encodeURIComponent(url);
    const resp = await fetch(
      `https://ytjar.p.rapidapi.com/dl?id=${encoded}`,
      { method: "GET", headers: { ...headers, "x-rapidapi-host": "ytjar.p.rapidapi.com" } }
    );
    if (!resp.ok) throw new Error(`YouTube API error: ${resp.status}`);
    const data = await resp.json();
    return parseYouTubeRapid(data, type, url);
  }

  if (platform === "instagram") {
    const resp = await fetch(
      `https://instagram-downloader-download-instagram-videos1.p.rapidapi.com/get-info-rapidapi?url=${encodeURIComponent(url)}`,
      { method: "GET", headers: { ...headers, "x-rapidapi-host": "instagram-downloader-download-instagram-videos1.p.rapidapi.com" } }
    );
    if (!resp.ok) throw new Error(`Instagram API error: ${resp.status}`);
    const data = await resp.json();
    return parseInstagramRapid(data, type, url);
  }

  if (platform === "facebook") {
    const resp = await fetch(
      `https://all-in-one-social-downloader.p.rapidapi.com/facebook/video?url=${encodeURIComponent(url)}`,
      { method: "GET", headers: { ...headers, "x-rapidapi-host": "all-in-one-social-downloader.p.rapidapi.com" } }
    );
    if (!resp.ok) throw new Error(`Facebook API error: ${resp.status}`);
    const data = await resp.json();
    return parseFacebookRapid(data, type, url);
  }

  throw new Error("Unsupported platform - add your own API connector.");
}

/* --------- RapidAPI parsers --------- */
function parseYouTubeRapid(data, type, url) {
  const formats = [];
  if (data.link) formats.push({ url: data.link, label: "Auto", ext: "mp4", type: "video" });
  if (data.a)    formats.push({ url: data.a,    label: "Audio", ext: "mp3", type: "audio" });
  return {
    title:     data.title || "YouTube Video",
    thumb:     data.thumb || null,
    duration:  data.dur   || "",
    platform:  "youtube",
    formats,
  };
}

function parseInstagramRapid(data, type, url) {
  const formats = [];
  if (data.video) formats.push({ url: data.video, label: "Video", ext: "mp4", type: "video" });
  if (data.image) formats.push({ url: data.image, label: "Image", ext: "jpg", type: "image" });
  return {
    title:    data.title || "Instagram Post",
    thumb:    data.thumbnail || data.image || null,
    platform: "instagram",
    formats,
  };
}

function parseFacebookRapid(data, type, url) {
  const formats = [];
  if (data.hd)  formats.push({ url: data.hd,  label: "HD 1080p", ext: "mp4", type: "video" });
  if (data.sd)  formats.push({ url: data.sd,  label: "SD 480p",  ext: "mp4", type: "video" });
  return {
    title:    data.title || "Facebook Video",
    thumb:    data.thumbnail || null,
    platform: "facebook",
    formats,
  };
}

/* --------- Demo / mock data --------- */
function generateMockData(url, type, platform) {
  const titles = {
    youtube:   "Sample YouTube Video - xoxo downloader Demo",
    facebook:  "Sample Facebook Video - xoxo downloader Demo",
    instagram: "Sample Instagram Post - xoxo downloader Demo",
    unknown:   "Media File - xoxo downloader Demo",
  };

  const q = QUALITY_MAP[type] || QUALITY_MAP.video;
  const formats = q.map((item, idx) => ({
    url: `#demo-${idx}`,
    label: item.label,
    ext: item.ext,
    type,
    quality: item.quality
  }));

  return {
    title:    titles[platform] || titles.unknown,
    thumb:    null,
    duration: "3:45",
    platform,
    formats,
    demo:     true,
  };
}

/* --------- Render result --------- */
function renderResult(info, type, platform, sourceURL) {
  const card = document.getElementById("resultCard");

  // Thumb
  const thumbEl = document.getElementById("resultThumb");
  const fallbackIcon = PLATFORM_ICONS[platform] || iconMarkup("i-video");
  thumbEl.innerHTML = "";
  if (info.thumb) {
    const img = new Image();
    img.alt = "";
    img.src = info.thumb;
    img.onerror = () => { thumbEl.innerHTML = fallbackIcon; };
    img.onload = () => { thumbEl.innerHTML = ""; thumbEl.appendChild(img); };
    thumbEl.appendChild(img);
  } else {
    thumbEl.innerHTML = fallbackIcon;
  }

  // Title
  document.getElementById("resultTitle").textContent = info.title || "Unknown media";

  // Meta
  const meta = document.getElementById("resultMeta");
  meta.innerHTML = `
    <span class="tag" style="color:${PLATFORM_COLORS[platform]}">${platform.toUpperCase()}</span>
    ${info.duration ? `<span class="tag">${info.duration}</span>` : ""}
    ${info.demo ? `<span class="tag" style="color:var(--warn)">DEMO MODE</span>` : ""}
  `;

  // Grid
  const grid = document.getElementById("dlGrid");
  grid.innerHTML = "";

  const TYPE_ICONS = {
    video: iconMarkup("i-video"),
    audio: iconMarkup("i-audio"),
    image: iconMarkup("i-image"),
  };

  const formats = Array.isArray(info.formats) && info.formats.length > 0
    ? info.formats
    : [buildClientDefaultFormat(type, sourceURL, info.title || "download")];

  formats.forEach(fmt => {
    const icon    = TYPE_ICONS[fmt.type] || iconMarkup("i-download");
    const btn     = document.createElement("div");
    btn.className = `dl-btn ${fmt.type}`;
    btn.innerHTML = `
      <div class="dl-type-icon">${icon}</div>
      <span class="dl-type-label">${fmt.type.charAt(0).toUpperCase() + fmt.type.slice(1)}</span>
      <div class="dl-type-quality">
        ${fmt.label}
        <br>
        <span style="color:var(--text3)">.${fmt.ext}</span>
      </div>
    `;
    btn.addEventListener("click", () => triggerDownload(fmt, info.title, sourceURL, info.demo));
    grid.appendChild(btn);
  });

  card.style.display = "block";
  card.scrollIntoView({ behavior: "smooth", block: "nearest" });

  // Update toolbar active state
  setActiveType(type);
}

function buildClientDefaultFormat(type, sourceURL, title) {
  const safeTitle = encodeURIComponent(title || "download");
  const safeUrl = encodeURIComponent(sourceURL);

  if (type === "audio") {
    return {
      url: `${API_CONFIG.backend_url}/download?url=${safeUrl}&format=${encodeURIComponent("bestaudio/best")}&title=${safeTitle}&ext=mp3`,
      label: "Original Standard",
      ext: "mp3",
      type: "audio",
    };
  }

  if (type === "image") {
    return {
      url: `${API_CONFIG.backend_url}/download?url=${safeUrl}&format=${encodeURIComponent("best")}&title=${safeTitle}&ext=jpg`,
      label: "Original Standard",
      ext: "jpg",
      type: "image",
    };
  }

  return {
    url: `${API_CONFIG.backend_url}/download?url=${safeUrl}&format=${encodeURIComponent("bestvideo*+bestaudio/best")}&title=${safeTitle}&ext=mp4`,
    label: "Original Standard",
    ext: "mp4",
    type: "video",
  };
}

/* --------- Trigger download --------- */
async function triggerDownload(fmt, title, sourceURL, isDemo) {
  if (isDemo || fmt.url === "#demo-high" || fmt.url === "#demo-medium" || fmt.url === "#demo-low") {
    showToast("Add your API key in API_CONFIG to enable real downloads");
    return;
  }

  // Show progress
  const progressEl  = document.getElementById("dlProgress");
  const fillEl      = document.getElementById("progressFill");
  const labelEl     = document.getElementById("dlProgressLabel");
  const pctEl       = document.getElementById("dlProgressPct");

  progressEl.style.display = "block";
  labelEl.textContent = `Downloading ${fmt.type}...`;

  // Simulated progress (real progress requires a streaming fetch)
  let pct = 0;
  const interval = setInterval(() => {
    pct = Math.min(pct + Math.random() * 15, 95);
    fillEl.style.width = pct + "%";
    pctEl.textContent  = Math.round(pct) + "%";
  }, 200);

  try {
    // Trigger direct download (avoid new tab redirects on mobile)
    const a = document.createElement("a");
    a.href = fmt.url;
    a.download = `${sanitizeFilename(title || "download")}.${fmt.ext}`;
    a.rel = "noopener";
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    a.remove();

    clearInterval(interval);
    fillEl.style.width = "100%";
    pctEl.textContent  = "100%";
    labelEl.textContent = "Download started";
    showToast("Download started");

  } catch (err) {\n    clearInterval(interval);\n    showToast(err.message || "Download failed");\n  } finally {
    setTimeout(() => {
      progressEl.style.display = "none";
      fillEl.style.width = "0%";
    }, 3000);
  }
}

/* --------- Helpers --------- */
function setLoading(on) {
  const btn     = document.getElementById("fetchBtn");
  const spinner = document.getElementById("spinner");
  const text    = document.getElementById("btnText");
  btn.disabled           = on;
  spinner.style.display  = on ? "block" : "none";
  if (on) {
    startButtonCountdown();
  } else {
    stopButtonCountdown();
    text.textContent = "Analyse & Fetch";
  }
}

function sanitizeFilename(name) {
  return name.replace(/[^a-z0-9\-_\. ]/gi, "").replace(/\s+/g, "_").slice(0, 60) || "download";
}

function showToast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove("show"), 3000);
}

function startButtonCountdown() {
  const text = document.getElementById("btnText");
  let remaining = 8;
  fetchStart = Date.now();
  text.textContent = `Fetching... ~${remaining}s`;
  clearInterval(fetchCountdown);
  fetchCountdown = setInterval(() => {
    const elapsed = Math.floor((Date.now() - fetchStart) / 1000);
    remaining = Math.max(1, 8 - elapsed);
    text.textContent = `Fetching... ~${remaining}s`;
  }, 1000);
}

function stopButtonCountdown() {
  clearInterval(fetchCountdown);
}

function setActiveType(type) {
  currentType = type;
  const buttons = document.querySelectorAll(".dl-tab");
  buttons.forEach(btn => {
    const isActive = btn.getAttribute("data-type") === type;
    btn.classList.toggle("active", isActive);
  });
}

document.querySelectorAll(".dl-tab").forEach(btn => {
  btn.addEventListener("click", () => {
    const type = btn.getAttribute("data-type");
    setActiveType(type);
    if (lastUrl) fetchMedia();
  });
});

document.getElementById("fetchBtn").addEventListener("click", () => {
  fetchMedia();
});

/* ------ Allow Enter key ------ */
document.getElementById("urlInput").addEventListener("keydown", e => {
  if (e.key === "Enter") fetchMedia();
});


