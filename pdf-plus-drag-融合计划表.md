# pdf-plus-drag × PDF Flow 融合计划表

> 目标：把 PDF Flow 的「摘录 → 索引 → 回绘 → 跳转」闭环补进 pdf-plus-drag v0.8.4，
> 让它能独立顶替 PDF Flow（现在 vault 里跑的是 PDF Flow，你自己的插件处于未启用状态）。
> 制定日期：2026-09-02　基线：`pdf-plus-drag-plugin/main.js` 2394 行，单文件，无构建步骤

---

## 0. 先决决策（2026-09-02 已拍板）

| # | 决策 | 结论 |
|---|---|---|
| **D1** | `selection=` 参数的解析权 | ✅ **自管**，不依赖 pdf-plus |
| **D2** | 代码组织 | ✅ **保持单文件**，P5 再决定拆不拆 |
| **D3** | PDF Flow 存量摘录迁移 | ✅ **放 P6，可选** |

---

## 0.5 执行记录

### 2026-09-02

#### P0 实测：全绿（诊断脚本迭代 7 版，v1 → v7）

| 项 | 结果 | 关键数据 |
|---|---|---|
| **P0-1 测试基线** | ✅ | 247 通过 / 0 失败 |
| **P0-2a 重渲染稳定性** | ✅ **PASS** | 第 1 页 textLayer 销毁重建后 `direct:120`、前 10 span 指纹完全一致 |
| **P0-2b 缩放稳定性** | ✅ **PASS** | 五档（0.5 / 1 / 2 / page-fit / page-width）全部 `direct:120`，指纹一致 |
| **P0-3 口径选择** | ✅ **沿用现有** | `ratio 0.95`，且 `direct 506 > positioned 482` → 现有口径覆盖更全 |
| **P0-4 block id 定位** | ✅ PASS | `openLinkText('…-摘录.md#^ex-9jjqn8')` 成功打开并定位 |
| 逆运算往返（加测） | ✅ PASS | `[5,1,8,4]` → 6 矩形，bbox 误差 < 6px |

诊断过程中踩的三个坑（已写进 memory 与 skill）：
1. **僵尸标签页** —— Obsidian 恢复布局后 leaf 有 `state.file` 但容器全空，
   `setActiveLeaf` 救不回来，必须用 `getLeaf(true) + openFile()` 新开。
2. **嵌套层级** —— `viewer.pdfViewer` 是**应用级包装器**（58 个自有属性），
   真正的 pdf.js PDFViewer 在 **`viewer.pdfViewer.pdfViewer`**（多一层），
   `currentScaleValue` 在那里（值 `page-width`），`currentScale` 也在（`0.4649`）。
3. **不能用 `obj.x === undefined` 推「x 不存在」** —— 这条我错了两次。

#### P1 索引层：已完成并同步到 vault

- 新增常量 `PPD_LINK_RE` / `PPD_SEL_RE`
- 新增**模块级纯函数** `ppdParseExcerptDoc(content, sourcePath)`（挂 `__test`，可离线测）
- 新增方法：`buildExcerptIndex` / `reindexFile` / `dropFileFromIndex` /
  `getExcerptsForPdf` / `getIndexStats` / `ppdIndexCandidates` / `ppdFileLinksPdf`
- 新增命令：`ppd-rebuild-index`（重建摘录索引）/ `ppd-index-stats`（显示索引统计）
- `onload` 初始化两个 Map + 注册 `modify/create/delete` 增量维护 + `onLayoutReady` 全量构建
- 测试新增 **D 组 47 项**，全绿

**顺带修掉一个隐藏问题**：测试文件 779 行有一个**提前的 `process.exit()`**，
导致后面的 **P / Q / R 三组共 33 个测试从来没执行过**。移除截断后它们首次运行，
暴露出 5 个陈旧断言（P1.3 / P1.4 / P1.6 / P2.2 / P3.1 断言的是 v0.8.3 已删除的
HTML 注释锚点格式，且与 Q1.4 / R2.1 直接矛盾）。已按 v0.8.3+ 行为修正，**未改 main.js**。

**当前测试总数：327 通过 / 0 失败**（原 247）。

#### P2 回绘层：已完成并同步到 vault

- 样式注入：`div[data-type="pdf"] .page{position:relative !important}` +
  `.ppd-mark` 绝对定位 + `data-fallback="1"` 降级条样式
- 方法：`ppdResolveSelectionRects`（逆运算，P0 验证过误差 <6px）/
  `ppdRectsToPercents`（百分比换算）/ `ppdMarkColor`（colorMap 反查 tag→色）/
  `ppdDrawEntryMark` / `ppdDrawMarksForView` / `ppdClearMarks` /
  `ppdSetupObserver` / `ppdDisconnectObserver` / `ppdRefreshAllMarks` /
  `ppdScheduleMarksRefresh` / `ppdPageNearViewport` / `ppdHexToRgba`
- 命令：`ppd-refresh-marks`（强制刷新摘录标记）
- 触发时机：`file-open`（等 300ms）+ `layout-change` + `active-leaf-change` +
  **MutationObserver**（subtree，应对 pdf.js 虚拟化）+ 索引更新后
- **降级原则**（比 PDF Flow 好）：span 对不上 / 缺 selection → 画页顶灰色细条
  + `data-fallback="1"`，**绝不静默消失**
- **防无限重画**：observer 用 `isOwn()` 过滤掉自己造成的 `.ppd-mark` 变动
- 性能守卫：摘录 > 200 条时只画视口 ±2 屏
- `onunload` 拆 observer + 清标记 + 撤防抖定时器
- 测试新增 **E 组 43 项**，全绿 → **370 通过 / 0 失败**

版本 `0.8.4` → `0.9.0`（新增两个功能层）。

#### P3 双向跳转：已完成并同步到 vault

**正向**（摘录 → PDF 精确定位）：
- `ppdPatchOpenLinkText()` 劫持 `workspace.openLinkText`，**只接管带 `selection=` 的 pdf 链接**
  （不带 selection 的 `#page=N` 透传给 Obsidian 原生，`square=` 也不接管 —— 最小干预）
- `ppdJumpToSelection`：找已渲染的 leaf（匹配 `view.file`，僵尸 leaf 一律绕开）
  → 没有就 `getLeaf("tab")` 新开 → 滚到页 → **轮询等 textLayer**（虚拟化）→ 闪烁 3 次
- 卸载时用 `this.register` 还原原始 `openLinkText`，有 `_ppdPatched` 防重复劫持
- 定位失败会明确提示"可跑重建索引重试"，不静默

**反向**（PDF → 摘录）：
- **双击标记区域** → `openLinkText(摘录文档#^exId)`（P0-4 验证过 blockid 可用）
- 标记保持 `pointer-events: none`（不用单击的原因：标记覆盖在已摘录文字上，
  单击可交互会吃掉划选的起笔事件，而"在 PDF 上划选拖拽"是主工作流）
- 双击命中检测：从最上层标记往下找 `getBoundingClientRect()` 包含 (x,y)
- 双击监听登记在 `_ppdDblClickTargets`，`onunload` 拆除
- 标记新增 `data-src`（来源摘录文档路径），找不到时回退查索引

方法：`ppdParsePdfLink` / `ppdPatchOpenLinkText` / `ppdWaitPageEl` /
`ppdWaitSelectionRects` / `ppdJumpToSelection` / `ppdFlashRects` / `ppdOpenExcerptAt`

测试新增 **F 组 31 项** → **400 通过 / 0 失败**。
（踩坑：`ppdParsePdfLink` 是类方法不能直接放 `__test`，改走 `PluginClass.prototype`）

---

## 1. 总览计划表

| 阶段 | 内容 | 产出 | 前置 | 预估 | 可离线验证 |
|---|---|---|---|---|---|
| **P0** | 基线锁定与实测 | 测试基线绿 + 3 项实测结论 | — | 0.5 天 | ✅ 全离线 |
| **P1** | 索引层 | `excerptIndex` + 2 条命令 | P0 | 1.5 天 | ✅ 纯函数可 node 测 |
| **P2** | 回绘层 | PDF 上显示摘录标记 | P1 | 2 天 | ⚠️ 需 Obsidian |
| **P3** | 双向跳转 | 点链接精确定位 + 点标记回摘录 | P1 + P2 | 1.5 天 | ⚠️ 需 Obsidian |
| **P4** | 批注与 tooltip | 摘录可写描述，PDF 上可见 | P2 | 1 天 | ⚠️ 需 Obsidian |
| **P5** | 生命周期与健壮性 | 清理、降级、性能守卫 | P1–P4 | 1 天 | ✅ 部分 |
| **P6** | 可选移植 | 迁移 / 外部 PDF / 移动端 | P5 | 按需 | — |

**关键路径 P0 → P1 → P2 → P3，约 5.5 天。P4/P5 可穿插。**

---

## 2. P0 基线锁定（0.5 天）

开工前必须先拿到三个实测结论，否则后面全是猜。

| # | 任务 | 怎么测 | 为什么必须先测 |
|---|---|---|---|
| P0-1 | 跑通现有测试，锁定基线 | `node tools/test-chip-flow.mjs` | 确认改动前是绿的 |
| P0-2 | **span 索引在缩放变化时是否稳定** | 同一 PDF，在 50% / 100% / 200% / 适应宽度 下各拖同一段文字，看 `selection=` 是否一致 | **这是整个回绘方案的地基**。pdf.js 可能在不同缩放下重建 textLayer 导致 div 数量变化。若不稳定，P1/P2 必须换成 PDF 原生坐标方案 |
| P0-3 | `.textLayer` 直接子元素在不同类型 PDF 下的结构 | 对 3 个 PDF（纯文字 / 双栏论文 / 扫描版无文字层）各打印 `layer.children.length` 与 `layer.querySelectorAll('*').length` | 你的 `buildSelectionParams` 只取**直接子元素**，PDF Flow 取**所有定位后代**。确认你的口径够不够用 |
| P0-4 | 确认 `^ex-` block id 能被 `openLinkText` 定位 | `workspace.openLinkText('xxx-摘录.md#^ex-abc123', '', false)` | P3 反向跳转依赖它 |

> P0-2 若不通过，**立即停在这里找我**，回绘方案要重新设计（改用 pdf.js `textContentItems` + PDF 原生坐标，工作量大得多）。

---

## 3. P1 索引层（1.5 天）

**目标**：建立 `md 摘录文档 → (PDF, 页, 选区)` 的反查索引，可增量更新、可重建。

### 3.1 数据结构

```js
// this.excerptIndex: Map<pdfPath, Entry[]>
//   Entry = { page:Number, selection:[a,b,c,d]|null, exId:String,
//             tags:[String], text:String, sourceMd:String, line:Number }
// this.indexMtime: Map<mdPath, Number>
```

### 3.2 候选文件预筛（比 PDF Flow 更省）

PDF Flow 是「读全库所有 md」，你不必——用 `metadataCache.resolvedLinks` 先筛：

```js
const candidates = this.app.vault.getMarkdownFiles().filter(f => {
  const links = this.app.metadataCache.resolvedLinks?.[f.path];
  return links && Object.keys(links).some(p => p.toLowerCase().endsWith('.pdf'));
});
```

只读这些文件，通常只有几十个而不是几千个。

### 3.3 解析器（**写成纯函数，导出到 `__test`**）

摘录文档的实际形态（你 v0.8.x 生成的）：

```
## P.21

> ([[x.pdf#page=21&selection=0,0,655,478|【x-P.21】]])
> 正文文本
> #核心观点
^ex-1a2b3c

> > ([[x.pdf#page=21&selection=9,0,9,42|【x-P.21】]])   ← 嵌套子条目
> > 子摘录正文
> ^ex-4d5e6f
```

解析要点：

```js
const LINK_RE = /\[\[([^#|\]]+\.pdf)#page=(\d+)(?:&selection=([\d,]+))?[^\]]*\]\]/g;
const EXID_RE = /\^ex-[0-9a-z]{4,8}/;
const TAG_RE  = /#([\w\u4e00-\u9fa5\/]+)/g;
```

- 逐行扫；遇到含 `LINK_RE` 的行 → 开一个新 pending entry
- 遇到 `EXID_RE` 行 → 把 pending 定稿并 push（`^ex-` 在块尾，这是绑定锚点）
- 遇到 `> #xxx` 行 → 挂到 pending 的 tags
- **必须容忍任意层嵌套的 `> ` 前缀**（树形层级是你的特色，解析器不能只认 `> ` 单层）

### 3.4 增量更新

```js
this.registerEvent(this.app.vault.on('modify', f => this.reindexFile(f)));
this.registerEvent(this.app.vault.on('create', f => this.reindexFile(f)));
this.registerEvent(this.app.vault.on('delete', f => this.dropFileFromIndex(f)));
```

`reindexFile` 先比对 `this.indexMtime` 与 `f.stat.mtime`，没变就跳过。

全量重建按 20 个一批 + 批间 `sleep(10ms)`（抄 PDF Flow 的防卡 UI 写法）。

### 3.5 新增命令

| id | 名称 |
|---|---|
| `ppd-rebuild-index` | 重建摘录索引 |
| `ppd-index-stats` | 显示索引统计（PDF 数 / 摘录数 / 已索引文件数） |

### 3.6 改动位置

| 文件 | 位置 | 改动 |
|---|---|---|
| `main.js` | L440 `onload` 内 | 初始化 `excerptIndex` / `indexMtime`，注册 vault 事件，全量索引 |
| `main.js` | 新增区块 | `/* ===== 索引层 ===== */`：`buildExcerptIndex` / `reindexFile` / `parseExcerptDoc` / `dropFileFromIndex` / `getIndexStats` |
| `main.js` | L2386 `__test` | 导出 `ppdParseExcerptDoc`（纯函数） |
| `tools/test-chip-flow.mjs` | — | 新增 D 组：解析器用例 |

### 3.7 验收

- [ ] `ppd-index-stats` 报告的摘录数 == 该 PDF 摘录文档里 `^ex-` 的出现次数
- [ ] **node 离线**：`ppdParseExcerptDoc` 对以下 5 种输入正确 —— 单层 / 三层嵌套 / 无 selection / 有颜色标签 / 空文档
- [ ] 手动改一条摘录的文字 → 索引自动更新（无需重启）
- [ ] 全库 3000+ md 时，首次索引 < 3 秒且不卡 UI

---

## 4. P2 回绘层（2 天）

**目标**：打开 PDF 时，把已摘录的段落用底色标出来。这是**用户感知最强**的一环，也是目前差距最大的一环（你插件里 `overlay` / `highlight` 出现次数均为 0）。

### 4.1 注入样式

```css
div[data-type="pdf"] .page { position: relative !important; }
.ppd-mark { position: absolute; border-radius: 2px; pointer-events: auto;
            mix-blend-mode: multiply; }
.ppd-mark[data-fallback="1"] { /* span 对不上时的降级标记 */ }
```

`position: relative` + **百分比定位** → 覆盖层随页面一起缩放，**完全不用监听 zoom 事件**（抄 PDF Flow 最省事的那一招）。

### 4.2 选区 → 矩形（P1 的逆运算）

```js
resolveSelectionRects(pageEl, sel) {
  const layer = pageEl.querySelector('.textLayer');
  if (!layer) return null;
  const divs = Array.from(layer.children);           // ← 必须与 buildSelectionParams 口径一致
  const locate = (idx, off) => {
    const div = divs[idx]; if (!div) return null;
    const w = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    let acc = 0, n;
    while ((n = w.nextNode())) {
      if (acc + n.textContent.length >= off) return { node: n, offset: off - acc };
      acc += n.textContent.length;
    }
    return null;
  };
  const s = locate(sel[0], sel[1]), e = locate(sel[2], sel[3]);
  if (!s || !e) return null;
  const r = document.createRange();
  r.setStart(s.node, s.offset); r.setEnd(e.node, e.offset);
  return Array.from(r.getClientRects());   // 跨行会有多个矩形
}
```

然后每个 `clientRect` 转成相对 `pageEl` 的百分比：

```js
const pr = pageEl.getBoundingClientRect();
left   = 100 * (cr.left   - pr.left) / pr.width
top    = 100 * (cr.top    - pr.top)  / pr.height
width  = 100 * cr.width  / pr.width
height = 100 * cr.height / pr.height
```

### 4.3 降级策略（**这里要比 PDF Flow 做得好**）

PDF Flow 的缺陷：span 对不上就返回 `null`，高亮**静默消失**，只能靠「强制刷新所有高亮」命令兜底。

你的做法：

| 情况 | 行为 |
|---|---|
| 正常解析 | 按矩形画底色 |
| `selection` 缺失（只有 page） | 在页顶画一条细标记条 |
| span 对不上（PDF 换了 / pdf.js 升级） | 画页顶标记条 + `data-fallback="1"` 灰色 + `console.warn` 一次 |
| 该页 textLayer 尚未渲染 | 跳过，等 MutationObserver 触发重画 |

**原则：宁可画得不准，也不要什么都不画。**

### 4.4 绘制调度

```js
// 1. 等 PDF 就绪（抄 PDF Flow 的 waitForPdfReady，超时 500ms）
// 2. 取所有 div.page，按是否在视口内分两批
//    视口内 → 立即画；视口外 → requestAnimationFrame 里画
// 3. MutationObserver 盯 .pdf-viewer 容器（pdf.js 会虚拟化卸载远处的页）
//    变动 → debounce 150ms → 重画
```

**性能守卫**：单 PDF 摘录超过 200 条时，只画「视口 ±2 页」范围内的标记。

### 4.5 颜色

沿用你已有的 `colorMap` 语义（高亮色 → 标签），这比 PDF Flow 的「去向着色」更贴合你的工作流：

- 有 `tags` → 用 tag 对应的颜色（从 `colorMap` 反查，无映射则用 tag 名 hash 出的稳定色）
- 无 tag → 默认柔和黄

### 4.6 新增命令

| id | 名称 |
|---|---|
| `ppd-refresh-marks` | 强制刷新摘录标记（解决标记消失） |

### 4.7 改动位置

| 文件 | 位置 | 改动 |
|---|---|---|
| `main.js` | 新增区块 | `/* ===== 回绘层 ===== */`：`drawMarksForPdfView` / `resolveSelectionRects` / `rectsToPercents` / `clearMarks` / `setupPdfObserver` |
| `main.js` | L2192 `injectStyles` | 追加 `.ppd-mark` 样式与 `position:relative` 注入 |
| `main.js` | L575 附近 | 注册 `layout-change` / `active-leaf-change` 触发重画 |
| `main.js` | L722 `onunload` | 清理所有标记与 observer |

### 4.8 验收

- [ ] 打开一个已摘录的 PDF，被摘录段落有底色
- [ ] 缩放到 50% / 100% / 200%，标记**始终贴合文字**（这是 P0-2 的兑现）
- [ ] 连续翻 50 页，标记不漂移、不重复
- [ ] 关掉 PDF leaf 再开 20 次，DOM 节点数不增长（无泄漏）
- [ ] 手动把某条 `selection=` 改坏 → 出现灰色降级标记而不是消失

---

## 5. P3 双向跳转（1.5 天）

**目标**：补上当前**实际失效**的一环——`selection=` 现在没人解析。

### 5.1 正向：摘录 → PDF 精确定位

劫持 `openLinkText`（手写即可，不必引 monkey-around）：

```js
const ws = this.app.workspace;
const orig = ws.openLinkText.bind(ws);
ws.openLinkText = async (linktext, sourcePath, newLeaf, options) => {
  const m = /^(.+\.pdf)#page=(\d+)(?:&selection=([\d,]+))?/.exec(linktext || "");
  if (m) { await this.jumpToSelection(m[1], +m[2], m[3]); return; }
  return orig(linktext, sourcePath, newLeaf, options);
};
this.register(() => { ws.openLinkText = orig; });   // 卸载必须还原
```

`jumpToSelection` 流程：

1. 找已有 pdf leaf（路径匹配）→ 复用；否则新开 split
2. `pageEl.scrollIntoView({ behavior:'smooth', block:'center' })`
3. **等 textLayer 渲染**：轮询该页 `.textLayer` 的 `children.length > 0`，最多 2 秒，每 50ms 一次
   （pdf.js 虚拟化，远处的页没有文本层 —— 抄 PDF Flow 的轮询思路）
4. `resolveSelectionRects` → 算矩形
5. 闪烁：加 class，CSS `animation: ppd-flash .45s ease-in-out 3`，结束后移除

### 5.2 反向：PDF 标记 → 摘录文档

点覆盖层 → `openLinkText(sourceMd + '#^' + exId, '', false)`。
依赖 P0-4 验证过的 block-id 定位。

### 5.3 改动位置

| 文件 | 位置 | 改动 |
|---|---|---|
| `main.js` | 新增区块 | `/* ===== 跳转层 ===== */`：`patchOpenLinkText` / `jumpToSelection` / `waitTextLayer` / `flashRects` |
| `main.js` | P2 的标记元素 | 挂 click 事件 → 反向跳转 |
| `main.js` | L2192 `injectStyles` | 追加 `@keyframes ppd-flash` |

### 5.4 验收

- [ ] 摘录文档点回跳链接 → 跳到页 + 精确选区闪烁 3 次（**不再只跳页**）
- [ ] PDF 上点标记 → 摘录文档打开并滚到对应 `^ex-` 块
- [ ] 插件禁用后，`openLinkText` 行为完全恢复（无残留劫持）
- [ ] 目标页从未渲染过（滚到很远处）时，轮询能在 2 秒内等到 textLayer

---

## 6. P4 批注与 tooltip（1 天）

**目标**：摘录能写自己的描述，且在 PDF 上看得到。

### 方案取舍

| 方案 | 说明 | 结论 |
|---|---|---|
| PDF Flow 的 Meta Bind `INPUT[...]` | 需 Meta Bind 插件；绑定名带 `-` 可能不合语法；污染摘录文档 | ❌ 不采用 |
| **复用你 v0.8.0 的 callout 机制** | `ppdSplitNote` / `ppdJoinNote` / `ppdStripNote` / `PPD_NOTE_START` / `PPD_NOTE_END` 已经在 Canvas 卡片上跑通且被测试覆盖 | ✅ **采用** |

沿用同一套 callout 标记放进摘录文档的 blockquote 内，P1 解析器顺带把描述解析出来，P2 的覆盖层 hover 时显示。

### 验收

- [ ] 在摘录文档给某条写描述 → 保存 → PDF 标记 hover 显示该描述
- [ ] 描述含换行、含 `>` 嵌套时不破坏解析
- [ ] 「同步进摘录文档」开关关掉时行为与现状一致（已有设置项 `noteIntoSync`）

---

## 7. P5 生命周期与健壮性（1 天）

| # | 任务 | 说明 |
|---|---|---|
| P5-1 | 统一清理 | 单文件内加 `this._timers = new Set()` / `this._marks = new Set()` / `this._observers = new Set()`，`onunload` 一个 `cleanupAll()` 全清 |
| P5-2 | `openLinkText` 还原 | P3 的补丁必须能干净卸载 |
| P5-3 | 性能守卫 | 单 PDF > 200 条摘录时只画视口 ±2 页；索引 > 5000 条时提示 |
| P5-4 | 错误边界 | 索引/解析异常不影响拖拽主链路（你现在每个方法都有 try/catch，保持这个习惯） |
| P5-5 | 决定是否拆模块 | 此时文件会到 ~3300 行。若嫌大，再上 esbuild 拆 5–6 个文件，**但必须同步改测试脚本的加载路径** |

### 验收

- [ ] 反复开关 PDF 20 次，DOM 无增长
- [ ] 禁用插件 → 立即恢复无标记、无劫持的干净状态
- [ ] node 测试全绿（含新增的 D 组）

---

## 8. P6 可选移植（按需）

| 项 | 值不值 | 说明 |
|---|---|---|
| **存量 PDF Flow 摘录迁移** | 中 | `Books/读书笔记/<pdf>/<pdf>.md` → 你的格式。写独立脚本，先 dry-run 出报告再执行，**不自动覆盖** |
| 外部 PDF（虚拟 PDF hack） | 低 | 你的 PDF 都在 vault 里（`Books/pdf书籍/`），用不上 |
| 移动端触屏拖放 | 低 | `isDesktopOnly: true`，且你是掌机 + PC 场景 |
| Excalidraw | 低 | 看你用不用 |
| 对象存储 | 低 | 看仓库体积压力 |

---

## 9. 明确不移植的（从 PDF Flow 身上）

| 项 | 原因 |
|---|---|
| 时间戳 ID `Note<YYYYMMDDHHmmss>` | 你的 `^ex-` 内容寻址更好，同选区同 ID 天然去重 |
| 6 个正则变体回找 `### NoteN` 标题 | 脆弱。你用 `^ex-` 在块尾做锚点，解析更稳 |
| 216KB 无用 React | 打包事故 |
| 授权锁 / 三个常驻校验定时器 | 你不需要 |
| 「去向着色」（MD 绿 / Canvas 蓝 / Excalidraw 橙） | 与你的 `colorMap` 语义冲突，二选一保留 colorMap |
| Meta Bind 依赖 | 改用你已有的 callout 机制 |
| 硬编码 `Books/读书笔记/` | 你的摘录文档跟着 canvas 走，已经是对的 |

---

## 10. 风险登记

| 风险 | 影响 | 触发条件 | 应对 |
|---|---|---|---|
| **span 索引随缩放变化** | 🔴 回绘全盘失效 | P0-2 测出来不一致 | 立即停 P1，改走 pdf.js `textContentItems` + PDF 原生坐标（工作量 ×3） |
| textLayer 虚拟化 | 🟠 跳转时选区还没渲染 | 目标页离视口很远 | P3 的 `waitTextLayer` 轮询 2 秒兜底 |
| 劫持 `openLinkText` 与其他插件冲突 | 🟠 别的插件也劫持 | 装了同类插件 | 用 `this.register()` 保证卸载还原；降级方案改为只监听 `file-open` 事件 |
| 摘录文档被用户手改导致解析失败 | 🟡 部分条目标记消失 | 用户手动编辑 | P2 的降级策略兜底 + `ppd-rebuild-index` 可重建 |
| 单文件膨胀到 3300 行 | 🟡 可维护性 | P5 时 | P5-5 决策点 |

---

## 11. 开工清单

```
[ ] P0-1  node tools/test-chip-flow.mjs 记录基线结果
[ ] P0-2  实测 span 索引在 50/100/200% 缩放下是否一致   ← 不通过就停
[ ] P0-3  实测 .textLayer 直接子元素结构（3 类 PDF）
[ ] P0-4  实测 openLinkText 能否定位 ^ex- block id
[ ] P1    索引层 + node 测试 D 组
[ ] P2    回绘层（含降级策略）
[ ] P3    双向跳转
[ ] P4    批注 tooltip（复用 callout）
[ ] P5    清理与性能守卫
```

---

## 12. 边界声明

- P0-2 是**唯一可能推翻整个方案**的前置项，必须先测。
- 预估工作量按「你熟悉自己代码 + 我逐段陪写」口径给，不含你自己调试的时间。
- 所有阶段都假设**不引入构建步骤**；若 P5-5 决定拆模块，测试脚本需同步改造，工作量另计。
- PDF Flow 侧的结论来自压缩产物静态分析，未做运行时验证；具体移植时以实测为准。
