---
name: "agentic-awesome-skills"
display_name: "Agentic Awesome Skills · 智能体技能库"
description: "收录 Agentic Awesome Skills 的 2,872 份技能与完整附件，覆盖开发、设计、智能体、数据、自动化、测试和运维；先检索目录、检查完整技能文件，再按任务选用。完整上游技能目录保存在内嵌 tar.xz 中。"
version: "20.1.0"
author: "sickn33 与社区贡献者"
tags: ["智能体","技能库","开发","自动化","Codex","Claude Code"]
category: "开发与工具"
---

# Agentic Awesome Skills · 智能体技能库

来源：[sickn33/agentic-awesome-skills](https://github.com/sickn33/agentic-awesome-skills/tree/0f1aef1eb17611d3219c713ea615ecdc7080896c)，固定快照版本为 20.1.0。

这是一个收藏与检索入口。先明确任务，在 `catalog.json` 或 `upstream/CATALOG.md` 中检索候选，再阅读选定技能的完整文件。

## 按需使用

1. 根据任务在目录中检索名称、描述与分类，列出相关候选。
2. 将 `library/agentic-skills.tar.xz` 解压到新建的空目录。内嵌包保留完整上游 `skills/` 目录及来源、许可资料，附带的 `UPSTREAM_FILES.json` 记录逐文件摘要。解压方法见 `使用说明.md`。
3. 根据 `catalog.json` 中的路径找到候选的 `SKILL.md`，同时检查其脚本、参考文档、依赖、许可证和权限需求。
4. 选择确实需要的技能，将对应完整文件夹放入目标工具支持的技能目录，或直接让 AI 阅读该文件夹。
5. 在实际项目中验证结果。目录内的风险标签属于上游元数据，不能替代文件检查。

本收藏包没有包含上游 npm 安装器或 AAS Core 的可执行发行包；需要这些工具时按 `upstream/docs/users/` 中的固定版本说明获取。日常按需阅读与复制技能文件不需要运行安装器。

## 文件索引

- `catalog.json`：完整上游技能索引，含名称、描述、分类和路径。
- `upstream/CATALOG.md`：适合全文搜索的 Markdown 目录。
- `library/agentic-skills.tar.xz`：完整技能正文及全部附属文件。
- `upstream/README.md`：上游项目说明。
- `upstream/docs/users/`：入门、Codex、Claude Code、AAS Core 与安全说明。
- `upstream/docs/sources/`、`LICENSE`、`LICENSE-CONTENT`：来源署名、代码与内容许可；各技能自身许可同时保存在内嵌包中。
- `CABINET_SOURCE.json`：固定提交、文件摘要、目录数量与打包范围。
- `VETTING.md`：静态检查范围及已知上游别名情况。
- `使用说明.md`：在 Skill Cabinet 中查看和导出的方法。

需要直接在线核对某份技能时，使用固定快照下的 `skills/<技能路径>/SKILL.md`，避免混用其他版本的附件。
