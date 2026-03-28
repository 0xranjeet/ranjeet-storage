require("dotenv").config();

const express = require("express");
const admin = require("firebase-admin");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

const app = express();
const port = Number(process.env.PORT) || 3000;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

const PINATA_JWT = process.env.PINATA_JWT;
const PINATA_GROUP_NAME = process.env.PINATA_GROUP_NAME || "My Uploads";
const DEFAULT_GATEWAY = "gateway.pinata.cloud";
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "";
const FIREBASE_CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL || "";
const FIREBASE_PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY || "";

let cachedGroupId = null;
let cachedGatewayHost = process.env.PINATA_GATEWAY_HOST || "";
let firestore = null;

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "1mb" }));

function getHeaders(extra = {}) {
  if (!PINATA_JWT) {
    throw new Error("PINATA_JWT is missing. Add it to your environment variables.");
  }

  return {
    Authorization: `Bearer ${PINATA_JWT}`,
    ...extra,
  };
}

function getFirestore() {
  if (!FIREBASE_PROJECT_ID || !FIREBASE_CLIENT_EMAIL || !FIREBASE_PRIVATE_KEY) {
    throw new Error(
      "Firebase credentials are missing. Add FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, and FIREBASE_PRIVATE_KEY."
    );
  }

  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: FIREBASE_PROJECT_ID,
        clientEmail: FIREBASE_CLIENT_EMAIL,
        privateKey: FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }

  if (!firestore) {
    firestore = admin.firestore();
  }

  return firestore;
}

async function readJson(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    return { message: text || "Invalid JSON response from Pinata." };
  }
}

async function pinataRequest(url, options = {}) {
  const response = await fetch(url, options);
  const data = await readJson(response);

  if (!response.ok) {
    const message =
      data.error?.reason ||
      data.error?.details ||
      data.message ||
      "Pinata request failed.";

    throw new Error(message);
  }

  return data;
}

async function getGatewayHost() {
  if (cachedGatewayHost) {
    return cachedGatewayHost;
  }

  try {
    const data = await pinataRequest("https://api.pinata.cloud/v3/gateways", {
      method: "GET",
      headers: getHeaders(),
    });

    const firstGateway = data.data?.rows?.[0];
    const customDomain = firstGateway?.custom_domains?.[0]?.domain;

    if (customDomain) {
      cachedGatewayHost = customDomain;
      return cachedGatewayHost;
    }

    if (firstGateway?.domain) {
      cachedGatewayHost = `${firstGateway.domain}.mypinata.cloud`;
      return cachedGatewayHost;
    }
  } catch (error) {
    console.warn("Gateway discovery failed, using fallback gateway.", error.message);
  }

  cachedGatewayHost = DEFAULT_GATEWAY;
  return cachedGatewayHost;
}

async function getOrCreateGroupId() {
  if (cachedGroupId) {
    return cachedGroupId;
  }

  const lookup = await pinataRequest(
    `https://api.pinata.cloud/v3/groups/public?name=${encodeURIComponent(PINATA_GROUP_NAME)}&limit=10`,
    {
      method: "GET",
      headers: getHeaders(),
    }
  );

  const existingGroup = lookup.data?.groups?.find(
    (group) => group.name.toLowerCase() === PINATA_GROUP_NAME.toLowerCase()
  );

  if (existingGroup) {
    cachedGroupId = existingGroup.id;
    return cachedGroupId;
  }

  const created = await pinataRequest("https://api.pinata.cloud/v3/groups/public", {
    method: "POST",
    headers: getHeaders({
      "Content-Type": "application/json",
    }),
    body: JSON.stringify({
      name: PINATA_GROUP_NAME,
      is_public: true,
    }),
  });

  cachedGroupId = created.data?.id;
  return cachedGroupId;
}

function buildBaseUrl(req) {
  return `${req.protocol}://${req.get("host")}`;
}

function buildShortLink(req, shortCode) {
  return `${buildBaseUrl(req)}/s/${shortCode}`;
}

function isImageName(fileName = "") {
  return /\.(png|jpe?g|gif|webp|bmp|svg|avif)$/i.test(fileName);
}

function isTextLikeFile(fileName = "", contentType = "") {
  if (contentType.startsWith("text/")) {
    return true;
  }

  return /\.(txt|md|json|ya?ml|xml|csv|log|js|ts|jsx|tsx|css|html|py|java|c|cpp|sh)$/i.test(fileName);
}

function buildGatewayLinks(host, rootCid, storedPath, displayName) {
  const encodedName = encodeURIComponent(displayName);
  const baseUrl = `https://${host}/ipfs/${rootCid}`;

  return {
    page: `${baseUrl}?filename=${encodedName}`,
    image: `${baseUrl}?filename=${encodedName}`,
    download: `${baseUrl}?download=true&filename=${encodedName}`,
  };
}

async function uploadBufferToPinata({ buffer, contentType, originalName }) {
  const [groupId, gatewayHost] = await Promise.all([getOrCreateGroupId(), getGatewayHost()]);
  const formData = new FormData();
  const blob = new Blob([buffer], { type: contentType || "application/octet-stream" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const storedName = `${timestamp}-${originalName}`;

  formData.append("network", "public");
  formData.append("name", storedName);
  formData.append("group_id", groupId);
  formData.append("keyvalues", JSON.stringify({ source: "file-upload-app" }));
  formData.append("file", blob, originalName);

  const uploadResult = await pinataRequest("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: getHeaders(),
    body: formData,
  });

  const file = uploadResult.data;
  const links = buildGatewayLinks(gatewayHost, file.cid, storedName, originalName);

  return {
    success: true,
    file: {
      id: file.id,
      cid: file.cid,
      name: originalName,
      storedName,
      storedPath: storedName,
      size: file.size,
      type: contentType,
      groupId: file.group_id || groupId,
      createdAt: file.created_at,
    },
    links,
  };
}

function extractFileNameFromUrl(urlString, fallback = "pasted-image") {
  try {
    const url = new URL(urlString);
    const lastSegment = url.pathname.split("/").filter(Boolean).pop();
    return lastSegment || fallback;
  } catch (error) {
    return fallback;
  }
}

function createLinkPayload(req, gatewayHost, rootCid, storedPath, displayName, shortCode) {
  const short = buildShortLink(req, shortCode);

  return {
    ...buildGatewayLinks(gatewayHost, rootCid, storedPath, displayName),
    page: short,
    short,
  };
}

function createShortCode() {
  return crypto.randomBytes(4).toString("base64url").toLowerCase();
}

async function createShortRecord({ cid, path: storedPath, name, type }) {
  const db = getFirestore();

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = createShortCode();
    const ref = db.collection("short_links").doc(code);
    const existing = await ref.get();

    if (existing.exists) {
      continue;
    }

    await ref.set({
        cid,
        path: storedPath,
        name,
        type,
        createdAt: new Date().toISOString(),
      });

    return code;
  }

  throw new Error("Could not create a unique short URL.");
}

async function readShortRecord(code) {
  const db = getFirestore();
  const doc = await db.collection("short_links").doc(code).get();

  if (!doc.exists) {
    return null;
  }

  return doc.data();
}

async function updateShortRecord(code, updates) {
  const existing = await readShortRecord(code);

  if (!existing) {
    throw new Error("Short link not found.");
  }

  const nextValue = {
    ...existing,
    ...updates,
    updatedAt: new Date().toISOString(),
  };

  const db = getFirestore();
  await db.collection("short_links").doc(code).set(nextValue);
  return nextValue;
}

app.get("/api/health", async (_req, res) => {
  const gatewayHost = await getGatewayHost();

  res.json({
    ok: true,
    groupName: PINATA_GROUP_NAME,
    gatewayHost,
  });
});

app.post("/api/links", async (req, res) => {
  const cid = req.body?.cid;
  const storedPath = req.body?.path;
  const originalName = req.body?.name;
  const shortCode = req.body?.shortCode;

  if (!cid || !storedPath || !originalName || !shortCode) {
    return res.status(400).json({
      error: "CID, stored path, file name, and short code are required.",
    });
  }

  try {
    const gatewayHost = await getGatewayHost();
    await updateShortRecord(shortCode, { cid, path: storedPath, name: originalName });

    return res.json({
      links: createLinkPayload(req, gatewayHost, cid, storedPath, originalName, shortCode),
    });
  } catch (error) {
    return res.status(500).json({
      error: error.message || "Could not generate links.",
    });
  }
});

async function handleShortLink(req, res) {
  try {
    const record = await readShortRecord(req.params.code);

    if (!record?.cid) {
      return res.status(404).send("Short link not found.");
    }

    const gatewayHost = await getGatewayHost();
    const fileName = record.name || "image";
    const storedPath = record.path || fileName;
    const links = buildGatewayLinks(gatewayHost, record.cid, storedPath, fileName);
    const escapedName = fileName
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

    if (isTextLikeFile(fileName, record.type || "")) {
      let fileContent = "Could not load file preview.";

      try {
        const textResponse = await fetch(links.image);
        if (textResponse.ok) {
          fileContent = await textResponse.text();
        }
      } catch (fetchError) {
        fileContent = "Could not load file preview.";
      }

      const escapedContent = fileContent
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      return res
        .status(200)
        .type("html")
        .send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>decentrazile storage</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {
        color-scheme: light;
        --text: #000000;
        --muted: #666666;
        --line: rgba(0, 0, 0, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(0, 0, 0, 0.05), transparent 30%),
          linear-gradient(135deg, #ffffff, #f4f4f4);
        color: var(--text);
      }
      .wrap {
        width: min(1320px, calc(100% - 20px));
        margin: 0 auto;
        padding: 16px 0 24px;
      }
      .topbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
      }
      .brand {
        color: var(--text);
        text-decoration: none;
      }
      .name {
        margin: 0;
        font-size: clamp(1.2rem, 2.8vw, 2rem);
        line-height: 1;
      }
      .panel {
        margin-top: 14px;
        padding: 12px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.96);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.08);
      }
      .copy-top {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 34px;
        padding: 0 10px;
        color: #ffffff;
        background: #000000;
        border: 0;
        cursor: pointer;
        font: inherit;
        font-size: 0.84rem;
      }
      .content {
        margin: 0;
        padding: 16px;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        background: #ffffff;
        border: 1px solid var(--line);
        font: 0.96rem/1.55 Consolas, Monaco, monospace;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 34px;
        padding: 0 10px;
        color: #ffffff;
        background: #000000;
        text-decoration: none;
        font-size: 0.84rem;
      }
      .btn.secondary {
        background: #ffffff;
        color: #000000;
        border: 1px solid var(--line);
      }
      @media (max-width: 720px) {
        .wrap {
          width: calc(100% - 12px);
          padding: 8px 0 16px;
        }
        .panel {
          padding: 8px;
        }
        .content {
          padding: 12px;
          font-size: 0.86rem;
        }
        .btn {
          min-height: 32px;
          padding: 0 9px;
          font-size: 0.8rem;
        }
        .copy-top {
          min-height: 32px;
          padding: 0 9px;
          font-size: 0.8rem;
        }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <div class="topbar">
        <a class="brand" href="/"><h1 class="name">decentrazile storage</h1></a>
        <button class="copy-top" id="copyTextButton" type="button">Copy</button>
      </div>
      <section class="panel">
        <pre class="content" id="textContent">${escapedContent}</pre>
        <div class="actions">
          <a class="btn" href="${links.image}" target="_blank" rel="noreferrer">Open Direct File</a>
          <a class="btn secondary" href="${links.download}" target="_blank" rel="noreferrer">Download</a>
        </div>
      </section>
    </main>
    <script>
      const copyButton = document.getElementById("copyTextButton");
      const textContent = document.getElementById("textContent");

      copyButton.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(textContent.textContent || "");
          copyButton.textContent = "Copied";
          setTimeout(() => {
            copyButton.textContent = "Copy";
          }, 1200);
        } catch (error) {
          copyButton.textContent = "Failed";
          setTimeout(() => {
            copyButton.textContent = "Copy";
          }, 1200);
        }
      });
    </script>
  </body>
</html>`);
    }

    if (!isImageName(fileName) && !(record.type || "").startsWith("image/")) {
      return res.redirect(links.image);
    }

    return res
      .status(200)
      .type("html")
      .send(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>decentrazile storage</title>
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link
      href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap"
      rel="stylesheet"
    />
    <style>
      :root {
        color-scheme: light;
        --bg: #ffffff;
        --text: #000000;
        --muted: #666666;
        --line: rgba(0, 0, 0, 0.12);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Space Grotesk", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(0, 0, 0, 0.05), transparent 30%),
          linear-gradient(135deg, #ffffff, #f2f2f2);
        color: var(--text);
      }
      .wrap {
        width: min(1320px, calc(100% - 20px));
        margin: 0 auto;
        padding: 16px 0 24px;
      }
      .topbar {
        display: flex;
        align-items: center;
        margin-bottom: 10px;
      }
      .brand {
        color: var(--text);
        text-decoration: none;
      }
      .name {
        margin: 0;
        font-size: clamp(1.2rem, 2.8vw, 2rem);
        word-break: break-word;
        line-height: 1;
      }
      .panel {
        margin-top: 14px;
        padding: 10px;
        border: 1px solid var(--line);
        border-radius: 0;
        background: rgba(255, 255, 255, 0.95);
        box-shadow: 0 24px 60px rgba(0, 0, 0, 0.08);
      }
      .preview {
        display: block;
        width: 100%;
        max-height: 80vh;
        object-fit: contain;
        border-radius: 0;
        background: #ffffff;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 10px;
      }
      .btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-height: 34px;
        padding: 0 10px;
        color: #ffffff;
        background: #000000;
        text-decoration: none;
        font-size: 0.84rem;
      }
      .btn.secondary {
        background: #ffffff;
        color: #000000;
        border: 1px solid var(--line);
      }
      @media (max-width: 720px) {
        .wrap {
          width: calc(100% - 12px);
          padding: 8px 0 16px;
        }
        .panel {
          padding: 6px;
        }
        .preview {
          max-height: 68vh;
        }
        .actions {
          gap: 6px;
          margin-top: 8px;
        }
        .btn {
          min-height: 32px;
          padding: 0 9px;
          font-size: 0.8rem;
        }
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <div class="topbar">
        <a class="brand" href="/"><h1 class="name">Ranjeet decentrazile storage</h1></a>
      </div>
      <section class="panel">
        <img class="preview" src="${links.image}" alt="${escapedName}" />
        <div class="actions">
          <a class="btn" href="${links.image}" target="_blank" rel="noreferrer">Open Direct File</a>
          <a class="btn secondary" href="${links.download}" target="_blank" rel="noreferrer">Download</a>
        </div>
      </section>
    </main>
  </body>
</html>`);
  } catch (error) {
    return res.status(500).send(error.message || "Short link failed.");
  }
}

app.get("/s/:code", handleShortLink);

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({
      error: "Please select a file first.",
    });
  }

  try {
    const payload = await uploadBufferToPinata({
      buffer: req.file.buffer,
      contentType: req.file.mimetype,
      originalName: req.file.originalname,
    });
    const gatewayHost = await getGatewayHost();
    const shortCode = await createShortRecord({
      cid: payload.file.cid,
      path: payload.file.storedPath,
      name: payload.file.name,
      type: payload.file.type,
    });
    payload.file.shortCode = shortCode;
    payload.links = createLinkPayload(
      req,
      gatewayHost,
      payload.file.cid,
      payload.file.storedPath,
      payload.file.name,
      shortCode
    );

    return res.json(payload);
  } catch (error) {
    console.error("Upload failed:", error);
    return res.status(500).json({
      error: error.message || "Upload failed.",
    });
  }
});

app.post("/api/upload-from-url", async (req, res) => {
  const imageUrl = req.body?.imageUrl;

  if (!imageUrl) {
    return res.status(400).json({
      error: "Image URL is required.",
    });
  }

  try {
    const response = await fetch(imageUrl);

    if (!response.ok) {
      throw new Error("Could not fetch pasted image URL.");
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.startsWith("image/")) {
      throw new Error("Pasted content is not an image.");
    }

    const arrayBuffer = await response.arrayBuffer();
    const fallbackExtension = contentType.split("/")[1] || "png";
    const urlName = extractFileNameFromUrl(imageUrl, `pasted-image.${fallbackExtension}`);
    const originalName = /\.[a-z0-9]+$/i.test(urlName) ? urlName : `${urlName}.${fallbackExtension}`;

    const payload = await uploadBufferToPinata({
      buffer: Buffer.from(arrayBuffer),
      contentType,
      originalName,
    });
    const gatewayHost = await getGatewayHost();
    const shortCode = await createShortRecord({
      cid: payload.file.cid,
      path: payload.file.storedPath,
      name: payload.file.name,
      type: payload.file.type,
    });
    payload.file.shortCode = shortCode;
    payload.links = createLinkPayload(
      req,
      gatewayHost,
      payload.file.cid,
      payload.file.storedPath,
      payload.file.name,
      shortCode
    );

    return res.json(payload);
  } catch (error) {
    console.error("Upload from URL failed:", error);
    return res.status(500).json({
      error: error.message || "Upload from pasted URL failed.",
    });
  }
});

if (!process.env.VERCEL) {
  app.listen(port, () => {
    console.log(`File upload app running at http://localhost:${port}`);
  });
}

module.exports = app;
