#!/usr/bin/env python3
"""Sanity checks for the First In static site. Standard library only.

Run from anywhere:  python3 tools/check_site.py
Exits non-zero if anything fails.

Checks
  - every local href/src/srcset target exists (folders resolve to index.html)
  - #fragment links point at an id that exists on the target page
  - url(...) references in the stylesheet exist
  - HTML is well formed (balanced tags, no duplicate ids)
  - every <img> has alt, width and height
  - every image used is listed in assets/img/credits.json and on the credits page
  - content rules: footer disclaimer on every page, no "Ping", no channel or
    bot links on the home / coming-soon pages, rel="noopener" on target=_blank
"""
import json
import os
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VOID = {"area", "base", "br", "col", "embed", "hr", "img", "input", "link",
        "meta", "source", "track", "wbr"}
DISCLAIMER = "Not affiliated with FIXR or any venue."

problems = []


def fail(msg):
    problems.append(msg)


class Page(HTMLParser):
    def __init__(self, path):
        super().__init__(convert_charrefs=True)
        self.path = path
        self.stack = []
        self.ids = []
        self.refs = []      # (attr, value, line)
        self.imgs = []      # (attrs, line)
        self.blank = []     # (attrs, line)
        self.text = []

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        line = self.getpos()[0]
        if tag not in VOID:
            self.stack.append((tag, line))
        if "id" in a:
            self.ids.append(a["id"])
        for key in ("href", "src"):
            if a.get(key):
                self.refs.append((key, a[key], line))
        if a.get("srcset"):
            for part in a["srcset"].split(","):
                url = part.strip().split(" ")[0]
                if url:
                    self.refs.append(("srcset", url, line))
        if tag == "img":
            self.imgs.append((a, line))
        if a.get("target") == "_blank":
            self.blank.append((a, line))

    def handle_startendtag(self, tag, attrs):
        # <x /> style: fine for void elements and inside inline SVG, an error otherwise
        if any(t == "svg" for t, _ in self.stack):
            return
        if tag not in VOID:
            fail(f"{rel(self.path)}:{self.getpos()[0]} self-closed non-void <{tag}/>")
            return
        self.handle_starttag(tag, attrs)

    def handle_endtag(self, tag):
        line = self.getpos()[0]
        if tag in VOID:
            fail(f"{rel(self.path)}:{line} end tag for void element </{tag}>")
            return
        if not self.stack:
            fail(f"{rel(self.path)}:{line} stray </{tag}>")
            return
        open_tag, open_line = self.stack.pop()
        if open_tag != tag:
            fail(f"{rel(self.path)}:{line} </{tag}> closes <{open_tag}> opened on line {open_line}")

    def handle_data(self, data):
        self.text.append(data)


def rel(p):
    return os.path.relpath(p, ROOT)


def html_files():
    out = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d != "tools"]
        for f in filenames:
            if f.endswith(".html"):
                out.append(os.path.join(dirpath, f))
    return sorted(out)


def resolve(page_path, url):
    """Return (filesystem path, fragment) for a local URL, or None if external."""
    parts = urlsplit(url)
    if parts.scheme or url.startswith("//"):
        return None
    if url.startswith("/"):
        fail(f"{rel(page_path)} uses a root-absolute path {url!r} (breaks on a GitHub project site)")
        return None
    # GitHub Pages serves 404.html at arbitrary URLs and it sets <base> to the site root.
    base_dir = ROOT if os.path.basename(page_path) == "404.html" else os.path.dirname(page_path)
    path = unquote(parts.path)
    target = os.path.normpath(os.path.join(base_dir, path)) if path else page_path
    if path.endswith("/") or (path and os.path.isdir(target)):
        target = os.path.join(target, "index.html")
    return target, parts.fragment


def main():
    pages = {}
    for path in html_files():
        p = Page(path)
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
        p.feed(src)
        p.close()
        p.source = src
        for tag, line in p.stack:
            fail(f"{rel(path)}:{line} <{tag}> never closed")
        dupes = {i for i in p.ids if p.ids.count(i) > 1}
        if dupes:
            fail(f"{rel(path)} duplicate ids: {sorted(dupes)}")
        if not src.lower().startswith("<!doctype html>"):
            fail(f"{rel(path)} missing <!doctype html>")
        pages[path] = p

    used_images = set()
    for path, p in pages.items():
        for attr, url, line in p.refs:
            r = resolve(path, url)
            if r is None:
                continue
            target, frag = r
            if not os.path.exists(target):
                fail(f"{rel(path)}:{line} {attr}={url!r} -> missing {rel(target)}")
                continue
            if frag:
                tp = pages.get(target)
                if tp is None or frag not in tp.ids:
                    fail(f"{rel(path)}:{line} {url!r}: no id={frag!r} in {rel(target)}")
            if "/assets/img/" in "/" + os.path.relpath(target, ROOT).replace(os.sep, "/"):
                used_images.add(os.path.basename(target))
        for a, line in p.imgs:
            for need in ("alt", "width", "height"):
                if not a.get(need):
                    fail(f"{rel(path)}:{line} <img> missing {need}")
        for a, line in p.blank:
            if "noopener" not in (a.get("rel") or ""):
                fail(f"{rel(path)}:{line} target=_blank without rel=noopener")

    # stylesheet url(...) references
    css_path = os.path.join(ROOT, "assets/css/style.css")
    css = open(css_path, encoding="utf-8").read()
    for url in re.findall(r"url\(\s*['\"]?([^'\")]+)['\"]?\s*\)", css):
        if url.startswith(("data:", "http:", "https:", "#")):
            continue
        target = os.path.normpath(os.path.join(os.path.dirname(css_path), url))
        if not os.path.exists(target):
            fail(f"assets/css/style.css url({url}) -> missing {rel(target)}")

    # credits coverage
    credits = json.load(open(os.path.join(ROOT, "assets/img/credits.json"), encoding="utf-8"))
    credited = {c["file"] for c in credits}
    credits_page = pages.get(os.path.join(ROOT, "credits/index.html"))
    credits_text = credits_page.source if credits_page else ""
    for img in sorted(used_images):
        if img.endswith(".svg"):
            continue
        original = re.sub(r"-900(\.jpg)$", r"\1", img)
        if original not in credited:
            fail(f"image {img} is used but {original} is not in credits.json")
        if original not in credits_text:
            fail(f"image {img} is used but {original} is not listed on the credits page")
    for c in credits:
        # photos supplied by First In have no licence or source link
        own = c.get("license") == "Used with permission"
        keys = ("title", "author", "license", "alt") if own else ("title", "author", "license", "license_url", "source_url", "alt")
        for key in keys:
            if not c.get(key):
                fail(f"credits.json entry {c.get('file')} missing {key}")

    # content rules
    for path, p in pages.items():
        text = " ".join(p.text)
        name = rel(path)
        if DISCLAIMER not in text:
            fail(f"{name} missing footer disclaimer")
        if re.search(r"\bping\b", p.source, re.I):
            fail(f"{name} mentions 'Ping'")
        if re.search(r"resel|resale|scrap|monitor|polling|poll ", p.source, re.I):
            fail(f"{name} mentions reselling or how alerts are found")
        telegram = [u for _, u, _ in p.refs if "t.me/" in u]
        if name in ("index.html", "bristol/index.html", "bath/index.html", "404.html", "credits/index.html") and telegram:
            fail(f"{name} links to Telegram directly: {telegram}")
        if name == "exeter/index.html":
            for need in ("https://t.me/FirstInExeter", "https://t.me/FirstInExeterBot?start=web_exeter"):
                if need not in telegram:
                    fail(f"exeter page is missing link {need}")
            if text.count("TP Wednesday") > 1:
                fail("exeter page mentions TP Wednesday more than once")
        for tag in ("<title>", 'name="description"', 'property="og:title"', 'property="og:description"'):
            if tag not in p.source:
                fail(f"{name} missing {tag}")

    print(f"Checked {len(pages)} HTML files, {sum(len(p.refs) for p in pages.values())} references, "
          f"{len(used_images)} images in use.")
    if problems:
        print(f"\n{len(problems)} problem(s):")
        for m in problems:
            print("  - " + m)
        sys.exit(1)
    print("All checks passed.")


if __name__ == "__main__":
    main()
