/* =====================================================================
   MarkItDown Toolbox — OCR Scanner tab
   Upload a scanned PDF -> POST /ocr -> show extracted text inline
   and offer it as a .md download.
   ===================================================================== */

(() => {
    "use strict";

    const MAX_BYTES = 20 * 1024 * 1024; // keep in sync with OCR_MAX_BYTES in main.py

    // ----- DOM refs ----------------------------------------------------------
    const dropzone    = document.getElementById("ocr-dropzone");
    const fileInput   = document.getElementById("ocr-file-input");
    const fileInfo    = document.getElementById("ocr-file-info");
    const fileName    = document.getElementById("ocr-file-name");
    const fileSize    = document.getElementById("ocr-file-size");
    const fileRemove  = document.getElementById("ocr-file-remove");
    const form        = document.getElementById("ocr-form");
    const ocrBtn      = document.getElementById("ocr-btn");
    const resultCard  = document.getElementById("ocr-result");
    const resultText  = document.getElementById("ocr-text");
    const copyBtn     = document.getElementById("ocr-copy");
    const downloadBtn = document.getElementById("ocr-download");

    let selectedFile = null;
    let downloadName = "ocr.md";

    const toast = (msg, type) => window.showToast ? window.showToast(msg, type) : alert(msg);

    // ----- File selection ------------------------------------------------------
    function selectFile(file) {
        if (!file.name.toLowerCase().endsWith(".pdf")) {
            toast("OCR works on PDF files only.", "error");
            return;
        }
        if (file.size > MAX_BYTES) {
            toast(`File is too big (${window.formatSize(file.size)}). Max is 20 MB.`, "error");
            return;
        }
        selectedFile = file;
        fileName.textContent = file.name;
        fileSize.textContent = window.formatSize(file.size);
        fileInfo.hidden = false;
        dropzone.classList.add("dropzone--has-file");
        ocrBtn.disabled = false;
    }

    function clearFile() {
        selectedFile = null;
        fileInput.value = "";
        fileInfo.hidden = true;
        dropzone.classList.remove("dropzone--has-file");
        ocrBtn.disabled = true;
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

    // ----- Submit -> /ocr --------------------------------------------------------
    form.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!selectedFile) return;

        ocrBtn.disabled = true;
        ocrBtn.classList.add("btn--loading");
        resultCard.hidden = true;

        try {
            const formData = new FormData();
            formData.append("file", selectedFile);

            const response = await fetch("/ocr", { method: "POST", body: formData });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `Server error (${response.status})`);
            }

            const disposition = response.headers.get("Content-Disposition") || "";
            const match = disposition.match(/filename="?([^";\n]+)"?/);
            downloadName = match ? match[1] : "ocr.md";

            const text = await response.text();
            resultText.textContent = text;
            resultCard.hidden = false;
            resultCard.scrollIntoView({ behavior: "smooth", block: "start" });

            toast("Text extracted! Review it below.", "success");
        } catch (err) {
            toast(err.message || "OCR failed.", "error");
        } finally {
            ocrBtn.classList.remove("btn--loading");
            ocrBtn.disabled = !selectedFile;
        }
    });

    // ----- Result actions ----------------------------------------------------------
    copyBtn.addEventListener("click", async () => {
        try {
            await navigator.clipboard.writeText(resultText.textContent);
            toast("Copied to clipboard!", "success");
        } catch {
            toast("Could not copy — select the text manually.", "error");
        }
    });

    downloadBtn.addEventListener("click", () => {
        const blob = new Blob([resultText.textContent], { type: "text/markdown" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = downloadName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    });
})();
