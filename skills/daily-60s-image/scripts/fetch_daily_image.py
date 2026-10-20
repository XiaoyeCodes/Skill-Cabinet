#!/usr/bin/env python3
"""Fetch a date-exact 60s news image. Python 3.9+, standard library only."""

import argparse
import hashlib
import http.client
import json
import re
import struct
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
import zlib
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BEIJING = timezone(timedelta(hours=8), name="Asia/Shanghai")
JSON_LIMIT = 2 * 1024 * 1024
IMAGE_LIMIT = 25 * 1024 * 1024
PIXEL_LIMIT = 50_000_000
DECODE_LIMIT = 200 * 1024 * 1024
SOURCE_TEMPLATES = (
    "https://60s-static.viki.moe/60s/{date}.json",
    "https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/60s/{date}.json",
)
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
JSON_TYPES = {"application/json", "text/json", "text/plain", "application/octet-stream"}
IMAGE_TYPES = {
    "png": {"image/png", "image/x-png", "application/octet-stream"},
    "jpg": {"image/jpeg", "image/jpg", "application/octet-stream"},
}


class FetchError(ValueError):
    """A source is unavailable or failed validation."""


def beijing_today(now=None):
    now = now if now is not None else datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(BEIJING).date()


def target_date(value=None, now=None):
    today = beijing_today(now)
    if value is None:
        return today.isoformat()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
        raise ValueError("--date must be YYYY-MM-DD")
    parsed = date.fromisoformat(value)
    if parsed > today:
        raise ValueError("--date cannot be later than today in Beijing")
    return parsed.isoformat()


def safe_https(url):
    if not isinstance(url, str):
        raise FetchError("URL must be a string")
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise FetchError("A credential-free HTTPS URL is required")
    return url


class HTTPSRedirectHandler(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_https(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_url(url, limit, timeout=30):
    safe_https(url)
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "daily-60s-image/1.0",
            "Accept": "*/*",
            "Cache-Control": "no-cache",
        },
    )
    opener = urllib.request.build_opener(HTTPSRedirectHandler())
    try:
        with opener.open(request, timeout=timeout) as response:
            final_url = safe_https(response.geturl())
            if response.status != 200:
                raise FetchError("HTTP status {}".format(response.status))
            length = response.headers.get("Content-Length")
            if length is not None:
                try:
                    expected = int(length)
                except ValueError as exc:
                    raise FetchError("Invalid Content-Length") from exc
                if expected < 1 or expected > limit:
                    raise FetchError("Response size is outside the allowed range")
            else:
                expected = None
            data = response.read(limit + 1)
            if not data or len(data) > limit:
                raise FetchError("Response is empty or exceeds the size limit")
            if expected is not None and len(data) != expected:
                raise FetchError("Truncated response: Content-Length mismatch")
            content_type = response.headers.get_content_type().lower()
            return data, content_type, final_url
    except (urllib.error.URLError, http.client.HTTPException, OSError, TimeoutError) as exc:
        raise FetchError(str(exc)) from exc


def parse_source(data, content_type, wanted):
    if content_type.split(";", 1)[0].lower() not in JSON_TYPES:
        raise FetchError("Unexpected JSON Content-Type: " + content_type)
    if not data or len(data) > JSON_LIMIT:
        raise FetchError("JSON is empty or too large")
    try:
        obj = json.loads(data.decode("utf-8-sig"))
    except (ValueError, UnicodeError) as exc:
        raise FetchError("Invalid JSON") from exc
    if not isinstance(obj, dict):
        raise FetchError("Source JSON must be an object")
    if obj.get("date") != wanted:
        raise FetchError("Source date {!r} does not equal {}".format(obj.get("date"), wanted))
    news = obj.get("news")
    if not isinstance(news, list) or not news or not all(
        isinstance(item, str) and item.strip() for item in news
    ):
        raise FetchError("Source has no valid nonempty news list")
    safe_https(obj.get("image"))
    return obj


def image_candidates(url):
    """Keep the declared image; map only the known repository's CDN path."""
    safe_https(url)
    candidates = [url]
    parsed = urllib.parse.urlsplit(url)
    prefixes = ("/gh/vikiboss/60s-static-host@main/", "/gh/vikiboss/60s-static-host@master/")
    if parsed.hostname in {"cdn.jsdmirror.com", "cdn.jsdelivr.net", "fastly.jsdelivr.net"}:
        for prefix in prefixes:
            if parsed.path.startswith(prefix):
                suffix = parsed.path[len(prefix):]
                if re.fullmatch(r"static/images/\d{4}-\d{2}-\d{2}\.(?:png|jpe?g)", suffix):
                    branch = "master" if "@master/" in prefix else "main"
                    candidates.append(
                        "https://raw.githubusercontent.com/vikiboss/60s-static-host/"
                        + branch + "/" + suffix
                    )
                break
    return candidates


def _check_dimensions(width, height):
    if width < 1 or height < 1 or width * height > PIXEL_LIMIT:
        raise FetchError("Image dimensions are invalid or exceed the pixel limit")


def _png_info(data):
    offset = 8
    header = None
    idat = bytearray()
    seen_iend = False
    seen_palette = False
    seen_idat = False
    idat_ended = False
    while offset < len(data):
        if offset + 12 > len(data):
            raise FetchError("Truncated PNG chunk")
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        end = offset + 12 + length
        if end > len(data):
            raise FetchError("Truncated PNG chunk payload")
        payload = data[offset + 8:offset + 8 + length]
        crc = struct.unpack(">I", data[offset + 8 + length:end])[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != crc:
            raise FetchError("PNG CRC mismatch")
        if header is None and kind != b"IHDR":
            raise FetchError("PNG must begin with IHDR")
        if kind == b"IHDR":
            if header is not None or length != 13:
                raise FetchError("Invalid PNG IHDR")
            header = struct.unpack(">IIBBBBB", payload)
            width, height, depth, color, compression, filtering, interlace = header
            _check_dimensions(width, height)
            depths = {0: {1, 2, 4, 8, 16}, 2: {8, 16}, 3: {1, 2, 4, 8}, 4: {8, 16}, 6: {8, 16}}
            if depth not in depths.get(color, set()) or compression != 0 or filtering != 0 or interlace not in (0, 1):
                raise FetchError("Invalid PNG pixel format")
        elif kind == b"PLTE":
            if seen_idat or not length or length % 3 or length > 768:
                raise FetchError("Invalid PNG palette")
            seen_palette = True
        elif kind == b"IDAT":
            if idat_ended:
                raise FetchError("PNG IDAT chunks are not consecutive")
            seen_idat = True
            idat.extend(payload)
        elif kind == b"IEND":
            if length or end != len(data):
                raise FetchError("Invalid PNG end")
            seen_iend = True
            break
        elif kind and not (kind[0] & 32):
            raise FetchError("Unknown critical PNG chunk")
        if seen_idat and kind != b"IDAT":
            idat_ended = True
        offset = end
    if header is None or not idat or not seen_iend:
        raise FetchError("Incomplete PNG")
    width, height, depth, color, _, _, interlace = header
    if color == 3 and not seen_palette:
        raise FetchError("Indexed PNG lacks a palette")
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    passes = [(0, 0, 1, 1)] if interlace == 0 else [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2),
    ]
    rows = []
    expected = 0
    for x, y, dx, dy in passes:
        w = max(0, (width - x + dx - 1) // dx)
        h = max(0, (height - y + dy - 1) // dy)
        if w and h:
            stride = (w * channels * depth + 7) // 8 + 1
            rows.append((stride, h))
            expected += stride * h
    if expected > DECODE_LIMIT:
        raise FetchError("PNG decoded size exceeds the limit")
    try:
        decoder = zlib.decompressobj()
        raw = decoder.decompress(bytes(idat), expected + 1)
    except zlib.error as exc:
        raise FetchError("Corrupt PNG compressed pixels") from exc
    if len(raw) != expected or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise FetchError("PNG decoded pixels do not match its dimensions")
    cursor = 0
    for stride, count in rows:
        for _ in range(count):
            if raw[cursor] > 4:
                raise FetchError("Invalid PNG scanline filter")
            cursor += stride
    return width, height


def _jpeg_info(data):
    """Check marker/segment boundaries, frame dimensions, scans and exact EOI."""
    if not data.endswith(b"\xff\xd9"):
        raise FetchError("JPEG lacks an end marker")
    offset = 2
    dimensions = None
    seen_scan = False
    in_scan = False
    frame_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset < len(data):
        if in_scan:
            marker_at = data.find(b"\xff", offset)
            if marker_at < 0:
                raise FetchError("Truncated JPEG scan")
            offset = marker_at
        if data[offset] != 0xFF:
            raise FetchError("Invalid JPEG marker")
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            raise FetchError("Truncated JPEG marker")
        marker = data[offset]
        offset += 1
        if in_scan and (marker == 0 or 0xD0 <= marker <= 0xD7):
            continue
        in_scan = False
        if marker == 0xD9:
            if offset != len(data) or dimensions is None or not seen_scan:
                raise FetchError("Incomplete JPEG")
            return dimensions
        if marker in {0, 0xD8} or 0xD0 <= marker <= 0xD7:
            raise FetchError("Unexpected JPEG standalone marker")
        if marker == 0x01:
            continue
        if offset + 2 > len(data):
            raise FetchError("Truncated JPEG segment")
        length = struct.unpack(">H", data[offset:offset + 2])[0]
        if length < 2 or offset + length > len(data):
            raise FetchError("Invalid JPEG segment length")
        payload = data[offset + 2:offset + length]
        if marker in frame_markers:
            if len(payload) < 6:
                raise FetchError("Truncated JPEG frame")
            height, width = struct.unpack(">HH", payload[1:5])
            components = payload[5]
            if not components or len(payload) != 6 + 3 * components:
                raise FetchError("Invalid JPEG frame components")
            _check_dimensions(width, height)
            if dimensions is not None and dimensions != (width, height):
                raise FetchError("Inconsistent JPEG dimensions")
            dimensions = width, height
        if marker == 0xDA:
            if dimensions is None or not payload or len(payload) != 4 + 2 * payload[0]:
                raise FetchError("Invalid JPEG scan header")
            seen_scan = True
            in_scan = True
        offset += length
    raise FetchError("Incomplete JPEG")


def validate_image(data, content_type):
    if not data or len(data) > IMAGE_LIMIT:
        raise FetchError("Image is empty or exceeds the byte limit")
    if data.startswith(PNG_SIGNATURE):
        fmt = "png"
        dimensions = _png_info(data)
    elif data.startswith(b"\xff\xd8"):
        fmt = "jpg"
        dimensions = _jpeg_info(data)
    else:
        raise FetchError("Response is not a PNG or JPEG")
    media_type = content_type.split(";", 1)[0].lower()
    if media_type not in IMAGE_TYPES[fmt]:
        raise FetchError("Content-Type {} disagrees with {} bytes".format(content_type, fmt))
    return fmt, dimensions


def download(wanted, output_dir, fetcher=fetch_url, timeout=30, explicit_date=False):
    root = Path(output_dir).expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    run_dir = Path(tempfile.mkdtemp(prefix="daily-60s-" + wanted + "-", dir=str(root)))
    result = {
        "status": "unavailable",
        "target_date": wanted,
        "timezone": "Asia/Shanghai (UTC+08:00)",
        "date_mode": "explicit" if explicit_date else "today",
        "retrieved_at": datetime.now(timezone.utc).isoformat(),
        "manifest_path": str(run_dir / "result.json"),
        "visual_check": {"status": "not_performed"},
        "attempts": [],
    }
    for template in SOURCE_TEMPLATES:
        source_url = template.format(date=wanted)
        try:
            raw_json, json_type, final_source = fetcher(source_url, JSON_LIMIT, timeout)
            source = parse_source(raw_json, json_type, wanted)
        except (FetchError, OSError, ValueError) as exc:
            result["attempts"].append({"kind": "json", "url": source_url, "error": str(exc)})
            continue
        for image_url in image_candidates(source["image"]):
            try:
                raw_image, content_type, final_image = fetcher(image_url, IMAGE_LIMIT, timeout)
                fmt, (width, height) = validate_image(raw_image, content_type)
            except (FetchError, OSError, ValueError) as exc:
                result["attempts"].append({"kind": "image", "url": image_url, "error": str(exc)})
                continue
            image_path = run_dir / ("daily-60s-{}.{}".format(wanted, fmt))
            image_path.write_bytes(raw_image)
            (run_dir / "source.json").write_bytes(raw_json)
            result.update({
                "status": "downloaded_pending_visual_check",
                "source_url": source_url,
                "source_final_url": final_source,
                "source_json_path": str(run_dir / "source.json"),
                "source_json_sha256": hashlib.sha256(raw_json).hexdigest(),
                "declared_image_url": source["image"],
                "image_url": image_url,
                "image_final_url": final_image,
                "image_path": str(image_path),
                "format": fmt,
                "content_type": content_type,
                "bytes": len(raw_image),
                "width": width,
                "height": height,
                "sha256": hashlib.sha256(raw_image).hexdigest(),
                "news_count": len(source["news"]),
            })
            break
        if result["status"] == "downloaded_pending_visual_check":
            break
    if result["status"] == "unavailable":
        result["error"] = "No date-matching, structurally valid image could be downloaded."
    Path(result["manifest_path"]).write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--date", help="Explicit user-requested historical date, YYYY-MM-DD")
    parser.add_argument("--output-dir", default="./output", help="Directory for an isolated result folder")
    parser.add_argument("--timeout", type=float, default=30, help="Network timeout in seconds (default: 30)")
    args = parser.parse_args(argv)
    try:
        wanted = target_date(args.date)
        if args.timeout <= 0 or args.timeout > 300:
            raise ValueError("--timeout must be between 0 and 300 seconds")
    except ValueError as exc:
        parser.error(str(exc))
    try:
        result = download(wanted, args.output_dir, timeout=args.timeout, explicit_date=args.date is not None)
    except OSError as exc:
        print(json.dumps({"status": "unavailable", "error": str(exc)}, ensure_ascii=False))
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "downloaded_pending_visual_check" else 1


if __name__ == "__main__":
    sys.exit(main())
