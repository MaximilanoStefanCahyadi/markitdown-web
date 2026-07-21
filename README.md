# MarkItDown Toolbox

A small FastAPI web app that puts three document tools on one tabbed page: convert almost any file to Markdown, edit and sign PDFs entirely in your browser, and pull text out of scanned PDFs with OCR. It is also a compact lesson in how real document tooling works — where the browser is enough, where you need a server, and where you need a whole Docker container.

## Features

- **Convert to Markdown** — upload a PDF, DOCX, PPTX, XLSX, HTML, CSV, JSON, image, and more; the server runs it through [Microsoft's MarkItDown](https://github.com/microsoft/markitdown) library and hands back a `.md` file download.
- **PDF Editor** — add text boxes, whiteout rectangles, and a hand-drawn signature to any PDF. 100% client-side: your PDF never leaves your machine. Rendered with PDF.js, edited on an overlay, exported with pdf-lib.
- **OCR Scanner** — upload a scanned PDF (up to 20 MB / 20 pages); the server renders each page to an image with PyMuPDF and extracts text with Tesseract, returning Markdown you can copy or download.

## Architecture at a glance

Two of the three tools talk to the server. The PDF editor never does — that's the interesting part.

```mermaid
flowchart LR
    subgraph Browser
        T[Tabbed UI<br/>tabs.js]
        C[Convert tab<br/>app.js]
        E[PDF Editor tab<br/>pdf-editor.js<br/>PDF.js + pdf-lib + signature_pad<br/><b>never calls the server</b>]
        O[OCR tab<br/>ocr.js]
    end

    subgraph Docker container
        subgraph FastAPI server — main.py
            CV["POST /convert"]
            OC["POST /ocr"]
        end
        MID[MarkItDown library]
        PMP[PyMuPDF<br/>page → PNG]
        TESS[Tesseract binary<br/>installed via apt-get]
    end

    C -- "multipart upload" --> CV
    CV --> MID
    O -- "multipart upload" --> OC
    OC --> PMP --> TESS
```

Why Docker around the whole server? Tesseract is a compiled system program, not a Python package — more on that in the lesson below.

## How it works — a lesson

### 1. Why you can't truly edit PDF text

A PDF is not a word processor document. It doesn't store paragraphs; it stores drawing instructions: "place these glyphs at these exact coordinates in this font." There's no concept of "the sentence continues here" — so there's nothing to reflow when you change a word. That's why the editor doesn't even try.

Instead it does what many commercial PDF tools quietly do too: **cover and replace**. You drag a white **Whiteout** rectangle over the old text, then click **Add Text** to type the replacement on top. At export time, `pdf-editor.js` uses pdf-lib to draw the white rectangle and the new text as *new* drawing instructions layered over the originals. The old text is hidden, not removed (keep that in mind for anything sensitive — it's still in the file).

### 2. The coordinate-system gotcha

The editor juggles two coordinate systems that disagree about almost everything:

| | Canvas (browser) | PDF |
|---|---|---|
| Origin | **top**-left | **bottom**-left |
| Y grows | downward | upward |
| Units | CSS pixels (at a render `scale`) | points (1/72 inch) |

Every edit is stored in canvas pixels while you work, then converted exactly once at export. All the conversion lives in one tiny helper in `static/js/pdf-editor.js`:

```js
/**
 * Canvas px (top-left origin, y down) -> PDF points (bottom-left origin, y up).
 */
function toPdfCoords(xPx, yPx, page, scale) {
    const { height } = page.getSize(); // points
    return { x: xPx / scale, y: height - yPx / scale };
}
```

Two things happen here:

- **Scale division** (`xPx / scale`): PDF.js rendered the page zoomed by `scale` to fit your screen, so pixel measurements are `scale` times too big. Dividing converts pixels back to PDF points.
- **The y-flip** (`height - yPx / scale`): a point 50px from the *top* of the canvas is `pageHeight - 50/scale` points from the *bottom* of the PDF page. Subtracting from the page height flips the axis.

Keeping this in exactly one function is the design lesson: if placement is ever off, there's one place to look. (One extra wrinkle: pdf-lib anchors rectangles and images at their *bottom*-left corner, so the export code also shifts `y` down by the element's height.)

### 3. Why OCR forces Docker

`pip install` can only install Python packages. Tesseract is a compiled C++ program that lives in your operating system, not in your Python environment — `pytesseract` (in `requirements.txt`) is just a thin wrapper that shells out to the `tesseract` binary and fails if it isn't there.

On Render's native Python runtime you can't run `apt-get` to install system programs. So the project ships a `Dockerfile` that builds its own miniature operating system with Tesseract baked in:

```dockerfile
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*
```

Memory shapes the rest of the design. Render's free tier gives you **512 MB of RAM**, and rendering PDF pages to images is memory-hungry. So `main.py` defines three constants at the top of its OCR section:

```python
OCR_MAX_BYTES = 20 * 1024 * 1024   # 20 MB upload limit
OCR_MAX_PAGES = 20
OCR_DPI = 150                      # 150 DPI is plenty for Tesseract
```

The OCR loop processes **one page at a time** and deletes each image before rendering the next, so peak memory stays at roughly one page regardless of document length. 150 DPI is a deliberate compromise: sharp enough for Tesseract, a quarter of the memory of 300 DPI. On a bigger machine, bump these constants.

One more detail worth stealing: the `/ocr` route is a plain `def`, not `async def` — on purpose. FastAPI runs sync routes in a worker thread, so the CPU-heavy OCR work never blocks the event loop that serves everyone else.

## Run it locally

You need Python 3.10+.

```bash
# 1. Create and activate a virtual environment
python -m venv .venv

# Windows (PowerShell):
.venv\Scripts\Activate.ps1
# macOS / Linux:
source .venv/bin/activate

# 2. Install dependencies
pip install -r requirements.txt

# 3. Start the dev server (auto-reloads on code changes)
uvicorn main:app --reload
```

Open <http://127.0.0.1:8000>. The Convert and PDF Editor tabs work immediately.

**The OCR tab needs the Tesseract binary installed on your machine** (pip can't do it — see the lesson above). On Windows, use the [UB Mannheim installer](https://github.com/UB-Mannheim/tesseract/wiki); on macOS `brew install tesseract`; on Debian/Ubuntu `sudo apt-get install tesseract-ocr`. Or skip the local install and test OCR through Docker instead.

## Run with Docker

This is the closest match to what runs in production — Tesseract is already inside the image.

```bash
docker build -t markitdown-toolbox .
docker run --rm -p 8000:8000 -m 512m markitdown-toolbox
```

Open <http://127.0.0.1:8000>.

The `-m 512m` flag caps the container at 512 MB of RAM — the same limit as Render's free tier. Run with it before you deploy: if a big scanned PDF is going to blow the memory budget, better to find out on your laptop than in production.

## Deploy to Render (first-timer walkthrough)

The repo contains a `render.yaml` Blueprint, so Render can set everything up from the file — no manual configuration.

1. Push the repo to GitHub (public or private).
2. Sign in at [dashboard.render.com](https://dashboard.render.com).
3. Click **New → Blueprint**.
4. Connect your GitHub account and pick this repository.
5. Render reads `render.yaml`, sees `runtime: docker`, and builds the image from the `Dockerfile` (including the Tesseract `apt-get` step). Click through to approve and deploy.
6. Wait for the first build to finish — building the image takes a few minutes.
7. Open the `https://<your-service>.onrender.com` URL Render gives you.

Because `autoDeploy: true` is set, every push to your default branch triggers a fresh deploy automatically.

**Free-tier caveats:**

- The service **sleeps after ~15 minutes of inactivity**; the next visitor waits up to a minute for a cold start. Normal, not broken.
- **512 MB RAM** — which is exactly why the OCR limits exist.

## Project structure

```text
markitdown/
├── main.py               # FastAPI app: serves the page, POST /convert, POST /ocr
├── requirements.txt      # Python deps: fastapi, markitdown, PyMuPDF, pytesseract, Pillow
├── Dockerfile            # python:3.12-slim + apt-get tesseract-ocr + pip install
├── render.yaml           # Render Blueprint: docker runtime, free plan, auto-deploy
├── templates/
│   └── index.html        # The single page: hero, tab bar, all three tool panels
└── static/
    ├── css/style.css     # All styling
    ├── js/
    │   ├── tabs.js       # Tab switching (toggles panels + aria attributes)
    │   ├── app.js        # Convert tab: drag & drop, POST /convert, download, toasts
    │   ├── pdf-editor.js # PDF Editor: render, overlay edits, toPdfCoords(), export
    │   └── ocr.js        # OCR tab: upload, POST /ocr, show/copy/download result
    └── vendor/           # Vendored libraries — no CDN at runtime
        ├── pdfjs/        # pdf.min.js + pdf.worker.min.js (rendering)
        ├── pdf-lib.min.js        # PDF export
        └── signature_pad.umd.min.js  # Signature drawing
```

## Limits & ideas to extend

- **OCR is English-only.** Add languages by installing more Tesseract data packs in the `Dockerfile` (e.g. `tesseract-ocr-deu` for German) and passing `lang="deu"` to `pytesseract.image_to_string()`.
- **OCR outputs Markdown text, not a searchable PDF.** [ocrmypdf](https://ocrmypdf.readthedocs.io/) adds an invisible text layer to the original PDF instead — a natural fourth tab.
- **Text boxes can't be dragged after placement.** Signatures already can — the `makeMovable()` helper in `pdf-editor.js` exists; wiring it up to text edits is a nice first contribution.
- **Whiteout hides text, it doesn't remove it.** True redaction means rewriting the PDF content streams — a much deeper feature.
- **Raise the OCR limits** (`OCR_MAX_BYTES`, `OCR_MAX_PAGES`, `OCR_DPI` in `main.py`) if you deploy on a machine with more than 512 MB of RAM.

## Credits

Built on the shoulders of:

- [Microsoft MarkItDown](https://github.com/microsoft/markitdown) — document-to-Markdown conversion
- [PDF.js](https://mozilla.github.io/pdf.js/) — PDF rendering in the browser
- [pdf-lib](https://pdf-lib.js.org) — PDF editing/export in the browser
- [signature_pad](https://github.com/szimek/signature_pad) — smooth signature drawing
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) — the OCR engine
- [PyMuPDF](https://pymupdf.readthedocs.io/) — fast PDF-to-image rendering in Python
