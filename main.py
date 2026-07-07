import os
import tempfile
from pathlib import Path

from fastapi import FastAPI, File, UploadFile
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles
from markitdown import MarkItDown

app = FastAPI(title="MarkItDown", description="Convert documents to Markdown")

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