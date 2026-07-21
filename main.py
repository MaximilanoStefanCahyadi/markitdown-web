import io
import os
import tempfile
from pathlib import Path

import fitz  # PyMuPDF — renders PDF pages to images without system deps
import pytesseract
from fastapi import FastAPI, File, Form, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from markitdown import MarkItDown
from PIL import Image

from scanner import scan_photo_to_pdf

app = FastAPI(
    title="MarkItDown Toolbox",
    description="Convert documents to Markdown, edit PDFs, and OCR scans",
)

# ---------------------------------------------------------------------------
# Static files & templates
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).resolve().parent

app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# ---------------------------------------------------------------------------
# Converter instance (reused across requests)
# ---------------------------------------------------------------------------
md_converter = MarkItDown()

# Supported input extensions
SUPPORTED_EXTENSIONS = {
    ".pdf", ".docx", ".pptx", ".xlsx",
    ".html", ".htm", ".csv", ".json",
    ".xml", ".txt", ".rtf", ".md",
    ".jpg", ".jpeg", ".png", ".gif",
    ".bmp", ".tiff", ".tif", ".webp",
    ".wav", ".mp3", ".mp4",
    ".zip",
}


@app.get("/", response_class=HTMLResponse)
async def upload_page():
    """Serve the landing page."""
    html_path = BASE_DIR / "templates" / "index.html"
    return HTMLResponse(content=html_path.read_text(encoding="utf-8"))


@app.post("/convert")
async def convert_file(file: UploadFile = File(...)):
    """Accept an uploaded file, convert it to Markdown, and return the .md file."""

    # --- Validate extension ---------------------------------------------------
    original_name = file.filename or "document"
    ext = Path(original_name).suffix.lower()

    if ext not in SUPPORTED_EXTENSIONS:
        return Response(
            content=f"Unsupported file type: {ext}",
            status_code=400,
            media_type="text/plain",
        )

    # --- Save upload to a temp file so markitdown can read it -----------------
    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=ext) as tmp:
            contents = await file.read()
            tmp.write(contents)
            tmp_path = tmp.name

        # --- Convert -----------------------------------------------------------
        result = md_converter.convert(tmp_path)
        markdown_text = result.text_content

        # --- Build response filename -------------------------------------------
        stem = Path(original_name).stem
        output_filename = f"{stem}.md"

        return Response(
            content=markdown_text,
            media_type="text/markdown",
            headers={
                "Content-Disposition": f'attachment; filename="{output_filename}"'
            },
        )

    except Exception as exc:
        return Response(
            content=f"Conversion failed: {str(exc)}",
            status_code=500,
            media_type="text/plain",
        )

    finally:
        # Clean up temp file
        if "tmp_path" in locals():
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# OCR — scanned PDFs -> text via Tesseract
# ---------------------------------------------------------------------------
# Tuned for a 512 MB Render instance: process ONE page at a time, cap the
# page count, and render at a moderate DPI. Bump these on bigger machines.
OCR_MAX_BYTES = 20 * 1024 * 1024   # 20 MB upload limit
OCR_MAX_PAGES = 20
OCR_DPI = 150                      # 150 DPI is plenty for Tesseract


def _ocr_pdf_file(path: str) -> str:
    """Render each PDF page to an image and OCR it. Returns Markdown."""
    doc = fitz.open(path)
    try:
        page_total = doc.page_count
        page_count = min(page_total, OCR_MAX_PAGES)
        zoom = OCR_DPI / 72  # PDF native resolution is 72 DPI
        parts = []

        for i in range(page_count):
            # One page in RAM at a time — never accumulate pixmaps.
            pix = doc[i].get_pixmap(matrix=fitz.Matrix(zoom, zoom))
            img = Image.open(io.BytesIO(pix.tobytes("png")))
            text = pytesseract.image_to_string(img).strip()
            parts.append(f"## Page {i + 1}\n\n{text}")
            del pix, img

        if page_total > OCR_MAX_PAGES:
            parts.append(
                f"*Stopped after {OCR_MAX_PAGES} pages "
                f"(document has {page_total}).*"
            )
        return "\n\n".join(parts)
    finally:
        doc.close()


# NOTE: plain `def` (not `async def`) on purpose — FastAPI runs it in a
# worker thread, so the CPU-heavy OCR never blocks the event loop.
# Locally this route needs the Tesseract binary installed; in production
# the Dockerfile installs it (apt-get install tesseract-ocr).
@app.post("/ocr")
def ocr_pdf(file: UploadFile = File(...)):
    """Accept a scanned PDF, OCR it with Tesseract, return Markdown text."""

    original_name = file.filename or "document.pdf"
    ext = Path(original_name).suffix.lower()

    if ext != ".pdf":
        return Response(
            content=f"OCR supports PDF files only (got: {ext or 'unknown'})",
            status_code=400,
            media_type="text/plain",
        )

    contents = file.file.read()
    if len(contents) > OCR_MAX_BYTES:
        return Response(
            content=f"File too large: max {OCR_MAX_BYTES // (1024 * 1024)} MB",
            status_code=413,
            media_type="text/plain",
        )

    try:
        with tempfile.NamedTemporaryFile(delete=False, suffix=".pdf") as tmp:
            tmp.write(contents)
            tmp_path = tmp.name

        markdown_text = _ocr_pdf_file(tmp_path)

        stem = Path(original_name).stem
        return Response(
            content=markdown_text,
            media_type="text/markdown",
            headers={
                "Content-Disposition": f'attachment; filename="{stem}.ocr.md"'
            },
        )

    except Exception as exc:
        return Response(
            content=f"OCR failed: {str(exc)}",
            status_code=500,
            media_type="text/plain",
        )

    finally:
        if "tmp_path" in locals():
            try:
                os.unlink(tmp_path)
            except OSError:
                pass


# ---------------------------------------------------------------------------
# Photo scanner — photo of a document -> flattened, enhanced, one-page PDF
# (the OpenCV pipeline lives in scanner.py)
# ---------------------------------------------------------------------------
SCAN_MAX_BYTES = 15 * 1024 * 1024  # 15 MB — plenty for any phone photo
SCAN_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".tiff", ".tif"}
SCAN_MODES = {"color", "gray", "bw"}


# Plain `def` again: OpenCV work is CPU-bound, so FastAPI threads it.
@app.post("/scan")
def scan_photo(file: UploadFile = File(...), mode: str = Form("color")):
    """Accept a document photo, detect+flatten+enhance it, return a PDF."""

    original_name = file.filename or "photo.jpg"
    ext = Path(original_name).suffix.lower()

    if ext not in SCAN_EXTENSIONS:
        return Response(
            content=f"Unsupported photo type: {ext or 'unknown'} "
                    f"(use {', '.join(sorted(SCAN_EXTENSIONS))})",
            status_code=400,
            media_type="text/plain",
        )

    if mode not in SCAN_MODES:
        return Response(
            content=f"Unknown mode: {mode} (use color, gray, or bw)",
            status_code=400,
            media_type="text/plain",
        )

    contents = file.file.read()
    if len(contents) > SCAN_MAX_BYTES:
        return Response(
            content=f"File too large: max {SCAN_MAX_BYTES // (1024 * 1024)} MB",
            status_code=413,
            media_type="text/plain",
        )

    try:
        pdf_bytes, detected = scan_photo_to_pdf(contents, mode)

        stem = Path(original_name).stem
        return Response(
            content=pdf_bytes,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{stem}.scanned.pdf"',
                # Tells the frontend whether page edges were actually found
                # or the whole photo was used as-is.
                "X-Scan-Detected": "true" if detected else "false",
            },
        )

    except Exception as exc:
        return Response(
            content=f"Scan failed: {str(exc)}",
            status_code=500,
            media_type="text/plain",
        )