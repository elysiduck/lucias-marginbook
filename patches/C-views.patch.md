# 补丁 C：Recall 回忆模式 + 摘录文档直达

目标文件：`pdf-plus-drag-plugin/main.js`（本补丁不改 extractSelection / buildDropText / processCanvas / writeExcerptMd / 设置页其它项）

---

### Edit 1 — onload 初始化 recallMode

锚点（原代码，第 54 行）：**在此行之后插入**

```js
    this.settings = Object.assign({ debug: true }, await this.loadData());
```

插入块：

```js
    // Recall 回忆模式状态（settings.recallDefault = 是否默认开启）
    this.recallMode = !!this.settings.recallDefault;
```

---

### Edit 2 — 注册命令：recall-toggle + open-excerpt-doc

锚点（原代码，第 88–96 行）：**在此块之后插入**（即 rect-select-mode 命令的 `});` 之后、`copy-selection-as-quote` 之前）

```js
    this.addCommand({
      id: "rect-select-mode",
      name: "图片框选模式（下一次拖拽生效）",
      callback: () => {
        this.rectMode = true;
        this.updateRibbonState();
        new Notice("PDF++ Drag: 图片框选模式已开启 —— 在 PDF 上直接拖拽即可（一次性）", 3000);
      }
    });
```

插入块（完整两条命令）：

```js
    // Recall 回忆模式开关：模糊摘录 blockquote，点击揭示（借鉴 MarginNote 4.4）
    this.addCommand({
      id: "recall-toggle",
      name: "回忆模式：开关（模糊摘录，点击揭示）",
      callback: () => {
        try {
          this.recallMode = !this.recallMode;
          if (!this.recallMode) {
            // 关闭时立即清除页面上已模糊的元素（无需等重新渲染）
            document.querySelectorAll(".ppd-recall-blur").forEach((n) => {
              n.classList.remove("ppd-recall-blur", "ppd-recall-reveal");
              if (n._ppdReblurTimer) clearTimeout(n._ppdReblurTimer);
            });
          }
          new Notice(this.recallMode
            ? "回忆模式已开启：摘录已模糊，点击揭示（3 秒后重新模糊）"
            : "回忆模式已关闭", 3000);
        } catch (err) {
          console.warn("[pdf-plus-drag] recall toggle error:", err);
        }
      }
    });

    // 直达当前 PDF 的摘录文档（<PDF名>-摘录.md）
    this.addCommand({
      id: "open-excerpt-doc",
      name: "打开当前 PDF 的摘录文档",
      checkCallback: (checking) => {
        try {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "pdf") return false; // 非活动 PDF 时置灰
          if (checking) return true;
          const md = this.app.vault.getMarkdownFiles()
            .find((f) => f.basename === file.basename + "-摘录.md");
          if (!md) {
            new Notice("尚未生成摘录文档（先拖一条摘录到画布）");
            return true;
          }
          this.app.workspace.openLinkText(md.path, "", false);
          return true;
        } catch (err) {
          console.warn("[pdf-plus-drag] open-excerpt-doc error:", err);
          return false;
        }
      }
    });
```

---

### Edit 3 — 注册 MarkdownPostProcessor（Recall 模糊核心）

锚点（原代码，第 113–114 行）：**在此之后插入**

```js
    this.addSettingTab(new PPDSettingTab(this.app, this));
    this.injectStyles();
```

插入块：

```js
    // Recall：阅读模式下把含「【文件名-P.数字】」回跳链接的 blockquote 模糊化。
    // 揭示策略 = 点击后展示 3 秒自动重新模糊：
    //   ① 单向流程，无"再点一次是隐藏还是保持"的歧义，不易误触；
    //   ② 更贴 Recall 训练节奏（回忆 → 自动再藏）；定时器挂在元素上，重复点击只续期不叠加。
    this.registerMarkdownPostProcessor((el, ctx) => {
      try {
        if (!this.recallMode) return;
        let quotes = el.querySelectorAll ? Array.from(el.querySelectorAll("blockquote")) : [];
        if (el.matches && el.matches("blockquote")) quotes.unshift(el); // 片段本身即 blockquote
        for (const bq of quotes) {
          if (bq.dataset.ppdRecall === "1") continue;                    // 防重复处理
          if (!/【[^】]+-P\.\d+】/.test(bq.textContent || "")) continue;  // 仅命中摘录回跳块
          bq.dataset.ppdRecall = "1";
          bq.classList.add("ppd-recall-blur");
          bq.addEventListener("click", (ev) => {
            ev.stopPropagation();
            bq.classList.add("ppd-recall-reveal");
            clearTimeout(bq._ppdReblurTimer);
            bq._ppdReblurTimer = setTimeout(() => {
              bq.classList.remove("ppd-recall-reveal");
            }, 3000);
          });
        }
      } catch (err) {
        console.warn("[pdf-plus-drag] recall postProcessor error:", err);
      }
    });
```

---

### Edit 4 — injectStyles 追加行清单

锚点（原代码 injectStyles 内的数组末尾）：**在下面两行之后、`].join("");` 之前追加**

```js
      ".pdf-plus-drag-btn.is-active{color:var(--text-on-accent);background:var(--interactive-accent);}",
      ".pdf-plus-drag-btn{cursor:pointer;}"
```

追加的行（逐行插入数组）：

```js
      // ===== Recall 回忆模式 =====
      ".ppd-recall-blur{position:relative;cursor:pointer;}",
      ".ppd-recall-blur>*{filter:blur(6px);transition:filter .25s;}",
      ".ppd-recall-blur.ppd-recall-reveal>*{filter:none;}",
      // ::after 挂在容器上（blur 只作用于子元素 > *，提示本身不会被糊掉）
      ".ppd-recall-blur::after{content:'\\1F50D 点击回忆';position:absolute;top:6px;right:10px;",
      "font-size:11px;line-height:1.4;color:var(--text-muted);",
      "background:var(--background-secondary);border:1px solid var(--background-modifier-border);",
      "border-radius:10px;padding:1px 8px;opacity:.85;pointer-events:none;}",
      ".ppd-recall-blur.ppd-recall-reveal::after{display:none;}"
```

说明：提示文字用 `\1F50D`（🔍）转义写入，避免源码里直接嵌 emoji；`pointer-events:none` 保证点击穿透到 blockquote。

---

### Edit 5 — saveSettings 增量

锚点（原代码，第 141 行）：**在此行之后插入**

```js
    const obj = { debug: this.settings.debug };
```

插入块：

```js
    obj.recallDefault = !!this.settings.recallDefault; // 补丁 C：回忆模式默认值
```

---

### Edit 6 — 设置页增量（display 内追加，不整体替换）

锚点（PPDSettingTab.display() 内，调试提示 Setting 的结尾）：**在此块之后追加**

```js
    new Setting(containerEl)
      .setName("调试提示（Notice）")
      .setDesc("在屏幕上显示每一步检测结果，用于定位问题。稳定后可关闭。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.debug)
        .onChange(async (v) => { this.plugin.settings.debug = v; await this.plugin.saveSettings(); }));
```

插入块：

```js
    // 补丁 C：回忆模式默认开启
    new Setting(containerEl)
      .setName("回忆模式默认开启")
      .setDesc("插件加载时自动开启回忆模式（阅读模式中模糊摘录，点击揭示）。")
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.recallDefault)
        .onChange(async (v) => { this.plugin.settings.recallDefault = v; await this.plugin.saveSettings(); }));
```

---

## 集成注意

1. **接口隔离**：本补丁不触碰 `extractSelection` / `buildDropText` / `processCanvas` / `writeExcerptMd` / 框选与拖拽链路；只新增状态位 `recallMode`、两条命令、一个 postProcessor、CSS 追加行、`settings.recallDefault` 一个字段。与其它补丁合入时仅注意 saveSettings 和 display() 是共享增量区，按锚点顺序插入即可。
2. **摘录文档命名**：命令按 `basename === pdfBase + "-摘录.md"` 全库匹配，与 `writeExcerptMd` 的命名规则一致；若库里有同名不同目录的摘录文档，取第一个匹配（Obsidian 依赖内可接受）。
3. **活动 PDF 判定**：用 `app.workspace.getActiveFile().extension === "pdf"`，比遍历 `getLeavesOfType("pdf")` 对 containerEl 更可靠（activeLeaf 已废弃）。
4. **Recall 已知边界**：
   - 仅 reading mode 生效（MarkdownPostProcessor 不跑在 live preview 的源码/预览混排上）；live preview 需挂 editor 扩展，风险大，明确不做。
   - 开启开关后**已渲染**的笔记要等重新渲染（切走再切回 / 重开笔记）才会模糊；关闭开关则即时清除全部模糊（命令里已处理）。
   - callout 渲染产物不是 `blockquote`（是 `.callout` div），天然不误伤；普通引用块因不含「-P.数字】」特征也不会命中。
5. **防重复**：postProcessor 可能对同一片段多次回调（如局部重渲染），用 `dataset.ppdRecall` 标记 + click 监听只绑一次。
6. **零依赖**：全部原生 DOM API + Obsidian 公开接口，try/catch 降级，console 前缀 `[pdf-plus-drag]`。
