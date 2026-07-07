/* =====================================================================
   MarkItDown — App Logic
   Drag & drop · Upload · Convert · Download · Toasts
   ===================================================================== */

(() => {
    "use strict";

    // ----- DOM refs ----------------------------------------------------------
    const dropzone      = document.getElementById("dropzone");
    const fileInput      = document.getElementById("file-input");
    const fileInfo       = document.getElementById("file-info");
    const fileName       = document.getElementById("file-name");
    const fileSize       = document.getElementById("file-size");
    const fileRemove     = document.getElementById("file-remove");
    const convertBtn     = document.getElementById("convert-btn");
    const uploadForm     = document.getElementById("upload-form");
    const toastContainer = document.getElementById("toast-container");

    // ----- Supported extensions (must match backend) -------------------------
    const SUPPORTED = new Set([
        ".pdf", ".docx", ".pptx", ".xlsx",
        ".html", ".htm", ".csv", ".json",
        ".xml", ".txt", ".rtf", ".md",
        ".jpg", ".jpeg", ".png", ".gif",
        ".bmp", ".tiff", ".tif", ".webp",
        ".wav", ".mp3", ".mp4",
        ".zip",
    ]);

    let selectedFile = null;

    // ----- Helpers -----------------------------------------------------------

    /** Return a human-readable file size string. */
    function formatSize(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    /** Get the lowercased extension including the dot. */
    function getExt(name) {
        const idx = name.lastIndexOf(".");
        return idx === -1 ? "" : name.slice(idx).toLowerCase();
    }

    // ----- Toast notifications -----------------------------------------------

    function showToast(message, type = "success") {
        const toast = document.createElement("div");
        toast.className = `toast toast--${type}`;

        const icon = type === "success"
            ? `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`
            : `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`;

        toast.innerHTML = `${icon}<span>${message}</span>`;
        toastContainer.appendChild(toast);

        // Auto-dismiss after 4 s
        setTimeout(() => {
            toast.classList.add("toast--out");
            toast.addEventListener("animationend", () => toast.remove());
        }, 4000);
    }

    // ----- File selection ----------------------------------------------------

    function selectFile(file) {
        const ext = getExt(file.name);

        if (!SUPPORTED.has(ext)) {
            showToast(`Unsupported file type: ${ext || "unknown"}`, "error");
            return;
        }

        selectedFile = file;
        fileName.textContent = file.name;
        fileSize.textContent = formatSize(file.size);
        fileInfo.hidden = false;
        dropzone.classList.add("dropzone--has-file");
        convertBtn.disabled = false;
    }

    function clearFile() {
        selectedFile = null;
        fileInput.value = "";
        fileInfo.hidden = true;
        dropzone.classList.remove("dropzone--has-file");
        convertBtn.disabled = true;
    }

    // ----- Drag & Drop -------------------------------------------------------

    let dragCounter = 0;

    dropzone.addEventListener("dragenter", (e) => {
        e.preventDefault();
        dragCounter++;
        dropzone.classList.add("dropzone--active");
    });

    dropzone.addEventListener("dragover", (e) => {
        e.preventDefault();         // required to allow drop
    });

    dropzone.addEventListener("dragleave", (e) => {
        e.preventDefault();
        dragCounter--;
        if (dragCounter === 0) {
            dropzone.classList.remove("dropzone--active");
        }
    });

    dropzone.addEventListener("drop", (e) => {
        e.preventDefault();
        dragCounter = 0;
        dropzone.classList.remove("dropzone--active");

        const files = e.dataTransfer.files;
        if (files.length > 0) {
            selectFile(files[0]);
        }
    });

    // ----- Click to browse ---------------------------------------------------

    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            fileInput.click();
        }
    });

    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) {
            selectFile(fileInput.files[0]);
        }
    });

    // ----- Remove file -------------------------------------------------------
    fileRemove.addEventListener("click", (e) => {
        e.stopPropagation();        // don't re-open file picker
        clearFile();
    });

    // ----- Upload & Convert --------------------------------------------------

    uploadForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        if (!selectedFile) return;

        // Enter loading state
        convertBtn.disabled = true;
        convertBtn.classList.add("btn--loading");

        try {
            const formData = new FormData();
            formData.append("file", selectedFile);

            const response = await fetch("/convert", {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(errorText || `Server error (${response.status})`);
            }

            // Get the filename from Content-Disposition header
            const disposition = response.headers.get("Content-Disposition") || "";
            const filenameMatch = disposition.match(/filename="?([^";\n]+)"?/);
            const downloadName = filenameMatch ? filenameMatch[1] : "converted.md";

            // Download the file
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = downloadName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);

            showToast(`${downloadName} downloaded successfully!`, "success");
            clearFile();
        } catch (err) {
            showToast(err.message || "Something went wrong.", "error");
        } finally {
            convertBtn.disabled = false;
            convertBtn.classList.remove("btn--loading");
            // Re-disable if no file selected after clear
            if (!selectedFile) {
                convertBtn.disabled = true;
            }
        }
    });
})();
