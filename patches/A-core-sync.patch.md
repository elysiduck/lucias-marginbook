# 补丁 A：同步核心改造（pdf-plus-drag-plugin/main.js）

> 目标文件：`C:\Users\13567\WorkBuddy\pdf++\pdf-plus-drag-plugin\main.js`
> 对应 MarginNote 4 调查报告：P0-1（exId 内容寻址）+ P1-3（摘录按页归位，免费达成 P2-7 大纲视图）
> 约束：纯 CommonJS、零外部依赖、所有新逻辑 try/catch 优雅降级、console 前缀 `[pdf-plus-drag]`、中文注释。
> 本补丁 **不改** extractSelection / buildSelectionParams / 设置页 / injectStyles / onload，不新增 require。

---

### Edit 1: 新增 `contentExId(info)` 方法（内容寻址 exId，P0-1 核心）

**操作**：在现有 `buildDropText(info)` 方法（原 main.js 第 441 行起）的**上方**插入以下完整新方法。

**锚点（插入位置参照，即 buildDropText 原方法首行之前）**：

```js
  buildDropText(info) {
    const exId = "ex-" + Math.random().toString(36).slice(2, 8);
```

**插入为（新方法，插在 buildDropText 之前）**：

```js
  /**
   * 内容寻址 exId（P0-1）：同一选区重复拖拽 → 同一 ^ex id → 引用计数正确、天然去重。
   * 哈希基底：
   *   - 图片选区（isImage）：attachmentName（内含时间戳+随机戳，每张截图天然唯一）
   *   - 文字选区：file.path | pageNum | selectionParams（补丁 B 注入；未注入时回退 text）
   * 复用 simpleHash（带符号 int32）：>>>0 转无符号后对 36^6 取模，保证恰好 6 位
   * base36 小写字母数字，稳定匹配 EX_ID_RE = /\^ex-[0-9a-z]{4,8}/。
   */
  contentExId(info) {
    try {
      const MOD36_6 = 2176782336; // 36^6
      const key = (info && info.isImage && info.attachmentName)
        ? "img|" + String(info.attachmentName)
        : [
            (info && info.file && info.file.path) ? info.file.path : "?",
            (info && info.pageNum != null) ? String(info.pageNum) : "?",
            String((info && (info.selectionParams || info.text)) || "")
          ].join("|");
      const signed = parseInt(this.simpleHash(key), 10) | 0;
      const u = (signed >>> 0) % MOD36_6;
      return "ex-" + u.toString(36).padStart(6, "0");
    } catch (err) {
      // 优雅降级：任何异常回退随机 id（仅损失去重能力，不影响功能）
      console.warn("[pdf-plus-drag] contentExId 降级为随机 id:", err);
      return "ex-" + Math.random().toString(36).slice(2, 8);
    }
  }

```

---

### Edit 2: 替换 `buildDropText`（改用 contentExId + 预留 colorTag 行）

**操作**：整方法替换。

**锚点（原方法完整代码）**：

```js
  buildDropText(info) {
    const exId = "ex-" + Math.random().toString(36).slice(2, 8);
    if (info.isImage) {
      return info.embed + "\n> (" + info.link + ")\n^" + exId;
    }
    return "> (" + info.link + ")\n> " + info.text + "\n^" + exId;
  }
```

**替换为**：

```js
  buildDropText(info) {
    try {
      const exId = this.contentExId(info);
      // 颜色语义标签行（由补丁 B 的 extractSelection 注入 info.colorTag，非空才输出），
      // 位于 ^ex 行之前；info.colorTag 不存在/为空时行为与旧版完全一致。
      const tagLine = (info && info.colorTag) ? "\n> #" + info.colorTag : "";
      if (info.isImage) {
        return info.embed + "\n> (" + info.link + ")" + tagLine + "\n^" + exId;
      }
      return "> (" + info.link + ")\n> " + info.text + tagLine + "\n^" + exId;
    } catch (err) {
      console.error("[pdf-plus-drag] buildDropText error:", err);
      // 降级：恢复旧版随机 id 行为
      const exId = "ex-" + Math.random().toString(36).slice(2, 8);
      if (info.isImage) {
        return info.embed + "\n> (" + info.link + ")\n^" + exId;
      }
      return "> (" + info.link + ")\n> " + info.text + "\n^" + exId;
    }
  }
```

---

### Edit 3: 替换 `processCanvas`（按 id 去重 + 提取页码 entry.page）

**操作**：整方法替换。改动点：
1. 构建 byPdf 时用 `seenIds` 集合按 id 去重，同一 id 只保留 canvas 顺序中的第一个节点，重复时 console.log 提示；
2. 从节点回跳链接提取 `#page=(\d+)` → `entry.page`（提取失败为 null；只匹配 ASCII 数字，对中文文件名/中文摘录文本无副作用）；
3. 逐 PDF 写入套 try/catch，单个 PDF 失败不阻断其余同步。

**锚点（原方法完整代码）**：

```js
  async processCanvas(cf) {
    const raw = await this.app.vault.read(cf);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    const nodes = data.nodes || [];

    let changed = false;
    let store = this.autoSize.get(cf.path);
    if (!store) { store = new Map(); this.autoSize.set(cf.path, store); }
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const fitted = this.fitNode(node, store);
      if (fitted) {
        node.width = Math.round(fitted.w);
        node.height = Math.round(fitted.h);
        changed = true;
        console.log("[pdf-plus-drag] node resized:", node.id, node.width + "x" + node.height);
      }
    }
    if (changed) {
      const indent = /\n\t"/.test(raw) ? "\t" : "  ";
      this.selfWritten.set(cf.path, true);
      try {
        await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
      } catch (err) {
        this.selfWritten.delete(cf.path);
        console.error("[pdf-plus-drag] canvas resize write failed:", err);
      }
    }

    const byPdf = new Map();
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const pm = node.text.match(/\[\[([^\]#|]+\.pdf)/i);
      if (!pm) continue;
      const pdfPath = pm[1].trim();
      const body = node.text
        .split("\n")
        .filter((l) => !/^\s*\^ex-[0-9a-z]{4,8}\s*$/.test(l))
        .join("\n")
        .trim();
      const id = node.text.match(EX_ID_RE)[0].slice(1);
      if (!byPdf.has(pdfPath)) byPdf.set(pdfPath, []);
      byPdf.get(pdfPath).push({ id, body });
    }
    for (const [pdfPath, entries] of byPdf) {
      await this.writeExcerptMd(cf, pdfPath, entries);
    }
  }
```

**替换为**：

```js
  async processCanvas(cf) {
    const raw = await this.app.vault.read(cf);
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    const nodes = data.nodes || [];

    let changed = false;
    let store = this.autoSize.get(cf.path);
    if (!store) { store = new Map(); this.autoSize.set(cf.path, store); }
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const fitted = this.fitNode(node, store);
      if (fitted) {
        node.width = Math.round(fitted.w);
        node.height = Math.round(fitted.h);
        changed = true;
        console.log("[pdf-plus-drag] node resized:", node.id, node.width + "x" + node.height);
      }
    }
    if (changed) {
      const indent = /\n\t"/.test(raw) ? "\t" : "  ";
      this.selfWritten.set(cf.path, true);
      try {
        await this.app.vault.adapter.write(cf.path, JSON.stringify(data, null, indent));
      } catch (err) {
        this.selfWritten.delete(cf.path);
        console.error("[pdf-plus-drag] canvas resize write failed:", err);
      }
    }

    const byPdf = new Map();
    const seenIds = new Set(); // 卡片级去重：同一 ^ex id 只保留 canvas 顺序中的第一个节点
    for (const node of nodes) {
      if (node.type !== "text" || !node.text || !EX_ID_RE.test(node.text)) continue;
      const pm = node.text.match(/\[\[([^\]#|]+\.pdf)/i);
      if (!pm) continue;
      const pdfPath = pm[1].trim();
      const id = node.text.match(EX_ID_RE)[0].slice(1);
      if (seenIds.has(id)) {
        // 同一选区重复拖拽产生的内容寻址重复卡：md 只收一条，canvas 原卡保留不动
        console.log("[pdf-plus-drag] canvas 卡按 id 去重:", id, "（重复卡片，仅保留首个）");
        continue;
      }
      seenIds.add(id);
      const body = node.text
        .split("\n")
        .filter((l) => !/^\s*\^ex-[0-9a-z]{4,8}\s*$/.test(l))
        .join("\n")
        .trim();
      // 回跳链接页码（P1-3）：#page=12 → entry.page；提取失败为 null（归入「未定位」）
      // 仅匹配 ASCII 数字，对中文文件名 / 中文摘录文本无副作用
      const pgm = node.text.match(/#page=(\d+)/);
      const page = pgm ? parseInt(pgm[1], 10) : null;
      if (!byPdf.has(pdfPath)) byPdf.set(pdfPath, []);
      byPdf.get(pdfPath).push({ id, body, page });
    }
    for (const [pdfPath, entries] of byPdf) {
      try {
        await this.writeExcerptMd(cf, pdfPath, entries);
      } catch (err) {
        // 单个 PDF 的摘录文档写入失败不阻断其它 PDF 的同步
        console.error("[pdf-plus-drag] excerpt sync failed for", pdfPath, err);
      }
    }
  }
```

---

### Edit 4: 替换 `writeExcerptMd`（按页分组 + updated 时间戳）

**操作**：整方法替换。改动点：
1. 条目按 `entry.page` 数字升序分组（ES2019+ sort 稳定，同页保持 canvas 顺序），每组输出 `## P.<N>`；null 页归入 `## 未定位` 且仅当存在 null 条目时输出、置于文末 → Obsidian 核心大纲插件自动获得摘录大纲（P2-7）；
2. frontmatter 增加 `updated: "<ISO时间>"`，仅在内容实际变化时刷新（比较时剔除时间戳行，避免无意义重写）；
3. 保留已知边界：**整文件重写会覆盖用户对摘录 md 的手工修改 —— 本补丁不解决**。

**锚点（原方法完整代码）**：

```js
  async writeExcerptMd(cf, pdfPath, entries) {
    const pdfBase = pdfPath.split("/").pop().replace(/\.pdf$/i, "");
    const folder = cf.parent && cf.parent.path ? cf.parent.path : "/";
    const mdPath = normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");

    let content = "---\nPDF: \"[[" + pdfPath + "]]\"\ncanvas: \"[[" + cf.basename + "]]\"\n---\n\n";
    for (const en of entries) {
      content += en.body + "\n^" + en.id + "\n\n";
    }

    const existing = this.app.vault.getAbstractFileByPath(mdPath);
    if (existing instanceof TFile) {
      const cur = await this.app.vault.read(existing);
      if (cur !== content) {
        await this.app.vault.process(existing, () => content);
        console.log("[pdf-plus-drag] excerpt doc updated:", mdPath);
      }
    } else {
      await this.app.vault.create(mdPath, content);
      new Notice("PDF++ Drag: 已创建摘录文档 " + mdPath);
      console.log("[pdf-plus-drag] excerpt doc created:", mdPath);
    }
  }
```

**替换为**：

```js
  /**
   * 摘录文档写入（P1-3 按页分组版）。
   * 已知边界（保留，不解决）：整文件重写，用户对摘录 md 的手工修改会被覆盖。
   * 结构：frontmatter（PDF / canvas / updated）+ 按页分组的摘录：
   *   ## P.<N>   ← 页码数字升序，同页条目按 canvas 顺序（稳定排序）
   *   ## 未定位  ← 仅当存在无页码条目时输出，置于文末
   * 大纲插件可直接把 ## P.<N> 当作摘录大纲（P2-7 免费达成）。
   * updated 仅在内容实际变化时刷新：比较时剔除时间戳行，避免无意义全量重写。
   */
  async writeExcerptMd(cf, pdfPath, entries) {
    try {
      const pdfBase = pdfPath.split("/").pop().replace(/\.pdf$/i, "");
      const folder = cf.parent && cf.parent.path ? cf.parent.path : "/";
      const mdPath = normalizePath(folder === "/" ? pdfBase + "-摘录.md" : folder + "/" + pdfBase + "-摘录.md");

      // 按页排序：有页码的数字升序（稳定排序，同页保持 canvas 顺序），无页码的排最后
      const withPage = [];
      const noPage = [];
      for (const en of entries) {
        (en.page != null ? withPage : noPage).push(en);
      }
      withPage.sort((a, b) => a.page - b.page);
      const ordered = withPage.concat(noPage);

      // 按页分组拼接正文
      let body = "";
      let lastKey = null;
      for (const en of ordered) {
        const key = en.page != null ? "P." + en.page : "未定位";
        if (key !== lastKey) {
          body += "## " + key + "\n\n";
          lastKey = key;
        }
        body += en.body + "\n^" + en.id + "\n\n";
      }

      const head = "---\nPDF: \"[[" + pdfPath + "]]\"\ncanvas: \"[[" + cf.basename + "]]\"\n";
      // 不含 updated 时间戳的基准内容（用于变化检测）
      const bodyNoStamp = head + "---\n\n" + body;

      const existing = this.app.vault.getAbstractFileByPath(mdPath);
      if (existing instanceof TFile) {
        const cur = await this.app.vault.read(existing);
        const curNoStamp = cur.replace(/^updated: "[^"]*"\r?\n/m, "");
        if (curNoStamp !== bodyNoStamp) {
          const content = head + "updated: \"" + new Date().toISOString() + "\"\n---\n\n" + body;
          await this.app.vault.process(existing, () => content);
          console.log("[pdf-plus-drag] excerpt doc updated:", mdPath);
        }
      } else {
        const content = head + "updated: \"" + new Date().toISOString() + "\"\n---\n\n" + body;
        await this.app.vault.create(mdPath, content);
        new Notice("PDF++ Drag: 已创建摘录文档 " + mdPath);
        console.log("[pdf-plus-drag] excerpt doc created:", mdPath);
      }
    } catch (err) {
      console.error("[pdf-plus-drag] writeExcerptMd error:", err);
    }
  }
```

---

### Edit 5: 集成注意（与其它补丁的接口）

1. **接口：`info.colorTag`（消费方 = 本补丁）**
   - 本补丁的 `buildDropText` 读取 `info.colorTag`：非空字符串时在 `^ex` 行之前插入一行 `\n> #<colorTag>`；为 `undefined`/`null`/空串时输出与旧版逐字节一致。
   - **注入方 = 补丁 B**：由补丁 B 修改 `extractSelection`（及图片路径如需）向返回的 info 对象追加 `colorTag` 字段。本补丁不改 `extractSelection`。
   - 消费顺序无依赖：本补丁对 `colorTag` 做真值判断，补丁 B 未安装时零影响。
2. **接口：`info.selectionParams`（可选增强）**
   - `contentExId` 的哈希基底优先取 `info.selectionParams`（补丁 B 若注入此字段，可让「同页同文字但不同位置」的选区获得不同 id）；未注入时回退 `info.text`（空白归一化后的选区文本），同一选区仍稳定同 id。
3. **互不触碰的边界**：本补丁不改 `extractSelection`、`buildSelectionParams`、设置页（PPDSettingTab）、`injectStyles`、`onload`，不新增任何 require，不修改样式。补丁 B / C 与本补丁的改动无行级重叠（本补丁仅覆盖 `buildDropText`、`processCanvas`、`writeExcerptMd` 三个整方法 + 新增 `contentExId` 一个方法）。
4. **旧数据兼容**：已存在的 canvas 卡（随机 id）不受影响——哈希 id 只在**新拖拽**时生成；旧卡片在 md 中原样保留，直到用户重新拖拽。
5. **升级一次性影响**：首次应用本补丁后，摘录 md 结构从「平铺」变为「按页分组 + updated 字段」，下次 canvas 触发同步时会全量重写一次（`updated` 时间戳随之生成），属预期行为。

---

## 附：风险清单

- **哈希碰撞**：6 位 base36 ≈ 21.8 亿空间；摘录量数百级时碰撞概率可忽略。极端碰撞后果 = 两条不同摘录被当作重复而只保留一条（低概率、低损失）。
- **内容寻址语义**：同页、归一化文本完全相同的两个**不同**选区（补丁 B 未注入 selectionParams 时）会共享同一 id → 视为同一摘录。这是内容寻址的设计内行为（去重优先）。
- **canvas 重复卡不清理**：去重只作用于 md 输出，canvas 上的重复卡片仍由用户手动删除（保持 canvas 主本原则，不越权改用户画布内容）。
- **updated 与变化检测**：比较时剔除 `updated:` 行，避免时间戳自激重写；但外部工具若以其它格式写时间戳行，可能触发一次额外全量重写（无害）。
