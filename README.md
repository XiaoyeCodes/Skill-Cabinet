<div align="center">

<img src="docs/brand.svg" alt="Skill Cabinet" width="100%" />

### 让好方法，成为你的拿手好戏。

给每一份灵感一个位置。收藏、整理和复用你的专属 Skill。

![JavaScript](https://img.shields.io/badge/JavaScript-ES_Modules-c16b50?style=flat-square)
![Local First](https://img.shields.io/badge/Storage-IndexedDB-8b947b?style=flat-square)
![No Build](https://img.shields.io/badge/Build-无需构建-b39a78?style=flat-square)
![Skills](https://img.shields.io/badge/Skills-3-817a95?style=flat-square)

[项目预览](#项目预览) · [快速开始](#快速开始) · [技能收藏](#技能收藏) · [GitHub 云同步](#github-云同步)

</div>

---

**Skill Cabinet 是一个轻量的个人 AI 技能管理页面。** 把散落在文件夹里的 SKILL.md、使用说明、脚本和参考图片收进同一个书架，按分类找到它们，继续打磨，再导出成完整技能包。

界面借鉴 Anthropic 的暖白纸面、陶土色强调和衬线排版，使用独立标识与自制 SVG 插图。纯 HTML、CSS 和 JavaScript，启动项目不需要安装 npm 依赖。

## 项目预览

下面是实际运行截图，展示当前收藏的三份 Skill。

<img src="docs/screenshots/library.jpg" alt="Skill Cabinet 首页，展示每日 60 秒新闻图片、AIBase 日报和拾光百科图文三个 Skill" width="100%" />

<details>
<summary><strong>展开查看 · 技能详情与完整文件清单</strong></summary>

<br>
<img src="docs/screenshots/skill-files.jpg" alt="每日 60 秒新闻图片 Skill 的详情与六个完整附件" width="100%" />

</details>

## 能做什么

| 收藏 | 整理 | 使用与迁移 |
| :--- | :--- | :--- |
| 导入 ZIP 技能包、SKILL.md | 分类、标签、收藏 | 查看功能与 Markdown 指令 |
| 拖拽文件导入 | 名称、描述、标签搜索 | 复制最新指令 |
| 新建或编辑 Skill | 最近更新、名称排序 | 预览参考图片与文本文件 |
| 保留脚本、图片及参考资料 | 网格与列表视图 | 单个技能导出、全库备份恢复 |

导入的 Skill 作为文件内容保存。包内脚本仅用于阅读与导出，管理页面不会执行这些脚本。

## 快速开始

需要 **Node.js 20 或更新版本**。

```bash
git clone https://github.com/XiaoyeCodes/Skill-Cabinet.git
cd Skill-Cabinet
npm start
```

打开 [http://localhost:4173](http://localhost:4173)。首次启动会自动加入本仓库的三份 Skill，之后的修改保存在当前浏览器。

```bash
# 运行核心行为测试
npm test
```

无需执行 `npm install`。ZIP 引擎 JSZip 已随项目附带；字体无法在线加载时会使用系统字体。请通过 HTTP 服务打开页面，避免直接双击 HTML 带来的模块与资源访问限制。

## 技能收藏

三份完整技能包已随仓库提交，保留 **37 个原始文件**。下面的链接分别提供可阅读的源码和可直接导入的原始 ZIP。

| Skill | 能力 | 原始文件 | 文件与下载 |
| :--- | :--- | :---: | :--- |
| **拾光百科图文** | 按主题队列制作博物志科普图文，包含参考图、文案与质量核验流程 | 21 | [查看 Skill](skills/shiguang-atlas/SKILL.md) · [完整 ZIP](dist/assets/shiguang-atlas.zip) |
| **AIBase 日报** | 把 AIBase 日报整理为米白色 HTML、纯文本和提取 JSON | 10 | [查看 Skill](skills/aibase-daily/SKILL.md) · [完整 ZIP](dist/assets/aibase-daily.zip) |
| **每日 60 秒新闻图片** | 获取指定日期的新闻原图，校验日期与文件，并保留下载记录 | 6 | [查看 Skill](skills/daily-60s-image/SKILL.md) · [完整 ZIP](dist/assets/daily-60s-image.zip) |

**一次收好全部三份：** [下载初始技能库备份](backups/skill-cabinet-starter.zip)，在页面中点击「导入 Skill」选择该 ZIP，即可加入三份技能。已存在的标识会跳过，并提示保留已有内容。

原始 ZIP 保持原样；`skills/` 中的可读版本同步了展示名称和分类。压缩包外层的使用说明、测试记录和样例也保留在对应目录中。原始文件校验值见 [技能目录清单](docs/skill-catalog.json)。

> Skill Cabinet 负责管理文件。实际调用这些 Skill 时，仍需要能理解 Skill 指令的 AI 工具，以及对应技能声明的运行环境。图像生成等能力由调用宿主提供。

## 如何使用

**导入** → 点击「导入 Skill」，或把完整 ZIP / SKILL.md 拖进页面。完整包中的图片和脚本会一起保存。

**整理** → 设置名称、功能介绍、使用说明、分类与标签。常用技能点击星标收藏，搜索框支持 `/` 快捷聚焦。

**打磨** → 在详情页编辑指令和说明。复制、文件预览和导出时会使用最新内容；英文技能标识与中文展示名称分别保存。

**带走** → 导出单个 Skill 交给其他工具，或点击右上角「导出仓库」保存全部内容。

## GitHub 云同步

连接一次，让书架随设备同行。导入、编辑、收藏和删除先保存到本机，默认在停止修改约 **3 秒后**与仓库同步；联网恢复或重新回到页面时也会检查。页面关闭后不会后台运行，未完成时可再次打开并点击「立即同步 / 恢复」。

1. 打开侧栏 **GitHub 云同步**，填写仓库 `XiaoyeCodes/Skill-Cabinet` 和分支 `main`。
2. 在 [GitHub 创建 fine-grained personal access token](https://github.com/settings/personal-access-tokens/new)，只选择目标仓库，将 **Contents → Read and write**，设置有效期。
3. 在页面输入令牌，点击 **连接并同步**。默认只保存到当前标签页会话；自己的设备可主动勾选「记住此浏览器」。
4. 换设备后打开同一页面，连接相同仓库和分支，点击 **立即同步 / 恢复**。技能正文、说明、分类、标签、收藏及完整附件都会恢复。

令牌直接发送到固定的 GitHub API 地址，不写入技能、ZIP、仓库或备份。断开连接会移除本浏览器保存的令牌；如需彻底撤销授权，也可在 GitHub 删除该令牌。令牌到期后需重新连接。

| 同步情况 | 处理方式 |
| :--- | :--- |
| 只有一台设备修改 | 自动合并并上传 / 下载 |
| 两台设备修改同一个 Skill | 暂停同步，逐项选择本机或 GitHub 版本，没有默认覆盖 |
| 一台编辑、另一台删除 | 同样作为冲突处理 |
| 离线、授权过期、仓库规则拒绝写入 | 保留本机数据并显示原因，可重新连接或重试 |
| 从云端恢复或删除本机内容 | 先保存整库快照，可在设置下载「最近一次恢复前备份」 |

同步数据保存在独立的 `skill-cabinet/manifest.json` 与 `skill-cabinet/archives/*.zip`，不会重写项目代码或 `skills/` 的展示快照。删除以清单记录同步，旧归档保留在 Git 历史中。只上传内容变化的技能包。

**本仓库目前为公开仓库，上传的技能与附件任何人都可读取。** 私人内容可改连自己的私有仓库。同步单技能 ZIP 上限为 **45 MiB**；本机导入仍按下方限制执行。尚未使用的空分类、页面排序和搜索条件属于设备偏好，不同步。

## 数据与备份

**浏览器 IndexedDB 保存本机副本；启用 GitHub 同步后，仓库保存完整云端副本。同步状态显示「已同步」后，才能在其他设备恢复最新修改。**

| 发生的操作 | 已导入的数据 |
| :--- | :--- |
| 删除电脑上的原始 ZIP | 保留，文件内容已复制到数据库 |
| 刷新页面、关闭页面或重启电脑 | 同一浏览器和站点地址下保留 |
| 换浏览器、设备或站点地址 | 连接同一 GitHub 仓库恢复，或导入 ZIP 备份 |
| 清除这个网站的站点数据 | 本地记录和令牌被清除，可重新连接 GitHub 或用备份恢复 |

全库备份包含技能元数据和完整文件包，可独立于 GitHub 保存和恢复。新建但尚未使用的自定义分类属于浏览器设置，不包含在技能备份中。

初始技能只在首次初始化时加入。用户主动删除后，刷新不会重新补回；已使用过旧版本的浏览器，可导入上面的初始技能库备份补充另外两份。

## 项目结构

```text
Skill-Cabinet/
├── dist/                     # 可直接部署的静态应用
│   ├── index.html            # 页面、表单与对话框
│   ├── style.css             # 暖白纸面视觉与响应式样式
│   ├── app.js                # 交互、搜索和安全文本阅读
│   ├── storage.js            # IndexedDB、导入导出与备份
│   ├── github-client.js      # GitHub API 与非强制提交
│   ├── sync-engine.js        # 三方合并、校验和恢复
│   ├── sync-ui.js / sync.css # 连接、状态与冲突处理
│   ├── assets/               # 三份完整 ZIP 与初始化目录
│   └── vendor/               # 随包 JSZip
├── skills/                   # 三份 Skill 的可读完整目录
├── backups/                  # 可直接导入的初始技能库备份
├── docs/                     # 项目截图、品牌图与文件校验清单
├── scripts/prepare-skills.mjs # 从原始 ZIP 重新整理技能目录
├── tests/storage.test.mjs     # 核心行为测试
├── server.mjs                # 本地静态 HTTP 服务
└── package.json
```

## 技术与边界

- **前端**：HTML / CSS / 原生 ES Modules，无框架构建步骤。
- **持久化**：IndexedDB 保存技能正文与附件 Blob；本地设置使用 localStorage。
- **压缩包**：JSZip 3.10.1，MIT / GPLv3 双许可，详见文件头及 [JSZip 项目](https://github.com/Stuk/jszip)。
- **导入限制**：单文件 50 MiB、解压总量 200 MiB、最多 3000 个条目；检查危险路径、重复标识和无效内容。
- **部署**：`dist/` 可由静态 HTTP 服务托管；当前示例站点的访问控制由托管平台提供，应用本身不包含账号后端。

同步使用 GitHub REST / Git Data API；分支更新仅允许快进，不强制覆盖。云端文件使用 SHA-256 校验，批量恢复与同步基线在同一 IndexedDB 事务中提交。测试覆盖双设备同步、删除冲突、离线重试、上传期间本机编辑、事务回滚和文件篡改。

---

<div align="center">
<sub>YOUR SKILLS. YOUR POSSIBILITIES.</sub><br>
<sub>留住一次灵感，开启更多可能。</sub>
</div>
