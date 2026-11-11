"""Websites: checks an address is a public one, then crawls it with Crawl4AI over plain HTTP (no browser).

The crawl stays on the site's own domain, keeps to HTML pages, respects robots.txt and stops at max_pages.
"""

from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
from typing import Any
from urllib.parse import urlsplit

# Below this much text a filtered page is mostly menus, so the unfiltered text is used instead.
FIT_MIN_CHARS = 200
MAX_DEPTH = 3


class UnsafeUrl(ValueError):
    """An address Magpie won't read: not http(s), or not on the public internet."""


async def check_public_url(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise UnsafeUrl("Enter a website address that starts with https://")
    if parts.port not in (None, 80, 443):
        raise UnsafeUrl("Use a website on the normal web ports.")
    try:
        found = await asyncio.get_running_loop().getaddrinfo(parts.hostname, parts.port or 443, type=socket.SOCK_STREAM)
    except socket.gaierror as error:
        raise UnsafeUrl("That website couldn't be found.") from error
    addresses = {ipaddress.ip_address(row[4][0]) for row in found}
    if not addresses or not all(address.is_global for address in addresses):
        raise UnsafeUrl("That address isn't a public website.")
    return url


def clean_markdown(text: str) -> str:
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def page_text(result: Any) -> str:
    markdown = result.markdown
    fit = (getattr(markdown, "fit_markdown", None) or "").strip()
    raw = (getattr(markdown, "raw_markdown", None) or "").strip()
    return clean_markdown(fit if len(fit) >= FIT_MIN_CHARS else raw)


async def crawl_website(url: str, max_pages: int) -> list[dict[str, Any]]:
    from crawl4ai import AsyncWebCrawler, CacheMode, CrawlerRunConfig, HTTPCrawlerConfig
    from crawl4ai.async_crawler_strategy import AsyncHTTPCrawlerStrategy
    from crawl4ai.content_filter_strategy import PruningContentFilterLXML
    from crawl4ai.deep_crawling import BFSDeepCrawlStrategy
    from crawl4ai.deep_crawling.filters import ContentTypeFilter, FilterChain
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    config = CrawlerRunConfig(
        deep_crawl_strategy=BFSDeepCrawlStrategy(
            max_depth=MAX_DEPTH,
            max_pages=max_pages,
            include_external=False,
            filter_chain=FilterChain([ContentTypeFilter(allowed_types=["text/html"])]),
        ),
        markdown_generator=DefaultMarkdownGenerator(content_filter=PruningContentFilterLXML(), options={"ignore_links": True, "ignore_images": True}),
        cache_mode=CacheMode.BYPASS,
        check_robots_txt=True,
        page_timeout=30_000,
        verbose=False,
    )
    async with AsyncWebCrawler(crawler_strategy=AsyncHTTPCrawlerStrategy(browser_config=HTTPCrawlerConfig())) as crawler:
        results = await crawler.arun(url, config=config)

    pages: list[dict[str, Any]] = []
    seen: set[str] = set()
    for result in results:
        address = result.url.split("#")[0]
        if address in seen or not result.success or (result.status_code or 0) >= 400:
            continue
        seen.add(address)
        text = page_text(result)
        if text:
            pages.append({"url": address, "title": ((result.metadata or {}).get("title") or address).strip(), "markdown": text})
    return pages
