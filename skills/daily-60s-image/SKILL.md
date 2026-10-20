---
name: "daily-60s-image"
display_name: "每日 60 秒新闻图片"
description: "获取北京时间当天的「每日 60 秒读懂世界」新闻原图，校验日期与真实图片文件后直接交付图片；也支持用户明确指定日期的历史查询。不包含邮箱推送或定时任务。"
version: "1.0.0"
author: ""
tags: []
category: "新闻日报"
---

# 每日 60 秒新闻图片

## 要交付什么

交付用户指定日期（默认北京时间今天）的真实新闻原图，不是只有图片网址或文字摘要。随结果保留一个小型 JSON 记录，说明日期、来源、下载时间、文件大小和 SHA-256。无需邮箱、登录账户、API key 或其他 skill。

依赖：Python 3.9+ 标准库，以及可以访问下述公开 HTTPS 来源的网络。Windows 可用 `py -3` 代替 `python`。北京时间使用固定 UTC+8，不依赖操作系统时区或额外的 tzdata 包。

## 执行

进入此 skill 目录后运行：

```bash
python scripts/fetch_daily_image.py --output-dir ./output
```

也可以把脚本和输出目录改成绝对路径。程序不会读取已有图片来冒充新的下载结果。

只有用户明确要求历史日期查询或历史测试时，才传入日期：

```bash
python scripts/fetch_daily_image.py --date 2026-10-19 --output-dir ./output
```

`--date` 必须为有效的 `YYYY-MM-DD`，且不能晚于北京时间今天。不要为了“成功”擅自改查前一天；当天未发布就是当天未获取到。

脚本按顺序读取：

1. `https://60s-static.viki.moe/60s/YYYY-MM-DD.json`
2. `https://raw.githubusercontent.com/vikiboss/60s-static-host/main/static/60s/YYYY-MM-DD.json`

只接受 `date` 与目标日期完全相同、`news` 为非空新闻列表、`image` 为有效 HTTPS 图片地址的 JSON。使用 `image` 字段里的完整新闻图，不用 `cover` 封面代替。如果该字段指向已知 GitHub 仓库的 CDN 路径，脚本还会尝试同一文件的 GitHub 原始地址。原来源一般提供 PNG，应优先保留 PNG；若原图实际为合法 JPEG，则按真实格式保存，不改扩展名伪装成 PNG，也不重新生成新闻图。

下载结果会检查 HTTP 类型、字节数、PNG/JPEG 签名与结构、尺寸；PNG 还检查 CRC、解压结果与扫描行。HTML、损坏文件、过期日期或未发布响应均不得报告为成功。脚本不绕过 TLS 证书检查。公开源的文章内容本身并不因此得到事实核验。

## 必须完成的人工/视觉检查

脚本退出码为 0、清单状态为 `downloaded_pending_visual_check`，仅表示下载和程序校验通过，不是最终完成。

1. 打开实际下载的图片，用宿主的图片查看或视觉能力检查可正常解码、文字可读。
2. 对照保存的 `source.json`：图上日期必须与 `target_date` 完全一致，主要标题/新闻条目应与 JSON 对应。尤其要排除 URL/JSON 是今天、图片内容却是旧图的情况。
3. 只有通过后才能向用户说“已获取”，并交付图片。可以把 `result.json` 中 `status` 改为 `ready`，并将 `visual_check` 的 `status` 改为 `passed`，补充简短 `note`；不要在未实际查看时这样标记。

若宿主不能查看图片，不得假称完成视觉检查。明确说明“已下载并通过结构校验，图片内容尚未视觉核验”，保留待核验状态。不要用自动生成的漂亮图片或旧图掩盖来源失败。

## 文件与交付

每次运行在输出目录下建立独立的 `daily-60s-日期-随机后缀/` 子目录，避免混用旧结果：

- `daily-60s-YYYY-MM-DD.png` 或 `.jpg`：实际图片。
- `source.json`：被接受的原始 JSON，便于核对内容。
- `result.json`：状态、目标日期、来源与实际下载 URL、SHA-256、尺寸和尝试记录。

标准输出也是该结果清单，并包含 `manifest_path`。失败时返回非零退出码，保留 `status: unavailable` 与失败原因，不产生成功图片交付。输入参数错误返回退出码 2。

优先使用执行宿主已有的原生图片附件/文件交付能力，把图片直接展示或附给用户；按宿主要求上传，不假设存在特定平台工具、`sandbox:` 链接或固定目录。无法直接附文件时，说明限制，给出真实本地路径及已验证的来源链接，不能只给链接却声称图片已交付。

最终回复保持简短，例如：“北京时间 YYYY-MM-DD 的每日 60 秒新闻图片，已核对日期与内容。”附图即可，来源链接和结果清单可一并提供或应用户要求提供。不要包含邮件发送、联系人、账户配置、订阅、自动推送或定时调度。

## 离线回归测试

```bash
python -m unittest discover -s tests -v
```

测试使用合成 JSON/图片和内存网络替身，不需要真实账户或个人数据。离线测试不等于当天数据的线上可用性测试。
