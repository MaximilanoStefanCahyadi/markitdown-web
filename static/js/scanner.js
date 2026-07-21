/* =====================================================================
   MarkItDown Toolbox — Photo Scanner tab
   Upload a document photo -> POST /scan (OpenCV pipeline on the server)
   -> preview the returned PDF's page with PDF.js -> download.
   ===================================================================== */

(() => {
    "use strict";

    const MAX_BYTES = 15 * 1024 * 1024; // keep in sync with SCAN_MAX_BYTES in main.py
    const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"]);

    // ----- DOM refs ----------------------------------------------------------
    const dropzone    = document.getElementById("scan-dropzone");
    const fileInput   = document.getElementById("scan-file-input");
    const fileInfo    = document.getElementById("scan-file-info");
    const fileName    = document.getElementById("scan-file-name");
    const fileSize    = document.getElementById("scan-file-size");
    const fileRemove  = document.getElementById("scan-file-remove");
    const form        = document.getElementById("scan-form");
    const scanBtn     = document.getElementById("scan-btn");
    const resultCard  = document.getElementById("scan-result");
    const previewCanvas = document.getElementById("scan-preview-canvas");
    const downloadBtn = document.getElementById("scan-download");
    const modeButtons = document.querySelectorAll("[data-scan-mode]");

    let selectedFile = null;
    let mode = "color";
    let resultBlob = null;
    let downloadName = "scanned.pdf";

    const toast = (msg, type) => window.showToast ? window.showToast(msg, type) : alert(msg);

    // ----- Mode picker ---------------------------------------------------------
    modeButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            mode = btn.dataset.scanMode;
            modeButtons.forEach((b) => b.classList.toggle("tool-btn--active", b === btn));
        });
    });

    // ----- File selection ------------------------------------------------------
    function selectFile(file) {
        const dot = file.name.lastIndexOf(".");
        const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
        if (!EXTENSIONS.has(ext)) {
            toast("Please choose a photo (JPG, PNG, WEBP, BMP, or TIFF).", "error");
            return;
        }
        if (file.size > MAX_BYTES) {
            toast(`Photo is too big (${window.formatSize(file.size)}). Max is 15 MB.`, "error");
            return;
        }
        selectedFile = file;
        fileName.textContent = file.name;
        fileSize.textContent = window.formatSize(file.size);
        fileInfo.hidden = false;
        dropzone.classList.add("dropzone--has-file");
        scanBtn.disabled = false;
    }

    function clearFile() {
        selectedFile = null;
        fileInput.value = "";
        fileInfo.hidden = true;
        dropzone.classList.remove("dropzone--has-file");
        scanBtn.disabled = true;
    }

    // ----- Dropzone ------------------------------------------------------------
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInput.click();
        }
    });
    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropzone.classList.add("dropzone--active");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dropzone--active"));
    dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dropzone.classList.remove("dropzone--active");
        if (e.dataTransfer.files.length > 0) selectFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) selectFile(fileInput.files[0]);
    });
    fileRemove.addEventListener("click", (e) => {
        e.stopPropagation();
        clearFile();
    });

    // ----- Preview the returned PDF with PDF.js ----------------------------------
    async function renderPreview(blob) {
        const bytes = await blob.arrayBuffer();
        const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
        const page = await doc.getPage(1);

        const container = previewCanvas.parentElement;
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1.5, (container.clientWidth || 540) / baseViewport.width);
        const viewport = page.getViewport({ scale });

        previewCanvas.width = viewport.width;
        previewCanvas.height = viewport.height;
        await page.render({ canvasContext: previewCanvas.getContext("2d"), viewport }).promise;
    }

    // ----- Submit -> /scan --------------------------------------------------------
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!selectedFile) return;

        scanBtn.disabled = true;
        scanBtn.classList.add("btn--loading");
        resultCard.hidden = true;

        try {
            const formData = new FormData();
            formData.append("file", selectedFile);
            formData.append("mode", mode);

            const response = await fetch("/scan", { method: "POST", body: formData });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `Server error (${response.status})`);
            }

            const disposition = response.headers.get("Content-Disposition") || "";
            const match = disposition.match(/filename="?([^";\n]+)"?/);
            downloadName = match ? match[1] : "scanned.pdf";

            resultBlob = await response.blob();
            await renderPreview(resultBlob);
            resultCard.hidden = false;
            resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

            if (response.headers.get("X-Scan-Detected") === "true") {
                toast("Page detected, flattened, and enhanced!", "success");
            } else {
                toast("No page edges found — enhanced the full photo instead.", "success");
            }
        } catch (err) {
            toast(err.message || "Scan failed.", "error");
        } finally {
            scanBtn.classList.remove("btn--loading");
            scanBtn.disabled = !selectedFile;
        }
    });

    // ----- Download -----------------------------------------------------------------
    downloadBtn.addEventListener("click", () => {
        if (!resultBlob) return;
        const url = URL.createObjectURL(resultBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });
})();
