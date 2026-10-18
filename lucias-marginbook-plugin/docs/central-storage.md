# MarginBook 集中存储（0.33.0）

集中模式使用 `Lucia's Marginbook/<PDF 来源目录>/<PDF 名称>/`。来源目录默认剥除 `Books/pdf书籍/` 前缀，例如：

```text
Books/pdf书籍/USC/508/作业2.pdf
Lucia's Marginbook/USC/508/作业2/作业2-摘录.md
Lucia's Marginbook/USC/508/作业2/作业2.canvas
Lucia's Marginbook/USC/508/作业2/附件/
```

PDF 保持原位。摘录 ID、页码、批注正文、页内文字块和手写数据不依赖文件搬家。非该前缀下的 PDF 会保留其完整来源目录层级，根目录 PDF 直接使用 `Lucia's Marginbook/<PDF名称>/`，避免不同课程同名资料冲突。

`lmbStoragePaths` 是新建摘录、打开专属画布、Canvas 同步、截图目录和删除清理的统一路径入口。当前 PDF 的摘录命令使用同一入口，不再按全库同名文件猜测。设置保存 `storageLayout`、`storageRoot`、`pdfSourceRoot`、`storageBindings`。

已有多份摘录不自动合并；主文档之外的历史文档保留原内容，归入对应 PDF 的 `历史摘录/`。额外单 PDF 画布保留在 `其他画布/`，跨 PDF 的 MarginBook 画布保留在 `Lucia's Marginbook/综合画布/`。`storageBindings[pdf].canvasDocuments` 保留特定 Canvas 对应的 Markdown 源，Canvas 同步与备注双向编辑遵循该关联，防止历史副本覆盖主文档。与 MarginBook 无关的个人笔记和画布保持原位。

新安装默认使用集中模式；已有配置没有 storageLayout 时继续 legacy，直到明确备份迁移。仅修改设置不会自动移动历史文件。

本次已有 Vault 的迁移在 Obsidian 完全退出后进行：先完整 ZIP 备份并逐文件记录 SHA256，再生成迁移映射，按原位置解析链接、更新 Markdown/Canvas/配置引用。先写并验证新文件，再移除旧路径；失败使用完整备份恢复。画布保留节点与连线及所有布局字段，并更新尺寸哈希、位置缓存，避免重新打开时触发自动排版。工作区、光标记录等本地插件路径缓存一并更新。

验证包括所有原文件的对应与哈希、PDF 不变、附件字节不变、备注/ID 保留、画布布局与连线保留、有效链接迁移前后指向相同对象，以及新建文件的内存模拟。原先已经缺失的文件只记录，不伪造或删除引用；远程同步服务不在离线迁移中调用。

自动检查：`npm run build`、`npm run verify`（包括 `tests/integration/storage.test.js`）。实际 Vault 的备份、迁移清单和检查报告保存在本次任务工作区 `migration-work/`，不打包进插件。

0.33.0：当前库已离线备份并将父目录从 `MarginBook` 改名为 `Lucia's Marginbook`。引用、工作区和插件路径同步更新；对路径变化引起的 Canvas 文本尺寸哈希进行更新，保持卡片几何布局。此次备份与核验报告位于工作区 `marginbook-rename/`。已有其他库的显式 storageRoot 不自动改名。
