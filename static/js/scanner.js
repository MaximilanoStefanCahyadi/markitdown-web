/* =====================================================================
   MarkItDown Toolbox — Photo Scanner tab
   Add pages by UPLOAD or by LIVE CAMERA capture -> reorder/delete them
   -> POST all pages to /scan (OpenCV pipeline, one PDF page each)
   -> preview the combined PDF with PDF.js -> download.
   ===================================================================== */

(() => {
    "use strict";

    const MAX_BYTES = 15 * 1024 * 1024; // keep in sync with SCAN_MAX_BYTES in main.py
    const MAX_PAGES = 20;               // keep in sync with SCAN_MAX_PAGES in main.py
    const EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"]);

    // ----- DOM refs ----------------------------------------------------------
    const dropzone     = document.getElementById("scan-dropzone");
    const fileInput    = document.getElementById("scan-file-input");
    const cameraBtn    = document.getElementById("scan-camera-btn");
    const cameraPanel  = document.getElementById("scan-camera");
    const video        = document.getElementById("scan-video");
    const captureBtn   = document.getElementById("scan-capture");
    const cameraClose  = document.getElementById("scan-camera-close");
    const queueEl      = document.getElementById("scan-queue");
    const form         = document.getElementById("scan-form");
    const scanBtn      = document.getElementById("scan-btn");
    const resultCard   = document.getElementById("scan-result");
    const previewCanvas = document.getElementById("scan-preview-canvas");
    const previewCaption = document.getElementById("scan-preview-caption");
    const downloadBtn  = document.getElementById("scan-download");
    const modeButtons  = document.querySelectorAll("[data-scan-mode]");

    // ----- State -------------------------------------------------------------
    let pages = [];          // [{ blob, thumbUrl }]
    let mode = "color";
    let stream = null;       // active MediaStream while the camera is open
    let resultBlob = null;
    let downloadName = "scan.pdf";

    const toast = (msg, type) => window.showToast ? window.showToast(msg, type) : alert(msg);

    // ----- Mode picker ---------------------------------------------------------
    modeButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            mode = btn.dataset.scanMode;
            modeButtons.forEach((b) => b.classList.toggle("tool-btn--active", b === btn));
        });
    });

    // ----- Page queue ----------------------------------------------------------
    function addPage(blob) {
        if (!blob) return;
        if (pages.length >= MAX_PAGES) {
            toast(`That's the ${MAX_PAGES}-page limit for one PDF.`, "error");
            return;
        }
        if (blob.size > MAX_BYTES) {
            toast(`A page is too big (${window.formatSize(blob.size)}). Max is 15 MB.`, "error");
            return;
        }
        pages.push({ blob, thumbUrl: URL.createObjectURL(blob) });
        renderQueue();
    }

    function removePage(index) {
        URL.revokeObjectURL(pages[index].thumbUrl);
        pages.splice(index, 1);
        renderQueue();
    }

    function movePage(index, delta) {
        const target = index + delta;
        if (target < 0 || target >= pages.length) return;
        [pages[index], pages[target]] = [pages[target], pages[index]];
        renderQueue();
    }

    function renderQueue() {
        queueEl.innerHTML = "";
        pages.forEach((page, i) => {
            const item = document.createElement("div");
            item.className = "scan-queue__item";

            const badge = document.createElement("span");
            badge.className = "scan-queue__num";
            badge.textContent = String(i + 1);

            const img = document.createElement("img");
            img.className = "scan-queue__thumb";
            img.src = page.thumbUrl;
            img.alt = `Page ${i + 1}`;

            const controls = document.createElement("div");
            controls.className = "scan-queue__controls";
            controls.append(
                iconButton("‹", "Move left", () => movePage(i, -1), i === 0),
                iconButton("›", "Move right", () => movePage(i, 1), i === pages.length - 1),
                iconButton("×", "Remove page", () => removePage(i), false, "scan-queue__del"),
            );

            item.append(badge, img, controls);
            queueEl.appendChild(item);
        });

        queueEl.hidden = pages.length === 0;
        scanBtn.disabled = pages.length === 0;
    }

    function iconButton(label, title, onClick, disabled, extraClass = "") {
        const b = document.createElement("button");
        b.type = "button";
        b.className = `scan-queue__btn ${extraClass}`.trim();
        b.textContent = label;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.disabled = disabled;
        b.addEventListener("click", onClick);
        return b;
    }

    // ----- File upload path ----------------------------------------------------
    function addFiles(fileList) {
        for (const file of fileList) {
            const dot = file.name.lastIndexOf(".");
            const ext = dot === -1 ? "" : file.name.slice(dot).toLowerCase();
            if (!EXTENSIONS.has(ext)) {
                toast(`Skipped ${file.name}: not a photo.`, "error");
                continue;
            }
            addPage(file);
        }
    }

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
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) addFiles(fileInput.files);
        fileInput.value = ""; // allow re-selecting the same file
    });

    // ----- Camera path ---------------------------------------------------------
    const cameraSupported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

    if (!cameraSupported || !window.isSecureContext) {
        // getUserMedia needs HTTPS or localhost. Hide the button and explain.
        cameraBtn.hidden = true;
    }

    async function openCamera() {
        if (!window.isSecureContext) {
            toast("The camera needs HTTPS (or localhost) to work.", "error");
            return;
        }
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: "environment" }, // rear camera on phones
                    width: { ideal: 1920 },
                    height: { ideal: 1080 },
                },
                audio: false,
            });
            video.srcObject = stream;
            cameraPanel.hidden = false;
            cameraBtn.hidden = true;
        } catch (err) {
            toast(`Could not open the camera: ${err.message}`, "error");
        }
    }

    function closeCamera() {
        if (stream) {
            stream.getTracks().forEach((t) => t.stop());
            stream = null;
        }
        video.srcObject = null;
        cameraPanel.hidden = true;
        if (cameraSupported && window.isSecureContext) cameraBtn.hidden = false;
    }

    function capture() {
        if (!video.videoWidth) {
            toast("Camera is still warming up — try again in a moment.", "error");
            return;
        }
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d").drawImage(video, 0, 0);
        canvas.toBlob((blob) => {
            addPage(blob);
            toast(`Page ${pages.length} captured.`, "success");
        }, "image/jpeg", 0.92);
    }

    cameraBtn.addEventListener("click", openCamera);
    cameraClose.addEventListener("click", closeCamera);
    captureBtn.addEventListener("click", capture);

    // Release the camera when it's no longer visible: tab hidden, another
    // toolbox tab clicked, or the page is being unloaded.
    document.addEventListener("visibilitychange", () => {
        if (document.hidden) closeCamera();
    });
    window.addEventListener("pagehide", closeCamera);
    document.querySelectorAll(".tab-btn").forEach((btn) => {
        if (btn.dataset.tab !== "scan") btn.addEventListener("click", closeCamera);
    });

    // ----- Preview the returned PDF's first page with PDF.js ----------------------
    async function renderPreview(blob, pageCount) {
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

        previewCaption.textContent = pageCount > 1
            ? `Page 1 of ${pageCount} — download for all pages`
            : "1 page";
    }

    // ----- Submit -> /scan --------------------------------------------------------
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (pages.length === 0) return;

        scanBtn.disabled = true;
        scanBtn.classList.add("btn--loading");
        resultCard.hidden = true;

        try {
            const formData = new FormData();
            formData.append("mode", mode);
            pages.forEach((page, i) => {
                formData.append("files", page.blob, `page-${i + 1}.jpg`);
            });

            const response = await fetch("/scan", { method: "POST", body: formData });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `Server error (${response.status})`);
            }

            const disposition = response.headers.get("Content-Disposition") || "";
            const match = disposition.match(/filename="?([^";\n]+)"?/);
            downloadName = match ? match[1] : "scan.pdf";

            const pageCount = parseInt(response.headers.get("X-Scan-Pages") || "1", 10);
            const detected = parseInt(response.headers.get("X-Scan-Detected") || "0", 10);

            resultBlob = await response.blob();
            await renderPreview(resultBlob, pageCount);
            resultCard.hidden = false;
            resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

            const noun = pageCount === 1 ? "page" : "pages";
            toast(`Created a ${pageCount}-${noun} PDF (${detected} auto-cropped).`, "success");
        } catch (err) {
            toast(err.message || "Scan failed.", "error");
        } finally {
            scanBtn.classList.remove("btn--loading");
            scanBtn.disabled = pages.length === 0;
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
