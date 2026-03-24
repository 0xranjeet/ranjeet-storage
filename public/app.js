const uploadForm = document.getElementById("uploadForm");
const fileInput = document.getElementById("fileInput");
const uploadButton = document.getElementById("uploadButton");
const fileName = document.getElementById("fileName");
const statusBox = document.getElementById("status");
const resultCard = document.getElementById("resultCard");
const resultName = document.getElementById("resultName");
const resultType = document.getElementById("resultType");
const renameInput = document.getElementById("renameInput");
const renameButton = document.getElementById("renameButton");
const shortLink = document.getElementById("shortLink");
const pageLink = document.getElementById("pageLink");
const imageLink = document.getElementById("imageLink");
const downloadLink = document.getElementById("downloadLink");
const openLinkButton = document.getElementById("openLinkButton");
const downloadLinkButton = document.getElementById("downloadLinkButton");
const previewWrap = document.getElementById("previewWrap");
const previewImage = document.getElementById("previewImage");
const dropzone = document.getElementById("dropzone");
let isUploading = false;
let currentUpload = null;

function setStatus(message, isError = false) {
  statusBox.textContent = message;
  statusBox.style.color = isError ? "#b42318" : "#6f6558";
}

function setSelectedFile(file) {
  if (!file) {
    fileName.textContent = "No file selected";
    return;
  }

  const sizeInMb = Math.max(file.size / 1024 / 1024, 0.01).toFixed(2);
  fileName.textContent = `${file.name} | ${sizeInMb} MB`;
}

function assignFile(file) {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  fileInput.files = transfer.files;
  setSelectedFile(file);
}

function isPreviewableImage(type = "") {
  return type.startsWith("image/");
}

function showResult(payload) {
  currentUpload = {
    cid: payload.file.cid,
    path: payload.file.storedPath,
    shortCode: payload.file.shortCode,
    type: payload.file.type || "file",
    name: payload.file.name,
  };
  resultCard.classList.remove("hidden");
  resultName.textContent = payload.file.name;
  resultType.textContent = payload.file.type || "file";
  renameInput.value = payload.file.name;
  shortLink.value = payload.links.short;
  pageLink.value = payload.links.page;
  imageLink.value = payload.links.image;
  downloadLink.value = payload.links.download;
  openLinkButton.href = payload.links.page;
  downloadLinkButton.href = payload.links.download;

  if (isPreviewableImage(payload.file.type)) {
    previewWrap.classList.remove("hidden");
    previewImage.src = payload.links.image;
    previewImage.alt = payload.file.name;
  } else {
    previewWrap.classList.add("hidden");
    previewImage.removeAttribute("src");
  }
}

async function regenerateLinks(name) {
  const response = await fetch("/api/links", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      cid: currentUpload?.cid,
      path: currentUpload?.path,
      shortCode: currentUpload?.shortCode,
      name,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Could not update links.");
  }

  return payload.links;
}

async function uploadCurrentFile(file) {
  const formData = new FormData();
  formData.append("file", file);

  const response = await fetch("/api/upload", {
    method: "POST",
    body: formData,
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Upload failed.");
  }

  return payload;
}

async function uploadFromImageUrl(imageUrl) {
  const response = await fetch("/api/upload-from-url", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ imageUrl }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Upload failed.");
  }

  return payload;
}

async function startUpload({ file, imageUrl } = {}) {
  if (isUploading) {
    return;
  }

  isUploading = true;
  uploadButton.disabled = true;
  uploadButton.textContent = "Uploading...";
  setStatus("Uploading to Pinata, please wait...");

  try {
    const payload = imageUrl ? await uploadFromImageUrl(imageUrl) : await uploadCurrentFile(file);
    showResult(payload);
    setStatus("Upload complete. Share link ready.");
  } catch (error) {
    setStatus(error.message || "Upload failed.", true);
  } finally {
    isUploading = false;
    uploadButton.disabled = false;
    uploadButton.textContent = "Upload Now";
  }
}

function extractImageUrlFromClipboard(event) {
  const html = event.clipboardData?.getData("text/html") || "";
  const plainText = (event.clipboardData?.getData("text/plain") || "").trim();

  const htmlMatch = html.match(/<img[^>]+src=["']([^"']+)["']/i);
  if (htmlMatch?.[1]) {
    return htmlMatch[1];
  }

  if (/^https?:\/\/\S+$/i.test(plainText)) {
    return plainText;
  }

  return "";
}

fileInput.addEventListener("change", () => {
  setSelectedFile(fileInput.files[0]);
});

["dragenter", "dragover"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach((eventName) => {
  dropzone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropzone.classList.remove("dragover");
  });
});

dropzone.addEventListener("drop", (event) => {
  const [file] = event.dataTransfer.files;
  if (!file) {
    return;
  }

  assignFile(file);
});

window.addEventListener("paste", (event) => {
  const items = Array.from(event.clipboardData?.items || []);
  const imageItem = items.find((item) => item.type.startsWith("image/"));

  if (!imageItem) {
    const imageUrl = extractImageUrlFromClipboard(event);
    if (!imageUrl) {
      return;
    }

    event.preventDefault();
    setStatus("Pasted image detected. Uploading now...");
    startUpload({ imageUrl });
    return;
  }

  const file = imageItem.getAsFile();
  if (!file) {
    return;
  }

  const extension = file.type.split("/")[1] || "png";
  const pastedFile = new File([file], `pasted-image-${Date.now()}.${extension}`, {
    type: file.type,
  });

  event.preventDefault();
  assignFile(pastedFile);
  setStatus("Pasted image detected. Uploading now...");
  startUpload({ file: pastedFile });
});

uploadForm.addEventListener("submit", async (event) => {
  event.preventDefault();

  const file = fileInput.files[0];
  if (!file) {
    setStatus("Please choose a file first.", true);
    return;
  }

  startUpload({ file });
});

renameButton.addEventListener("click", async () => {
  const nextName = renameInput.value.trim();

  if (!currentUpload?.cid) {
    setStatus("Upload a file first.", true);
    return;
  }

  if (!nextName) {
    setStatus("Enter a file name first.", true);
    return;
  }

  renameButton.disabled = true;
  renameButton.textContent = "Updating...";
  setStatus("Updating file name in links...");

  try {
    const links = await regenerateLinks(nextName);
    currentUpload.name = nextName;
    resultName.textContent = nextName;
    shortLink.value = links.short;
    pageLink.value = links.page;
    imageLink.value = links.image;
    downloadLink.value = links.download;
    openLinkButton.href = links.page;
    downloadLinkButton.href = links.download;

    if (isPreviewableImage(currentUpload.type)) {
      previewImage.src = links.image;
      previewImage.alt = nextName;
    }

    setStatus("File name updated in share links.");
  } catch (error) {
    setStatus(error.message || "Could not update file name.", true);
  } finally {
    renameButton.disabled = false;
    renameButton.textContent = "Update Name";
  }
});

document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const target = document.getElementById(button.dataset.copy);

    try {
      await navigator.clipboard.writeText(target.value);
      setStatus("Link copied.");
    } catch (error) {
      target.select();
      document.execCommand("copy");
      setStatus("Link copied.");
    }
  });
});
