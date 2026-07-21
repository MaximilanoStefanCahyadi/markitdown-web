# MarkItDown Toolbox — Docker image for Render
#
# Why Docker? The OCR feature needs the Tesseract *binary*, which pip can't
# install. Render's native Python runtime can't apt-get, so we build our own
# image with Tesseract baked in.

FROM python:3.12-slim

# System dependency: Tesseract OCR engine + English language data
RUN apt-get update \
    && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install Python deps first so Docker caches this layer between code changes
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy the application code
COPY . .

ENV PORT=8000
EXPOSE 8000

# Shell form so Render's $PORT env var expands at runtime
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT}
