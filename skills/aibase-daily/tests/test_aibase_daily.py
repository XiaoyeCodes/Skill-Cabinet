import copy
from datetime import date, datetime
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "aibase_daily.py"
SPEC = spec_from_file_location("aibase_daily", SCRIPT)
a = module_from_spec(SPEC)
SPEC.loader.exec_module(a)
URL = "https://news.aibase.cn/daily/31727"
HTML = """<!doctype html><html><head><title>AI日报：原文标题</title>
<script>fake 发布时间 : 2026年10月20号 16:00</script></head><body>
<div><span>发布时间 :</span><span>2026年10月19号 16:13</span></div>
<div class="articleContent"><div class="post-content">
<p>这是正文介绍，不应进入结果</p><p><strong>1、标题 A&amp;B <span>原样</span></strong></p>
<p>说明正文不能成为提要。</p>
<blockquote><p>【AiBase提要:】</p><p>🔍  两个空格 &amp; &lt;tag&gt; “原样”</p>
<p>🛠️ 含 AiBase提要: 的完整正文不得删去。</p></blockquote>
<p><strong>2、第二条:标点</strong></p><blockquote><p>【AiBase提要:】</p>
<p>百分比 50%+50%，不改写</p></blockquote></div></div></body></html>"""


class ExtractionTests(unittest.TestCase):
    def test_exact_heading_and_bullets(self):
        d = a.extract_article(HTML, URL)
        self.assertEqual(d["items"][0]["heading"], "1、标题 A&B 原样")
        self.assertEqual(d["items"][0]["bullets"], [
            "🔍  两个空格 & <tag> “原样”",
            "🛠️ 含 AiBase提要: 的完整正文不得删去。",
        ])
        self.assertEqual(d["publication_text"], "2026年10月19号 16:13")

    def test_only_label_paragraph_is_removed(self):
        d = a.extract_article(HTML, URL)
        rendered = a.render_html(d)
        self.assertNotIn("【AiBase提要:】", rendered)
        self.assertIn("含 AiBase提要: 的完整正文不得删去。", rendered)
        self.assertNotIn("说明正文", rendered)
        self.assertEqual(d["items"][0]["raw_abstract"],
                         "\n\n".join([d["items"][0]["summary_label"]] + d["items"][0]["bullets"]))

    def test_html_escaping(self):
        d = a.extract_article(HTML, URL)
        d["items"][0]["bullets"][0] = '<script>alert("x")</script> & \'<img src=x>\''
        d["items"][0]["raw_abstract"] = "\n\n".join(
            [d["items"][0]["summary_label"]] + d["items"][0]["bullets"])
        rendered = a.render_html(a.validate(d))
        self.assertNotIn("<script>", rendered)
        self.assertNotIn("<img src=x>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn("&#x27;", rendered)
        self.assertEqual(rendered.count("<a "), 1)

    def test_multiple_spaces_and_breaks_remain_visible(self):
        d = a.extract_article(HTML, URL)
        self.assertIn("white-space:pre-wrap;", a.render_html(d))
        source = HTML.replace("百分比 50%", "百分比<br>50%")
        d = a.extract_article(source, URL)
        self.assertEqual(d["items"][1]["bullets"][0], "百分比\n50%+50%，不改写")
        self.assertIn("white-space:pre-wrap;", a.render_html(d))

    def test_url_is_restricted(self):
        for url in ["javascript:alert(1)", "https://evil.test/daily/123",
                    "https://news.aibase.cn@evil.test/daily/123",
                    'https://news.aibase.cn/daily/123?x="onload=1']:
            with self.subTest(url=url), self.assertRaises(a.DigestError):
                a.safe_url(url)

    def test_date_guard(self):
        d = a.extract_article(HTML, URL)
        a.validate(d, date(2026, 10, 19))
        with self.assertRaises(a.NoArticle):
            a.validate(d, date(2026, 10, 20))

    def test_missing_date_and_relative_time_rejected(self):
        for replacement in ["", "3 小时前"]:
            with self.subTest(replacement=replacement), self.assertRaises(a.DigestError):
                a.extract_article(HTML.replace("2026年10月19号 16:13", replacement), URL)

    def test_mismatches_rejected(self):
        bad = [
            HTML.replace("<p><strong>2、第二条:标点</strong></p>", ""),
            HTML.replace("<p>【AiBase提要:】</p>", "", 1),
            HTML.replace("<p>百分比 50%+50%，不改写</p>", ""),
            HTML.replace("2、第二条", "3、第二条"),
            HTML.replace("</blockquote>", "</blockquote><p>3、无对应提要</p>", 1),
        ]
        for source in bad:
            with self.subTest(source=source[-150:]), self.assertRaises(a.DigestError):
                a.extract_article(source, URL)

    def test_import_rejects_lost_bullet(self):
        d = a.extract_article(HTML, URL)
        d["items"][0]["bullets"].pop()
        with self.assertRaises(a.DigestError):
            a.validate(d)

    def test_selects_latest_absolute_same_day(self):
        listing = '<a href="/daily/31727">1 小时前</a><a href="/daily/31728">昨天</a>'
        pages = {
            a.LIST_URL: listing,
            URL: HTML,
            "https://news.aibase.cn/daily/31728": HTML.replace("16:13", "18:30"),
        }
        with patch.object(a, "fetch", side_effect=pages.__getitem__):
            d = a.select_article(date(2026, 10, 19))
        self.assertEqual(d["source_url"], "https://news.aibase.cn/daily/31728")

    def test_no_old_fallback(self):
        listing = '<a href="/daily/31727">刚刚</a>'
        with patch.object(a, "fetch", side_effect=lambda url: listing if url == a.LIST_URL else HTML):
            with self.assertRaises(a.NoArticle):
                a.select_article(date(2026, 10, 20))

    def test_no_outputs_on_date_error(self):
        d = a.extract_article(HTML, URL)
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory) / "output"
            with self.assertRaises(a.NoArticle):
                a.write_outputs(d, date(2026, 10, 20), out, False)
            self.assertFalse(out.exists())

    def test_dynamic_output_and_template(self):
        d = a.extract_article(HTML, URL)
        with tempfile.TemporaryDirectory() as directory:
            paths = a.write_outputs(d, date(2026, 10, 19), Path(directory), True)
            self.assertEqual(set(paths), {"html", "txt", "json"})
            rendered = Path(paths["html"]).read_text()
            self.assertIn("历史版", rendered)
            self.assertIn("历史版", Path(paths["txt"]).read_text())
            self.assertNotIn("测试版", rendered)
            self.assertEqual(rendered.count('class="original-heading"'), 2)
            self.assertEqual(rendered.count('class="original-bullet"'), 3)
            for color in ["#F1E8D8", "#FCFAF6", "#282622"]:
                self.assertIn(color, rendered)
            self.assertIn("max-width:640px", rendered)


if __name__ == "__main__":
    unittest.main()
