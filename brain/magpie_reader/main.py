"""Starts the reader: websites and files in, plain pages out, for Magpie's knowledge. Only the agent's worker calls
it, on its own Docker network, with READER_API_KEY. It runs apart from the brain so a heavy file can't slow down
replies to customers.

Routes (all need "Authorization: Bearer <READER_API_KEY>" except health):
- GET  /healthz
- POST /read/website   {"url", "max_pages"}  ->  {"pages": [{"url", "title", "markdown"}]}
- POST /read/file      multipart "file"      ->  {"pages": [{"url": null, "title", "markdown"}]}
A 422 carries a message the team can act on ("That website couldn't be found.").
"""

from __future__ import annotations

import hmac
import os
from typing import Any, Awaitable, Callable

import uvicorn
from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field

from .files import UnreadableFile, read_file
from .web import UnsafeUrl, check_public_url, crawl_website

MAX_FILE_BYTES = 20 * 1024 * 1024

Crawl = Callable[[str, int], Awaitable[list[dict[str, Any]]]]
Read = Callable[[str, bytes], Awaitable[list[dict[str, Any]]]]
Check = Callable[[str], Awaitable[str]]


class WebsiteBody(BaseModel):
    url: str = Field(min_length=1, max_length=2000)
    max_pages: int = Field(default=50, ge=1, le=100)


def create_app(api_key: str, crawl: Crawl = crawl_website, read: Read = read_file, check: Check = check_public_url) -> FastAPI:
    api = FastAPI(title="Magpie reader")

    def require_key(authorization: str = Header(default="")) -> None:
        if not hmac.compare_digest(authorization, f"Bearer {api_key}"):
            raise HTTPException(status_code=401, detail="unauthorized")

    @api.get("/healthz")
    async def healthz() -> dict[str, str]:
        return {"status": "healthy"}

    @api.post("/read/website", dependencies=[Depends(require_key)])
    async def read_website(body: WebsiteBody) -> dict[str, Any]:
        try:
            url = await check(body.url)
        except UnsafeUrl as error:
            raise HTTPException(status_code=422, detail=str(error)) from error
        try:
            pages = await crawl(url, body.max_pages)
        except OSError as error:
            raise HTTPException(status_code=422, detail="That website couldn't be reached.") from error
        if not pages:
            raise HTTPException(status_code=422, detail="No pages with text were found. Check the address, or that the site allows crawling.")
        return {"pages": pages}

    @api.post("/read/file", dependencies=[Depends(require_key)])
    async def read_upload(file: UploadFile = File(...)) -> dict[str, Any]:
        data = await file.read(MAX_FILE_BYTES + 1)
        if len(data) > MAX_FILE_BYTES:
            raise HTTPException(status_code=422, detail="Files can be up to 20 MB.")
        try:
            return {"pages": await read(file.filename or "file", data)}
        except UnreadableFile as error:
            raise HTTPException(status_code=422, detail=str(error)) from error

    return api


if __name__ == "__main__":
    key = os.environ.get("READER_API_KEY", "")
    if len(key) < 20:
        raise RuntimeError("READER_API_KEY is required (20 characters or more)")
    print("[reader] ready", flush=True)
    uvicorn.run(create_app(key), host="0.0.0.0", port=int(os.environ.get("PORT", "8810")), log_level="warning")
