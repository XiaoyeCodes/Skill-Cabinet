"""Offline regression tests using only generated, non-personal fixtures."""

import hashlib
import http.client
import importlib.util
import json
import struct
import tempfile
import unittest
import zlib
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "fetch_daily_image.py"
SPEC = importlib.util.spec_from_file_location("fetch_daily_image", SCRIPT)
news_image = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(news_image)

DATE = "2026-10-20"
PRIMARY, FALLBACK = [template.format(date=DATE) for template in news_image.SOURCE_TEMPLATES]
IMAGE = "https://cdn.jsdmirror.com/gh/vikiboss/60s-static-host@main/static/images/2026-10-20.png"
RAW_IMAGE = "https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/images/2026-10-20.png"


def chunk(kind, payload):
    return (
        struct.pack(">I", len(payload)) + kind + payload
        + struct.pack(">I", zlib.crc32(kind + payload) & 0xFFFFFFFF)
    )


def png(width=3, height=2, pixels=None):
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    raw = pixels if pixels is not None else (b"\x00" + b"\x48\x98\xd0" * width) * height
    return (
        news_image.PNG_SIGNATURE + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")
    )


def jpeg():
    """A synthetic 1x1 grayscale JPEG, with one zero-DC/zero-AC block."""
    def segment(marker, payload):
        return b"\xff" + bytes([marker]) + struct.pack(">H", len(payload) + 2) + payload
    dc = b"\x00" + b"\x01" + b"\x00" * 15 + b"\x00"
    ac = b"\x10" + b"\x01" + b"\x00" * 15 + b"\x00"
    return (
        b"\xff\xd8"
        + segment(0xDB, b"\x00" + b"\x01" * 64)
        + segment(0xC0, b"\x08\x00\x01\x00\x01\x01\x01\x11\x00")
        + segment(0xC4, dc + ac)
        + segment(0xDA, b"\x01\x01\x00\x00\x3f\x00")
        + b"\x3f\xff\xd9"
    )


def source(day=DATE, image=IMAGE):
    return json.dumps({
        "date": day,
        "news": ["Synthetic test item one", "Synthetic test item two"],
        "image": image,
        "cover": "https://example.invalid/cover.jpg",
    }).encode("utf-8")


class FakeFetcher:
    def __init__(self, responses):
        self.responses = responses
        self.calls = []

    def __call__(self, url, limit, timeout):
        self.calls.append(url)
        response = self.responses.get(url, news_image.FetchError("Simulated HTTP 404"))
        if isinstance(response, Exception):
            raise response
        data, media_type = response
        if len(data) > limit:
            raise news_image.FetchError("Simulated response limit")
        return data, media_type, url


class DateTests(unittest.TestCase):
    def test_beijing_day_boundary_without_tzdata(self):
        self.assertEqual(
            news_image.target_date(now=datetime(2026, 10, 19, 15, 59, 59, tzinfo=timezone.utc)),
            "2026-10-19",
        )
        self.assertEqual(
            news_image.target_date(now=datetime(2026, 10, 19, 16, 0, 0, tzinfo=timezone.utc)),
            "2026-10-20",
        )

    def test_year_boundary(self):
        self.assertEqual(
            news_image.target_date(now=datetime(2026, 12, 31, 20, tzinfo=timezone.utc)),
            "2027-01-01",
        )

    def test_explicit_historical_date_and_leap_date(self):
        now = datetime(2026, 10, 20, tzinfo=timezone.utc)
        self.assertEqual(news_image.target_date("2024-02-29", now), "2024-02-29")
        for invalid in ("2026-2-01", "2026-02-29", "2026-10-21"):
            with self.subTest(invalid=invalid), self.assertRaises(ValueError):
                news_image.target_date(invalid, now)

    def test_naive_clock_is_not_silently_assumed(self):
        with self.assertRaises(ValueError):
            news_image.beijing_today(datetime(2026, 10, 20))


class ImageValidationTests(unittest.TestCase):
    def test_png_and_jpeg_real_formats(self):
        self.assertEqual(news_image.validate_image(png(), "image/png"), ("png", (3, 2)))
        self.assertEqual(news_image.validate_image(jpeg(), "image/jpeg"), ("jpg", (1, 1)))

    def test_raw_github_octet_stream_is_checked_by_bytes(self):
        self.assertEqual(news_image.validate_image(png(), "application/octet-stream")[0], "png")

    def test_html_error_page_cannot_be_saved_as_image(self):
        for content_type in ("text/html", "image/png", "application/octet-stream"):
            with self.subTest(content_type=content_type), self.assertRaises(news_image.FetchError):
                news_image.validate_image(b"<html>Error page</html>", content_type)

    def test_mime_mismatch_is_rejected(self):
        for content_type in ("text/html", "text/plain", "image/jpeg"):
            with self.subTest(content_type=content_type), self.assertRaises(news_image.FetchError):
                news_image.validate_image(png(), content_type)

    def test_corrupt_crc_and_truncation(self):
        original = png()
        corrupt = bytearray(original)
        corrupt[30] ^= 1
        for data in (bytes(corrupt), original[:-4], original[:8], jpeg()[:-2]):
            with self.subTest(length=len(data)), self.assertRaises(news_image.FetchError):
                news_image.validate_image(data, "application/octet-stream")

    def test_correct_crc_but_invalid_compressed_pixels(self):
        header = struct.pack(">IIBBBBB", 3, 2, 8, 2, 0, 0, 0)
        invalid = (
            news_image.PNG_SIGNATURE + chunk(b"IHDR", header)
            + chunk(b"IDAT", b"not zlib") + chunk(b"IEND", b"")
        )
        with self.assertRaises(news_image.FetchError):
            news_image.validate_image(invalid, "image/png")

    def test_wrong_pixel_count_and_bad_filter(self):
        for data in (png(pixels=b"\x00\x00"), png(pixels=(b"\x05" + b"\x00" * 9) * 2)):
            with self.assertRaises(news_image.FetchError):
                news_image.validate_image(data, "image/png")

    def test_huge_dimensions_rejected_before_decompression(self):
        with self.assertRaises(news_image.FetchError):
            news_image.validate_image(png(50_000_001, 1, pixels=b""), "image/png")

    def test_no_fake_png_from_renamed_jpeg(self):
        self.assertEqual(news_image.validate_image(jpeg(), "image/jpeg")[0], "jpg")

    def test_insecure_image_url_rejected(self):
        for url in ("http://example.com/test.png", "file:///tmp/test.png", "https://user:pass@example.com/x"):
            with self.subTest(url=url), self.assertRaises(news_image.FetchError):
                news_image.parse_source(source(image=url), "application/json", DATE)

    def test_unrelated_cdn_path_does_not_create_guessed_fallback(self):
        url = "https://cdn.jsdmirror.com/gh/another/repo@main/image.png"
        self.assertEqual(news_image.image_candidates(url), [url])


class TransportTests(unittest.TestCase):
    def test_truncated_chunked_http_becomes_recoverable_source_failure(self):
        with patch.object(news_image.urllib.request, "build_opener") as build:
            build.return_value.open.side_effect = http.client.IncompleteRead(b"partial", 10)
            with self.assertRaises(news_image.FetchError):
                news_image.fetch_url(PRIMARY, news_image.JSON_LIMIT)


class EndToEndTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def run_fetch(self, responses):
        fake = FakeFetcher(responses)
        result = news_image.download(DATE, self.tmp.name, fetcher=fake)
        return result, fake

    def test_primary_live_style_success_manifest_and_bytes(self):
        data = png()
        result, fake = self.run_fetch({
            PRIMARY: (source(), "application/json"),
            IMAGE: (data, "image/png"),
        })
        self.assertEqual(result["status"], "downloaded_pending_visual_check")
        self.assertEqual(result["visual_check"]["status"], "not_performed")
        self.assertEqual(fake.calls, [PRIMARY, IMAGE])
        self.assertEqual(Path(result["image_path"]).read_bytes(), data)
        self.assertEqual(result["sha256"], hashlib.sha256(data).hexdigest())
        self.assertEqual(json.loads(Path(result["manifest_path"]).read_text()), result)
        self.assertEqual(Path(result["source_json_path"]).read_bytes(), source())

    def test_stale_primary_falls_back_to_date_exact_github(self):
        result, fake = self.run_fetch({
            PRIMARY: (source("2026-10-19"), "application/json"),
            FALLBACK: (source(), "text/plain"),
            IMAGE: (png(), "image/png"),
        })
        self.assertEqual(result["source_url"], FALLBACK)
        self.assertEqual(fake.calls, [PRIMARY, FALLBACK, IMAGE])
        self.assertIn("does not equal", result["attempts"][0]["error"])

    def test_both_sources_stale_never_download_old_picture(self):
        result, fake = self.run_fetch({
            PRIMARY: (source("2026-10-19"), "application/json"),
            FALLBACK: (source("2026-10-19"), "text/plain"),
            IMAGE: (png(), "image/png"),
        })
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("image_path", result)
        self.assertEqual(fake.calls, [PRIMARY, FALLBACK])
        self.assertEqual(list(Path(self.tmp.name).rglob("*.png")), [])

    def test_network_failure_uses_github_json(self):
        result, _ = self.run_fetch({
            PRIMARY: news_image.FetchError("Simulated timeout"),
            FALLBACK: (source(), "text/plain"),
            IMAGE: (png(), "image/png"),
        })
        self.assertEqual(result["source_url"], FALLBACK)
        self.assertEqual(result["status"], "downloaded_pending_visual_check")

    def test_truncated_http_primary_still_reaches_github_and_writes_manifest(self):
        alternate = FakeFetcher({
            FALLBACK: (source(), "text/plain"),
            IMAGE: (png(), "image/png"),
        })
        def mixed_fetcher(url, limit, timeout):
            if url == PRIMARY:
                return news_image.fetch_url(url, limit, timeout)
            return alternate(url, limit, timeout)
        with patch.object(news_image.urllib.request, "build_opener") as build:
            build.return_value.open.side_effect = http.client.IncompleteRead(b"partial", 10)
            result = news_image.download(DATE, self.tmp.name, fetcher=mixed_fetcher)
        self.assertEqual(result["status"], "downloaded_pending_visual_check")
        self.assertEqual(result["source_url"], FALLBACK)
        self.assertTrue(Path(result["manifest_path"]).exists())

    def test_image_cdn_nonimage_response_uses_exact_raw_image(self):
        result, fake = self.run_fetch({
            PRIMARY: (source(), "application/json"),
            IMAGE: (b"<html>Gateway error</html>", "text/html"),
            RAW_IMAGE: (png(), "image/png"),
        })
        self.assertEqual(result["image_url"], RAW_IMAGE)
        self.assertEqual(result["declared_image_url"], IMAGE)
        self.assertEqual(fake.calls, [PRIMARY, IMAGE, RAW_IMAGE])

    def test_all_corrupt_images_give_no_success_or_partial_file(self):
        result, _ = self.run_fetch({
            PRIMARY: (source(), "application/json"),
            FALLBACK: (source(), "text/plain"),
            IMAGE: (png()[:-10], "image/png"),
            RAW_IMAGE: (b"<html>Failure</html>", "image/png"),
        })
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn("image_path", result)
        self.assertEqual(list(Path(self.tmp.name).rglob("*.png")), [])

    def test_empty_news_cannot_pass_on_date_alone(self):
        invalid = json.dumps({"date": DATE, "news": [], "image": IMAGE}).encode()
        result, fake = self.run_fetch({PRIMARY: (invalid, "application/json")})
        self.assertEqual(result["status"], "unavailable")
        self.assertNotIn(IMAGE, fake.calls)

    def test_jpeg_saved_with_actual_extension(self):
        result, _ = self.run_fetch({
            PRIMARY: (source(), "application/json"),
            IMAGE: (jpeg(), "image/jpeg"),
        })
        self.assertTrue(result["image_path"].endswith(".jpg"))
        self.assertEqual(result["format"], "jpg")

    def test_run_directories_prevent_stale_file_reuse(self):
        first, _ = self.run_fetch({PRIMARY: (source(), "application/json"), IMAGE: (png(), "image/png")})
        second, _ = self.run_fetch({})
        self.assertNotEqual(first["manifest_path"], second["manifest_path"])
        self.assertEqual(second["status"], "unavailable")
        self.assertNotIn("image_path", second)
        self.assertTrue(Path(first["image_path"]).exists())

    def test_main_nonzero_on_unavailable(self):
        with patch.object(news_image, "download", return_value={"status": "unavailable"}), patch("builtins.print"):
            self.assertEqual(news_image.main(["--output-dir", self.tmp.name]), 1)


if __name__ == "__main__":
    unittest.main()
