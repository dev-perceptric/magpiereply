"""Files: plain text and Markdown are read as they are; PDF, Word, PowerPoint, Excel and HTML go through Docling.

Docling runs in a fresh process for each file, one file at a time, so the memory a long PDF takes is given back as
soon as it's done. No OCR: scanned pages without a text layer come back empty.
"""

from __future__ import annotations

import asyncio
import os
import re
import tempfile
from multiprocessing import get_context
from pathlib import Path

from .web import clean_markdown

MAX_PAGES = 300
MAX_CHARS = 400_000
CONVERT_TIMEOUT_SECONDS = 600
TEXT_EXTENSIONS = {".md", ".txt"}
DOCLING_EXTENSIONS = {".pdf", ".docx", ".pptx", ".xlsx", ".html", ".htm"}
# Docling's models, downloaded into the image at build time (Dockerfile.reader).
MODELS_DIR = os.environ.get("DOCLING_MODELS", "/opt/docling-models")

_one_at_a_time = asyncio.Semaphore(1)


class UnreadableFile(ValueError):
    """A file the team needs to replace: wrong type, empty or broken."""


def title_of(markdown: str, file_name: str) -> str:
    heading = re.search(r"^#{1,3}\s+(.+)$", markdown, flags=re.MULTILINE)
    return heading.group(1).strip() if heading else Path(file_name).stem


def _convert(path: str) -> str:
    """Runs in a child process."""
    from docling.datamodel.accelerator_options import AcceleratorOptions
    from docling.datamodel.base_models import InputFormat
    from docling.datamodel.pipeline_options import ThreadedPdfPipelineOptions
    from docling.datamodel.settings import settings
    from docling.document_converter import DocumentConverter, PdfFormatOption

    # Small batches keep a long PDF to about 1.7 GB.
    settings.perf.page_batch_size = 1
    options = ThreadedPdfPipelineOptions(
        artifacts_path=MODELS_DIR,
        do_ocr=False,
        do_table_structure=True,
        layout_batch_size=1,
        table_batch_size=1,
        ocr_batch_size=1,
        queue_max_size=4,
        document_timeout=CONVERT_TIMEOUT_SECONDS,
        accelerator_options=AcceleratorOptions(num_threads=2, device="cpu"),
    )
    converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=options)})
    result = converter.convert(path, max_num_pages=MAX_PAGES, raises_on_error=False)
    if result.document is None:
        return ""
    return result.document.export_to_markdown()


def _child(path: str, connection) -> None:
    connection.send(_convert(path))
    connection.close()


def _convert_in_child(path: str) -> str:
    """Converts in a fresh process and waits for it. A crash or an out-of-memory kill comes back as UnreadableFile."""
    context = get_context("spawn")
    receiver, sender = context.Pipe(duplex=False)
    process = context.Process(target=_child, args=(path, sender), daemon=True)
    process.start()
    sender.close()
    try:
        if not receiver.poll(CONVERT_TIMEOUT_SECONDS + 60):
            raise UnreadableFile("This file took too long to read.")
        return receiver.recv()
    except EOFError as error:
        raise UnreadableFile("This file couldn't be read.") from error
    finally:
        if process.is_alive():
            process.kill()
        process.join()
        receiver.close()


async def read_file(file_name: str, data: bytes) -> list[dict[str, str | None]]:
    extension = Path(file_name).suffix.lower()
    if extension in TEXT_EXTENSIONS:
        markdown = data.decode("utf-8", errors="replace")
    elif extension in DOCLING_EXTENSIONS:
        async with _one_at_a_time:
            with tempfile.TemporaryDirectory() as folder:
                path = Path(folder) / f"upload{extension}"
                path.write_bytes(data)
                markdown = await asyncio.to_thread(_convert_in_child, str(path))
    else:
        raise UnreadableFile("Use a PDF, Word, PowerPoint, Excel, HTML, Markdown or text file.")

    markdown = clean_markdown(markdown)[:MAX_CHARS]
    if not markdown:
        raise UnreadableFile("No text was found in this file.")
    return [{"url": None, "title": title_of(markdown, file_name), "markdown": markdown}]
