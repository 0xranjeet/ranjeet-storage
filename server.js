require("dotenv").config();

const express = require("express");
const multer = require("multer");
const path = require("path");

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

let cachedGroupId = null;
let cachedGatewayHost = process.env.PINATA_GATEWAY_HOST || "";

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

function buildShortLink(req, cid, originalName) {
  const encodedName = encodeURIComponent(originalName);
  return `${buildBaseUrl(req)}/s/${cid}?name=${encodedName}`;
}

function buildGatewayLinks(host, cid, originalName) {
  const encodedName = encodeURIComponent(originalName);
  const baseUrl = `https://${host}/ipfs/${cid}`;

  return {
    page: baseUrl,
    image: `${baseUrl}?filename=${encodedName}`,
    download: `${baseUrl}?download=true&filename=${encodedName}`,
  };
}

async function uploadBufferToPinata({ buffer, contentType, originalName }) {
  const [groupId, gatewayHost] = await Promise.all([getOrCreateGroupId(), getGatewayHost()]);
  const formData = new FormData();
  const blob = new Blob([buffer], { type: contentType || "application/octet-stream" });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const pinataName = `${timestamp}-${originalName}`;

  formData.append("network", "public");
  formData.append("name", pinataName);
  formData.append("group_id", groupId);
  formData.append("keyvalues", JSON.stringify({ source: "file-upload-app" }));
  formData.append("file", blob, originalName);

  const uploadResult = await pinataRequest("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: getHeaders(),
    body: formData,
  });

  const file = uploadResult.data;
  const links = buildGatewayLinks(gatewayHost, file.cid, originalName);

  return {
    success: true,
    file: {
      id: file.id,
      cid: file.cid,
      name: originalName,
      storedName: file.name,
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

app.get("/api/health", async (_req, res) => {
  const gatewayHost = await getGatewayHost();

  res.json({
    ok: true,
    groupName: PINATA_GROUP_NAME,
    gatewayHost,
  });
});

app.get("/s/:cid", async (req, res) => {
  try {
    const gatewayHost = await getGatewayHost();
    const fileName = typeof req.query.name === "string" ? req.query.name : "file";
    const links = buildGatewayLinks(gatewayHost, req.params.cid, fileName);

    return res.redirect(links.image);
  } catch (error) {
    return res.status(500).send(error.message || "Short link failed.");
  }
});

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
    payload.links.short = buildShortLink(req, payload.file.cid, payload.file.name);

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
    payload.links.short = buildShortLink(req, payload.file.cid, payload.file.name);

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
