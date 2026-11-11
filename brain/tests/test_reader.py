import pytest
from fastapi.testclient import TestClient

from magpie_reader import web
from magpie_reader.files import UnreadableFile, read_file, title_of
from magpie_reader.main import create_app
from magpie_reader.web import UnsafeUrl, check_public_url, clean_markdown

KEY = "reader-key-for-the-tests-only"
AUTH = {"authorization": f"Bearer {KEY}"}


async def public(url):
    return url


def client(crawl=None, read=None, check=public):
    async def no_crawl(url, max_pages):
        return []

    async def no_read(name, data):
        raise UnreadableFile("No text was found in this file.")

    return TestClient(create_app(KEY, crawl or no_crawl, read or no_read, check))


@pytest.mark.parametrize(
    "url",
    ["http://127.0.0.1/", "http://localhost:8800/", "http://10.0.0.5/", "http://169.254.169.254/latest", "ftp://example.com/", "https://example.com:5432/"],
)
async def test_private_and_odd_addresses_are_refused(url):
    with pytest.raises(UnsafeUrl):
        await check_public_url(url)


def resolving_to(monkeypatch, address):
    class Loop:
        async def getaddrinfo(self, host, port, **kwargs):
            return [(2, 1, 6, "", (address, port))]

    monkeypatch.setattr(web.asyncio, "get_running_loop", lambda: Loop())


async def test_a_name_that_points_inside_is_refused(monkeypatch):
    resolving_to(monkeypatch, "172.18.0.4")
    with pytest.raises(UnsafeUrl):
        await check_public_url("https://brain.example.com/")


async def test_a_public_name_is_allowed(monkeypatch):
    resolving_to(monkeypatch, "93.184.215.14")
    assert await check_public_url("https://shop.example.com/help") == "https://shop.example.com/help"


def test_the_key_is_required():
    assert client().post("/read/website", json={"url": "https://example.com"}).status_code == 401
    assert client().get("/healthz").json() == {"status": "healthy"}


def test_a_website_comes_back_as_pages():
    seen = {}

    async def crawl(url, max_pages):
        seen.update(url=url, max_pages=max_pages)
        return [{"url": url, "title": "Shipping", "markdown": "We ship to Canada."}]

    response = client(crawl=crawl).post("/read/website", json={"url": "https://shop.example.com", "max_pages": 20}, headers=AUTH)
    assert response.json() == {"pages": [{"url": "https://shop.example.com", "title": "Shipping", "markdown": "We ship to Canada."}]}
    assert seen == {"url": "https://shop.example.com", "max_pages": 20}


def test_problems_the_team_can_fix_are_422_with_a_message():
    async def refuse(url):
        raise UnsafeUrl("That address isn't a public website.")

    refused = client(check=refuse).post("/read/website", json={"url": "http://10.0.0.1"}, headers=AUTH)
    assert refused.status_code == 422 and refused.json()["detail"] == "That address isn't a public website."
    empty = client().post("/read/website", json={"url": "https://example.com"}, headers=AUTH)
    assert empty.status_code == 422 and "No pages" in empty.json()["detail"]
    unreadable = client().post("/read/file", files={"file": ("scan.pdf", b"%PDF")}, headers=AUTH)
    assert unreadable.status_code == 422 and unreadable.json()["detail"] == "No text was found in this file."


def test_a_file_over_20_mb_is_refused():
    response = client().post("/read/file", files={"file": ("big.txt", b"x" * (20 * 1024 * 1024 + 1))}, headers=AUTH)
    assert response.status_code == 422 and response.json()["detail"] == "Files can be up to 20 MB."


async def test_text_and_markdown_files_are_read_as_they_are():
    [page] = await read_file("Returns.md", b"# Returns policy\n\nReturns within 30 days.")
    assert page == {"url": None, "title": "Returns policy", "markdown": "# Returns policy\n\nReturns within 30 days."}
    with pytest.raises(UnreadableFile):
        await read_file("empty.txt", b"   ")
    with pytest.raises(UnreadableFile):
        await read_file("app.exe", b"MZ")


def test_titles_and_cleaning():
    assert title_of("no heading here", "Gift cards.pdf") == "Gift cards"
    assert clean_markdown("<!-- image -->\n\n\n\nText") == "Text"


def test_a_short_filtered_page_falls_back_to_the_full_text():
    class Markdown:
        fit_markdown = "Menu"
        raw_markdown = "Menu\n\nWe ship to Canada in five days, every day of the week, with tracking on every order."

    class Result:
        markdown = Markdown()

    assert web.page_text(Result()).startswith("Menu\n\nWe ship to Canada")
