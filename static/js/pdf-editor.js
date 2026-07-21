/* =====================================================================
   MarkItDown Toolbox — PDF Editor (100% client-side)

   View:   PDF.js renders each page onto a <canvas>.
   Edit:   A same-size transparent overlay <div> sits on top of each
           canvas; edits (text boxes, whiteout rects, signatures) are
           plain DOM elements positioned in canvas pixels.
   Export: pdf-lib re-opens the ORIGINAL bytes and bakes every edit
           into the PDF, converting canvas px -> PDF points.

   THE #1 GOTCHA — two different coordinate systems:
     Canvas: origin TOP-left,    y grows DOWN, units = CSS px at `scale`
     PDF:    origin BOTTOM-left, y grows UP,   units = points (1/72")
   All conversion happens in toPdfCoords() below. Nowhere else.
   ===================================================================== */

(() => {
    "use strict";

    pdfjsLib.GlobalWorkerOptions.workerSrc = "/static/vendor/pdfjs/pdf.worker.min.js";

    // ----- DOM refs ----------------------------------------------------------
    const dropzone    = document.getElementById("editor-dropzone");
    const fileInput   = document.getElementById("editor-file-input");
    const toolbar     = document.getElementById("editor-toolbar");
    const pagesEl     = document.getElementById("editor-pages");
    const fontSizeEl  = document.getElementById("tool-fontsize");
    const undoBtn     = document.getElementById("tool-undo");
    const closeBtn    = document.getElementById("tool-close");
    const downloadBtn = document.getElementById("editor-download");
    const modeButtons = [
        document.getElementById("tool-text"),
        document.getElementById("tool-whiteout"),
        document.getElementById("tool-signature"),
    ];

    // Signature modal
    const sigModal    = document.getElementById("sig-modal");
    const sigBackdrop = document.getElementById("sig-backdrop");
    const sigCanvas   = document.getElementById("sig-canvas");
    const sigClear    = document.getElementById("sig-clear");
    const sigCancel   = document.getElementById("sig-cancel");
    const sigUse      = document.getElementById("sig-use");

    // ----- State -------------------------------------------------------------
    let originalBytes = null;   // ArrayBuffer kept pristine for pdf-lib export
    let originalName  = "document.pdf";
    let pageInfos     = [];     // per page: { scale, overlay, edits: [] }
    let editHistory   = [];     // flat list of edits in placement order (for Undo)
    let mode          = null;   // "text" | "whiteout" | "signature" | null
    let signaturePad  = null;
    let sigDataUrl    = null;   // last drawn signature PNG (reused until redrawn)

    const toast = (msg, type) => window.showToast ? window.showToast(msg, type) : alert(msg);

    // ----- Mode switching ------------------------------------------------------
    function setMode(newMode) {
        mode = newMode;
        modeButtons.forEach((b) => b.classList.toggle("tool-btn--active", b.dataset.mode === mode));
        pagesEl.classList.toggle("editor-pages--crosshair", mode === "whiteout");
    }

    modeButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
            if (btn.dataset.mode === "signature") {
                openSignatureModal();
            } else {
                setMode(mode === btn.dataset.mode ? null : btn.dataset.mode);
            }
        });
    });

    // ----- Load & render -------------------------------------------------------
    async function loadPdf(file) {
        if (!file.name.toLowerCase().endsWith(".pdf")) {
            toast("Please choose a PDF file.", "error");
            return;
        }

        originalBytes = await file.arrayBuffer();
        originalName = file.name;

        // PDF.js DETACHES the buffer we hand it — give it a copy and keep
        // `originalBytes` untouched for pdf-lib at export time.
        const pdfjsBytes = originalBytes.slice(0);

        pagesEl.innerHTML = "";
        pageInfos = [];
        editHistory = [];
        setMode(null);

        try {
            const doc = await pdfjsLib.getDocument({ data: pdfjsBytes }).promise;
            const containerWidth = Math.min(pagesEl.clientWidth || 580, 900);

            for (let i = 1; i <= doc.numPages; i++) {
                const page = await doc.getPage(i);
                const baseViewport = page.getViewport({ scale: 1 });
                const scale = Math.min(1.5, containerWidth / baseViewport.width);
                const viewport = page.getViewport({ scale });

                const wrap = document.createElement("div");
                wrap.className = "page-wrap";
                wrap.style.width = `${viewport.width}px`;
                wrap.style.height = `${viewport.height}px`;

                // Canvas rendered at logical size (no devicePixelRatio) so the
                // overlay's px measurements map 1:1 onto the canvas.
                const canvas = document.createElement("canvas");
                canvas.width = viewport.width;
                canvas.height = viewport.height;

                const overlay = document.createElement("div");
                overlay.className = "overlay";
                overlay.dataset.page = String(i - 1);

                wrap.appendChild(canvas);
                wrap.appendChild(overlay);
                pagesEl.appendChild(wrap);

                await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

                pageInfos.push({ scale, overlay, edits: [] });
                attachOverlayHandlers(overlay, i - 1);
            }

            toolbar.hidden = false;
            toast(`Loaded ${doc.numPages} page${doc.numPages > 1 ? "s" : ""}. Pick a tool to start editing.`, "success");
        } catch (err) {
            toast(`Could not open PDF: ${err.message}`, "error");
            closePdf();
        }
    }

    function closePdf() {
        originalBytes = null;
        pageInfos = [];
        editHistory = [];
        pagesEl.innerHTML = "";
        toolbar.hidden = true;
        fileInput.value = "";
        setMode(null);
    }

    closeBtn.addEventListener("click", closePdf);

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
        if (e.dataTransfer.files.length > 0) loadPdf(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
        if (fileInput.files.length > 0) loadPdf(fileInput.files[0]);
    });

    // ----- Overlay interactions --------------------------------------------------
    function attachOverlayHandlers(overlay, pageIndex) {
        // Click: place a text box or a signature
        overlay.addEventListener("click", (e) => {
            if (e.target !== overlay) return; // clicks on existing edits are theirs
            const rect = overlay.getBoundingClientRect();
            const xPx = e.clientX - rect.left;
            const yPx = e.clientY - rect.top;

            if (mode === "text") placeText(pageIndex, xPx, yPx);
            else if (mode === "signature" && sigDataUrl) placeSignature(pageIndex, xPx, yPx);
        });

        // Drag: draw a whiteout rectangle
        let dragStart = null;
        let dragRectEl = null;

        overlay.addEventListener("mousedown", (e) => {
            if (mode !== "whiteout" || e.target !== overlay) return;
            e.preventDefault();
            const rect = overlay.getBoundingClientRect();
            dragStart = { x: e.clientX - rect.left, y: e.clientY - rect.top };
            dragRectEl = document.createElement("div");
            dragRectEl.className = "edit-item edit-rect";
            overlay.appendChild(dragRectEl);
        });

        overlay.addEventListener("mousemove", (e) => {
            if (!dragStart || !dragRectEl) return;
            const rect = overlay.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;
            Object.assign(dragRectEl.style, {
                left: `${Math.min(dragStart.x, x)}px`,
                top: `${Math.min(dragStart.y, y)}px`,
                width: `${Math.abs(x - dragStart.x)}px`,
                height: `${Math.abs(y - dragStart.y)}px`,
            });
        });

        const endDrag = () => {
            if (!dragStart || !dragRectEl) return;
            const w = dragRectEl.offsetWidth;
            const h = dragRectEl.offsetHeight;
            if (w < 4 || h < 4) {
                dragRectEl.remove(); // accidental click, not a drag
            } else {
                registerEdit(pageIndex, {
                    type: "rect",
                    el: dragRectEl,
                    xPx: dragRectEl.offsetLeft,
                    yPx: dragRectEl.offsetTop,
                    wPx: w,
                    hPx: h,
                });
            }
            dragStart = null;
            dragRectEl = null;
        };
        overlay.addEventListener("mouseup", endDrag);
        overlay.addEventListener("mouseleave", endDrag);
    }

    function registerEdit(pageIndex, edit) {
        pageInfos[pageIndex].edits.push(edit);
        editHistory.push({ pageIndex, edit });
    }

    // ----- Text edits --------------------------------------------------------------
    function placeText(pageIndex, xPx, yPx) {
        const overlay = pageInfos[pageIndex].overlay;
        const fontSizePx = parseInt(fontSizeEl.value, 10) || 16;

        const el = document.createElement("div");
        el.className = "edit-item edit-text";
        el.contentEditable = "true";
        el.spellcheck = false;
        Object.assign(el.style, {
            left: `${xPx}px`,
            top: `${yPx}px`,
            fontSize: `${fontSizePx}px`,
        });
        overlay.appendChild(el);
        el.focus();

        registerEdit(pageIndex, { type: "text", el, xPx, yPx, fontSizePx });
    }

    // ----- Signature -----------------------------------------------------------------
    function openSignatureModal() {
        sigModal.hidden = false;
        if (!signaturePad) {
            signaturePad = new SignaturePad(sigCanvas, {
                penColor: "#1e293b",
                backgroundColor: "rgba(0,0,0,0)", // transparent PNG
            });
        }
    }

    function closeSignatureModal() {
        sigModal.hidden = true;
    }

    sigClear.addEventListener("click", () => signaturePad && signaturePad.clear());
    sigCancel.addEventListener("click", closeSignatureModal);
    sigBackdrop.addEventListener("click", closeSignatureModal);

    sigUse.addEventListener("click", () => {
        if (!signaturePad || signaturePad.isEmpty()) {
            toast("Draw a signature first.", "error");
            return;
        }
        sigDataUrl = signaturePad.toDataURL("image/png");
        closeSignatureModal();
        setMode("signature");
        toast("Now click on a page to place your signature.", "success");
    });

    function placeSignature(pageIndex, xPx, yPx) {
        const overlay = pageInfos[pageIndex].overlay;
        const wPx = 160; // default size; drag the corner handle to resize
        const hPx = wPx * (sigCanvas.height / sigCanvas.width);

        const el = document.createElement("img");
        el.className = "edit-item edit-sig";
        el.src = sigDataUrl;
        el.draggable = false;
        Object.assign(el.style, {
            left: `${xPx - wPx / 2}px`,
            top: `${yPx - hPx / 2}px`,
            width: `${wPx}px`,
            height: `${hPx}px`,
        });

        const edit = {
            type: "sig",
            el,
            dataUrl: sigDataUrl,
            xPx: xPx - wPx / 2,
            yPx: yPx - hPx / 2,
            wPx,
            hPx,
        };

        overlay.appendChild(el);
        makeMovable(el, edit);
        registerEdit(pageIndex, edit);
    }

    /** Drag to move, drag the bottom-right corner (last 14px) to resize. */
    function makeMovable(el, edit) {
        el.addEventListener("mousedown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = el.offsetLeft;
            const startTop = el.offsetTop;
            const startW = el.offsetWidth;
            const startH = el.offsetHeight;
            const resizing =
                e.offsetX > startW - 14 && e.offsetY > startH - 14;

            const onMove = (me) => {
                const dx = me.clientX - startX;
                const dy = me.clientY - startY;
                if (resizing) {
                    const w = Math.max(30, startW + dx);
                    el.style.width = `${w}px`;
                    el.style.height = `${w * (startH / startW)}px`;
                } else {
                    el.style.left = `${startLeft + dx}px`;
                    el.style.top = `${startTop + dy}px`;
                }
            };
            const onUp = () => {
                document.removeEventListener("mousemove", onMove);
                document.removeEventListener("mouseup", onUp);
                edit.xPx = el.offsetLeft;
                edit.yPx = el.offsetTop;
                edit.wPx = el.offsetWidth;
                edit.hPx = el.offsetHeight;
            };
            document.addEventListener("mousemove", onMove);
            document.addEventListener("mouseup", onUp);
        });
    }

    // ----- Undo ---------------------------------------------------------------------
    undoBtn.addEventListener("click", () => {
        const last = editHistory.pop();
        if (!last) {
            toast("Nothing to undo.", "error");
            return;
        }
        const { pageIndex, edit } = last;
        const edits = pageInfos[pageIndex].edits;
        const idx = edits.indexOf(edit);
        if (idx !== -1) edits.splice(idx, 1);
        edit.el.remove();
    });

    // ----- Export with pdf-lib ---------------------------------------------------------
    /**
     * Canvas px (top-left origin, y down) -> PDF points (bottom-left origin, y up).
     */
    function toPdfCoords(xPx, yPx, page, scale) {
        const { height } = page.getSize(); // points
        return { x: xPx / scale, y: height - yPx / scale };
    }

    downloadBtn.addEventListener("click", async () => {
        if (!originalBytes) return;

        downloadBtn.disabled = true;
        downloadBtn.classList.add("btn--loading");

        try {
            const { PDFDocument, StandardFonts, rgb } = PDFLib;
            const doc = await PDFDocument.load(originalBytes);
            const font = await doc.embedFont(StandardFonts.Helvetica);
            const pages = doc.getPages();

            for (let i = 0; i < pageInfos.length; i++) {
                const { scale, edits } = pageInfos[i];
                const page = pages[i];

                for (const edit of edits) {
                    if (edit.type === "rect") {
                        const { x, y } = toPdfCoords(edit.xPx, edit.yPx, page, scale);
                        // pdf-lib rects are anchored at their BOTTOM-left corner
                        page.drawRectangle({
                            x,
                            y: y - edit.hPx / scale,
                            width: edit.wPx / scale,
                            height: edit.hPx / scale,
                            color: rgb(1, 1, 1),
                        });
                    } else if (edit.type === "text") {
                        const text = edit.el.innerText.trim();
                        if (!text) continue;
                        const { x, y } = toPdfCoords(edit.xPx, edit.yPx, page, scale);
                        const sizePts = edit.fontSizePx / scale;
                        const lines = text.split("\n");
                        lines.forEach((line, n) => {
                            page.drawText(line, {
                                // drawText's y is the BASELINE -> shift down ~1 font size
                                x,
                                y: y - sizePts * (n + 1),
                                size: sizePts,
                                font,
                                color: rgb(0.05, 0.05, 0.1),
                            });
                        });
                    } else if (edit.type === "sig") {
                        const png = await doc.embedPng(edit.dataUrl);
                        const { x, y } = toPdfCoords(edit.xPx, edit.yPx, page, scale);
                        page.drawImage(png, {
                            x,
                            y: y - edit.hPx / scale, // images anchor bottom-left too
                            width: edit.wPx / scale,
                            height: edit.hPx / scale,
                        });
                    }
                }
            }

            const outBytes = await doc.save();
            const blob = new Blob([outBytes], { type: "application/pdf" });
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = originalName.replace(/\.pdf$/i, "") + ".edited.pdf";
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);

            toast("Edited PDF downloaded!", "success");
        } catch (err) {
            toast(`Export failed: ${err.message}`, "error");
        } finally {
            downloadBtn.disabled = false;
            downloadBtn.classList.remove("btn--loading");
        }
    });
})();
