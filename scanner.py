"""Photo scanner — the classic OpenCV document-scanning pipeline.

Turns a photo of a document (taken at an angle, on a desk, whatever)
into a clean, flat, single-page PDF. Four stages:

    1. DETECT   find the page's four corners in the photo
    2. WARP     perspective-transform so the page fills the frame
    3. ENHANCE  color boost, grayscale, or crisp black & white
    4. EXPORT   wrap the result in a one-page PDF

Every stage is a small function so each trick is readable on its own.
"""

import cv2
import fitz  # PyMuPDF — used here to build the output PDF
import numpy as np

# Detection runs on a copy downscaled to this max dimension (px).
# Edge detection doesn't need megapixels — smaller is faster AND more robust.
DETECT_MAX_DIM = 1000

# The warped output is capped at this max dimension (px) to keep
# memory and PDF size sane on a 512 MB server.
OUTPUT_MAX_DIM = 2400

# A candidate quad must cover at least this fraction of the photo,
# otherwise it's probably a sticker/window/phone, not the page.
MIN_PAGE_AREA_FRACTION = 0.2


# ---------------------------------------------------------------------------
# Stage 1 — DETECT: find the page's four corners
# ---------------------------------------------------------------------------
def find_page_corners(img: np.ndarray) -> np.ndarray | None:
    """Return the page's 4 corners in full-image coordinates, or None."""
    h, w = img.shape[:2]
    scale = min(1.0, DETECT_MAX_DIM / max(h, w))
    small = cv2.resize(img, None, fx=scale, fy=scale) if scale < 1.0 else img

    # Classic recipe: grayscale -> blur (kill noise) -> Canny (find edges)
    # -> dilate (bridge small gaps so the page outline closes into a loop).
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (5, 5), 0)
    edges = cv2.Canny(gray, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)

    contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    min_area = MIN_PAGE_AREA_FRACTION * small.shape[0] * small.shape[1]

    # Walk the biggest contours first; keep the first one that simplifies
    # to exactly 4 corners and is big enough to plausibly be the page.
    for contour in sorted(contours, key=cv2.contourArea, reverse=True)[:5]:
        perimeter = cv2.arcLength(contour, True)
        approx = cv2.approxPolyDP(contour, 0.02 * perimeter, True)
        if len(approx) == 4 and cv2.contourArea(approx) >= min_area:
            corners = approx.reshape(4, 2).astype(np.float32)
            return corners / scale  # map back to full-resolution coords

    return None  # no page found — caller falls back to the full photo


def order_corners(pts: np.ndarray) -> np.ndarray:
    """Order 4 corners as top-left, top-right, bottom-right, bottom-left.

    Trick: the top-left corner has the smallest x+y sum, bottom-right the
    largest; the top-right has the smallest y-x difference, bottom-left
    the largest. Works for any rotation the detector hands us.
    """
    sums = pts.sum(axis=1)
    diffs = np.diff(pts, axis=1).ravel()
    return np.array(
        [
            pts[np.argmin(sums)],   # top-left
            pts[np.argmin(diffs)],  # top-right
            pts[np.argmax(sums)],   # bottom-right
            pts[np.argmax(diffs)],  # bottom-left
        ],
        dtype=np.float32,
    )


# ---------------------------------------------------------------------------
# Stage 2 — WARP: perspective-correct the page to a flat rectangle
# ---------------------------------------------------------------------------
def warp_page(img: np.ndarray, corners: np.ndarray) -> np.ndarray:
    tl, tr, br, bl = order_corners(corners)

    # Output size = the longer of each opposing edge pair, so nothing squishes.
    out_w = int(max(np.linalg.norm(br - bl), np.linalg.norm(tr - tl)))
    out_h = int(max(np.linalg.norm(tr - br), np.linalg.norm(tl - bl)))

    src = np.array([tl, tr, br, bl], dtype=np.float32)
    dst = np.array(
        [[0, 0], [out_w - 1, 0], [out_w - 1, out_h - 1], [0, out_h - 1]],
        dtype=np.float32,
    )
    matrix = cv2.getPerspectiveTransform(src, dst)
    return cv2.warpPerspective(img, matrix, (out_w, out_h))


# ---------------------------------------------------------------------------
# Stage 3 — ENHANCE: make it look scanned, not photographed
# ---------------------------------------------------------------------------
def enhance(img: np.ndarray, mode: str) -> np.ndarray:
    if mode == "bw":
        # The "photocopier" look: adaptive threshold decides black-or-white
        # per neighborhood, which flattens uneven lighting beautifully.
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        gray = cv2.medianBlur(gray, 3)
        return cv2.adaptiveThreshold(
            gray, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 25, 15
        )

    if mode == "gray":
        # Grayscale + CLAHE (local contrast boost) — good for pencil/receipts.
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
        return clahe.apply(gray)

    # "color" (default): CLAHE on lightness only, so colors don't shift.
    lab = cv2.cvtColor(img, cv2.COLOR_BGR2LAB)
    l_channel, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    lab = cv2.merge((clahe.apply(l_channel), a, b))
    return cv2.cvtColor(lab, cv2.COLOR_LAB2BGR)


# ---------------------------------------------------------------------------
# Stage 4 — EXPORT: encode an enhanced image and add it as one PDF page
# ---------------------------------------------------------------------------
def _insert_image_page(doc: "fitz.Document", img: np.ndarray, mode: str) -> None:
    """Encode `img` and append it to `doc` as a new page."""
    h, w = img.shape[:2]

    # Pure black & white compresses far better as PNG; photographic
    # content (color AND grayscale) is much smaller as JPEG.
    if mode == "bw":
        ok, encoded = cv2.imencode(".png", img)
    else:
        ok, encoded = cv2.imencode(".jpg", img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    if not ok:
        raise RuntimeError("could not encode the scanned image")

    # Page size in PDF points (1/72"), assuming the scan is ~200 DPI.
    page_w, page_h = w * 72 / 200, h * 72 / 200
    page = doc.new_page(width=page_w, height=page_h)
    page.insert_image(page.rect, stream=encoded.tobytes())


def image_to_pdf_bytes(img: np.ndarray, mode: str) -> bytes:
    """Wrap a single enhanced image in a one-page PDF."""
    doc = fitz.open()
    try:
        _insert_image_page(doc, img, mode)
        return doc.tobytes()
    finally:
        doc.close()


# ---------------------------------------------------------------------------
# Per-image pipeline: photo bytes -> enhanced, flattened image
# ---------------------------------------------------------------------------
def scan_photo_to_image(photo_bytes: bytes, mode: str = "color") -> tuple[np.ndarray, bool]:
    """Decode -> detect -> warp -> cap -> enhance. Returns (image, detected)."""
    img = cv2.imdecode(np.frombuffer(photo_bytes, np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("could not decode the image — is it a valid photo?")

    corners = find_page_corners(img)
    detected = corners is not None
    page = warp_page(img, corners) if detected else img

    # Cap resolution AFTER the warp so detection had full detail to work with.
    h, w = page.shape[:2]
    if max(h, w) > OUTPUT_MAX_DIM:
        f = OUTPUT_MAX_DIM / max(h, w)
        page = cv2.resize(page, None, fx=f, fy=f, interpolation=cv2.INTER_AREA)

    return enhance(page, mode), detected


# ---------------------------------------------------------------------------
# The full pipeline — one or many photos into a single PDF
# ---------------------------------------------------------------------------
def scan_photos_to_pdf(
    photos: list[bytes], mode: str = "color"
) -> tuple[bytes, int]:
    """Scan each photo and combine them into one multi-page PDF.

    Returns (pdf_bytes, detected_count) where detected_count is how many
    pages had their edges auto-detected (the rest used the full photo).
    Images are processed one at a time to keep peak memory low.
    """
    if not photos:
        raise ValueError("no photos to scan")

    doc = fitz.open()
    try:
        detected_count = 0
        for photo_bytes in photos:
            img, detected = scan_photo_to_image(photo_bytes, mode)
            detected_count += int(detected)
            _insert_image_page(doc, img, mode)
            del img  # free before decoding the next page
        return doc.tobytes(), detected_count
    finally:
        doc.close()


def scan_photo_to_pdf(photo_bytes: bytes, mode: str = "color") -> tuple[bytes, bool]:
    """Single-photo convenience wrapper. Returns (pdf_bytes, detected)."""
    pdf_bytes, detected_count = scan_photos_to_pdf([photo_bytes], mode)
    return pdf_bytes, detected_count > 0
