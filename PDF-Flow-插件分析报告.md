# PDF Flow 插件逆向分析报告

> 分析对象：`D:/下载/文档/Obsidian/往昔的涟漪/.obsidian/plugins/PDF Flow`（v1.0.6，作者 ytmaps）
> 分析方式：对压缩后 `main.js`（534,506 字节 / 654 行）做模块边界还原与符号重建
> 分析日期：2026-09-02

---

## 0. 结论先行

| 维度 | 评价 |
|---|---|
| 功能完整度 | ★★★★★ 七个功能域、55 个源文件、265 个导出方法，是同类中功能最全的 |
| 架构设计 | ★★★★☆ mixin 原型合成分层清晰；但状态全挂在 `this` 上，无模块化边界 |
| 数据模型 | ★★★★★ **唯一真相源是 markdown 笔记本身**，索引是可重建缓存 —— 这是全插件最值钱的设计 |
| 代码质量 | ★★☆☆☆ 防御性 `try/catch` 吞异常泛滥、硬编码路径、魔法字符串 |
| 打包卫生 | ★☆☆☆☆ **40% 体积（216KB）是完全没用到的 React**，另有一整套跑空转的安全代码 |
| 使用风险 | ⚠️ **硬依赖另一个授权插件** `obsidian-content-protection`，未授权则全功能静默关闭 |

**一句话**：功能与数据模型非常值得学，代码写法与打包不值得学，且它是一个带授权锁的商业插件。

---

## 1. 插件身份与依赖风险（先看这个）

manifest 声明的 `isDesktopOnly: false`，但有几件事不写在 manifest 里：

### 1.1 硬依赖授权插件

`checkPluginActivation()` 在业务代码中被调用 **30 次**，几乎每个入口都先过这道闸：

```js
checkPluginActivation = function() {
  if (this.isMobileDevice()) {
    // 移动端：检查 app.plugins.enabledPlugins 里有没有 content-protection
    return this.app.plugins.enabledPlugins.has(this._securityKeys.pluginId) ? true : false;
  }
  // 桌面端：快速完整性检查 + isPluginActivated
  return !!this._quickIntegrityCheck() && !!this.isPluginActivated;
}
```

启动流程是：

```js
await this._performInitialSecurityChecks()
  ? await this._validateContentProtectionManifest()
    ? (this.isPluginActivated = true,
       this._startContinuousValidation(),
       this._setupPluginStateMonitor(),
       await this.initializePluginFeatures())
    : this._triggerSecurityFailure("版本验证失败")
  : this._triggerSecurityFailure()
```

- `_triggerSecurityFailure()` → `_triggerGracefulShutdown()` → 1 秒后 `disablePluginFeatures()`。
- 你的 vault 里已装 `obsidian-content-protection`（已在 `community-plugins.json` 中），所以目前能跑。
- **风险**：一旦那个插件被禁用、删除、或版本校验不通过，PDF Flow 会**静默失效**——不报错、不弹窗，功能直接消失。而你所有摘录数据都还在（存于 md 笔记），所以**数据不丢，但工作能力丢**。

### 1.2 常驻定时器开销

| 定时器 | 周期 | 作用 |
|---|---|---|
| `_continuousValidationTimer` | 30 秒 | `checkAndUpdateStatus()` |
| `statusCheckInterval` | 5 分钟 | `checkAndUpdateStatus()`（重复注册了同一个函数） |
| `_integrityCheckTimer` | 10 分钟 | `_quickIntegrityCheck()`，失败即触发安全停机 |
| anti-debug `setInterval` | 1 秒 | 检测 DevTools 窗口尺寸差，**结果无人消费** |

`_setupPluginStateMonitor()` 函数体是空的（`= setInterval?` 那行直接 `= null`），属于写了一半的死代码。

### 1.3 安全模块是"表演性"的

`src/security/` 下有 4 个文件、`obfuscation.js` 有 2681 字节的 base64 字符串表（`atob` 后是 `content-protection`、`isActivated`、`crackMode`、`bypassValidation` 等），看起来很像 DRM。但实测：

- `_0xSec.*` 在业务代码里的调用次数 = **0**
- `_0xStr.*` 在业务代码里的调用次数 = **0**
- `isActivated`、`deviceId` 在业务代码中出现次数 = **0**

也就是说整套混淆/反调试体系**只是被定义和导出，从未被真正执行**。唯一起作用的是 1 秒一次的 anti-debug 轮询（纯浪费）。

> 边界声明：本报告只描述机制存在与调用关系，不提供任何绕过方法。

---

## 2. 功能全景

| 功能域 | 模块数 | 做什么 |
|---|---|---|
| **highlights** 高亮 | 6 | 把笔记里的 wiki 链接反查回 PDF，在页面上画出彩色覆盖层；点覆盖层跳回原笔记 |
| **drag** 拖拽 | 5 | 从 PDF 拖文字/区域到 Canvas、Excalidraw、Markdown；触屏长按拖拽 |
| **dummy-pdf** 虚拟 PDF | 8 | 用"内容是 URL 的假 .pdf"让仓库外 PDF 能被 Obsidian 打开，带断点续传下载 |
| **canvas** 画布 | 7 | 卡片生成、章节层级树、PDF 大纲视图、颜色同步、节点归类 |
| **rect-selection** 区域截图 | 4 | 框选 PDF 区域 → 合成截图 → 存附件或上传对象存储 |
| **excalidraw** | 2 | 把摘录写进 Excalidraw 元素并双向跳转 |
| **comments** 批注 | 2 | 摘录的评论 + 标签，存在 frontmatter，用 Meta Bind 行内输入编辑 |

对外接口：

- **7 条命令**：切换拆切模式、重建高亮索引、显示索引统计、为外部 PDF 创建虚拟链接、归类当前 Canvas 的旧节点、调整章节层级、强制刷新所有高亮
- **1 个自定义视图**：`pdfflow-chapter-hierarchy`（章节层级树）
- **13 个 workspace 事件监听**
- **设置项**：对象存储开关（腾讯云 COS / 阿里云 OSS）、虚拟 PDF 目录、自定义右键菜单（可挂任意 Obsidian 命令）

---

## 3. 架构：mixin 原型合成

整个插件是一个类，方法是后期贴上去的：

```js
PdfFlowPlugin = class extends Plugin { constructor(...) { ... } }

allMethods = [lifecycleMethods, rectModeMethods, rectSelectorMethods, ... 共 39 个模块导出对象 ];

allMethods.forEach(mod => {
  Object.keys(mod).forEach(key => { PdfFlowPlugin.prototype[key] = mod[key] });
});
```

- 每个源文件写成 `module.exports = { foo: function(){...}, bar: function(){...} }`，内部一律用 `this` 当作插件实例。
- 好处：不需要依赖注入容器，就能把 265 个方法拆到 55 个文件里，且天然共享实例状态。
- 代价：没有模块私有状态，所有字段（`highlightIndex`、`rectDebounceMap`、`dragDataStorage`、`pdfContainerStates`…）平铺在实例上，命名冲突靠自觉；IDE 无法追踪方法来源。

配套的生命周期管理做得比较认真（`core/` 三个管理器）：

- `EventManager` — 记录所有 `addEventListener`，提供 `clearElement()` / `destroy()`
- `TimerManager` — 所有 `setTimeout/setInterval` 进 `Set`，`destroy()` 统一清
- `DomManager` — 三类临时 DOM（拖拽预览、高亮元素、临时元素）分池管理，卸载时统一移除

---

## 4. 五个核心机制详解

### 4.1 数据模型（最值得抄的部分）

摘录不存数据库，直接写进 markdown 笔记。一条摘录长这样：

```markdown
### Note20260902043814
这不是一个关于个人品味的问题，而是一个关于注意力如何分配的工程问题🔗[[Lecture 3 ECON508.pdf#page=21&select=0,0,655,478&color=yellow| p.21]]  ✏️`INPUT[inlineList(class(pdfflow)):Note20260902043814]`
```

拆解：

| 片段 | 含义 |
|---|---|
| `### Note` + `YYYYMMDDHHmmss` | 摘录 ID，**用时间戳做确定性 ID**，天然幂等 |
| 正文 | 经 `cleanPdfText()` 清洗后的文本（去行内换行、合并空行、转义 `#[]{}\*_|`） |
| `🔗[[...pdf#page=N&select=a,b,c,d&color=yellow｜p.N]]` | 回链，承载全部定位信息 |
| `INPUT[inlineList(class(pdfflow)):Note...]` | **Meta Bind 行内输入**（你 vault 里已装该插件），绑定到 frontmatter 的 `Note<N>` 字段 |

文件组织：`Books/读书笔记/<PDF 文件名>/<PDF 文件名>.md`（**硬编码路径，不可配置**）。

评论与标签存在同一文件的 YAML frontmatter：

```yaml
---
Note20260902043814:
  - 评论正文
  - #标签A #标签B
---
```

**这个设计的价值**：
1. 唯一真相源是 md 文件 → 换设备、换插件、同步都不会丢。
2. 索引可以随时用「正则扫全库」重建 → 有专门的 `重建高亮索引` 命令。
3. 评论/标签借 Meta Bind 的行内输入编辑，插件只负责读写 YAML，UI 不用自己造。

**代价**：`extractNoteTitleFromContent()` 靠正则在全文里回找标题，`contentContainsPdfLink()` 要拼 6 个正则变体去匹配 `page=` 和 `select=` 的先后顺序 —— 只要用户手改过笔记格式，就会失配。

### 4.2 `select=a,b,c,d` 的坐标语义

这是**不是**像素坐标，也**不是** PDF 原生坐标，而是 pdf.js 文本层的 span 索引：

```
a = 起始 span 在 .textLayer 中的序号
b = 起始字符在 span 内的偏移
c = 结束 span 序号
d = 结束字符偏移
```

生成（`calculatePreciseSelectionCoords`）：遍历 `.textLayer` 里所有"有定位样式且有文本"的 DOM 元素，顺序编号；再反查选区首尾落在哪个 span。

回绘（`computeMergedPdfHighlightRectsForFlow`）：按同样规则重数一遍 span，取首尾之间的字符矩形合并成行矩形（同一行的矩形按"垂直中心接近 + 宽度相似"合并，容差 0.85）。

| 优点 | 缺点 |
|---|---|
| 与缩放、旋转、DPR 完全无关 | 依赖 pdf.js 的 DOM 结构，pdf.js 升级可能整体错位 |
| 纯文本可读，能 diff | 跨设备复现依赖相同 pdf.js 版本（你在 HX370 / 8945HS 双机 + iPad 上跑，有风险） |
| 比存像素坐标省事 | 无 fallback：span 对不上就直接返回 `null`，高亮消失 |

区域截图用另一套参数：`square=`，存 PDF 原生坐标（经 `pdfjsLib.Util.normalizeRect` 归一化）。

### 4.3 高亮回绘管线

```
buildHighlightIndex()
  └─ 遍历所有 md 文件，正则 /\[\[([^#|\]]+\.pdf)#([^|\]]+)(?:\|[^\]]*)?\]\]/g
     └─ URLSearchParams 解析 page / select / square / color
        └─ highlightIndex: Map<pdfPath, highlight[]>
           （按 20 个文件一批，批间 sleep 10ms，避免卡 UI）

drawHighlightsForPdfView(view)
  ├─ 等 PDF 就绪（waitForPdfReady，超时 500ms）
  ├─ 取所有 div.page，按是否在视口内分成两批
  │   视口内 → 立即画；视口外 → requestAnimationFrame 里画
  ├─ 每页：clearHighlightsFromView → drawHighlightsOnPage
  └─ setupPdfContainerObserver（MutationObserver 盯住容器变化）
```

渲染成 DOM 覆盖层，位置用**百分比**：

```js
// pdfRectsToLayerPercents：PDF 坐标 → 页面内百分比
left   = 100 * (rect[0] - view[0]) / viewWidth
top    = 100 * (rect[1] - view[1]) / viewHeight
width  = 100 * (rect[2] - rect[0]) / viewWidth
height = 100 * (rect[3] - rect[1]) / viewHeight
```

配合注入的 `div[data-type="pdf"] .page { position: relative !important; }`，覆盖层就跟着页面一起缩放，**不需要监听 zoom 事件重算**。这是一个很省事的做法。

### 4.4 虚拟 PDF（最有创意的 hack）

Obsidian 只能打开仓库内的 PDF。PDF Flow 的做法：

1. **造一个假文件**：在 vault 里创建一个 `.pdf` 文件，内容就是一行 URL（`vault.create(path, url)`）。判定阈值是 `stat.size < 300` 字节。
2. **劫持阅读器**（用 monkey-around 的 `around()`）：

```js
// 打补丁点一：PdfView.prototype.loadFile
around(viewProto, {
  loadFile(old) {
    return async function(file, ...) {
      if (file.stat.size < 300) {
        const realUrl = await downloadOrCache(...);        // 拿到 blob URL
        const fakeUrl = app.vault.getResourcePath(file);   // 假文件的 resource 地址
        this.pdfViewer.pdfflowPdfRedirect = { from: fakeUrl, to: realUrl };
        // blob URL 要在 leaf 卸载时 revoke
        this.component.register(() => URL.revokeObjectURL(realUrl));
      }
      return old.call(this, file, ...);
    }
  }
});

// 打补丁点二：pdfViewer 原型.open —— 真正换 URL 的地方
around(pdfViewerProto, {
  open(old) {
    return async function(args) {
      if (this.pdfflowPdfRedirect && args.url.startsWith(this.pdfflowPdfRedirect.from))
        args.url = this.pdfflowPdfRedirect.to;
      delete this.pdfflowPdfRedirect;
      return old.call(this, args);
    }
  }
});
```

3. **下载器**：Range 请求断点续传，最多重试 3 次，带暂停/继续；watchdog 规则是「45 秒无数据 / 90 秒无进度 / 总时长超 10 分钟」即中止；桌面端与移动端都缓存 24 小时，但**移动端无暂停与断点续传**。
4. 补丁安装时机：`file-open`、`layout-change`、`onLayoutReady` 三处都会尝试，且会轮询等 `view.viewer` 这个 Promise resolve（最多 12 秒，每 40ms 探一次）——因为 Obsidian 的 `viewer` 是懒加载的。

**可借鉴点**：不跟 Obsidian 的 API 限制硬碰，而是"造一个合法的文件 + 在渲染前最后一步换 URL"。以及那段**轮询等 `viewer` Promise** 的写法（`waitForPdfViewer`），凡是碰 `view.viewer` 的插件都需要它。

### 4.5 区域截图：复用 pdf.js 自己的 canvas

没有引入 html2canvas，而是把页面上已有的 pdf.js canvas 挑选后合成：

```js
// 1. 收集容器内所有 canvas，算与目标矩形的重叠面积
// 2. 按重叠面积降序，取前 8 个
// 3. 逐个 drawImage 到目标 canvas（先铺白底，alpha:false，关掉图像平滑）
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
ctx.imageSmoothingEnabled = false;
ctx.setTransform(scaleX * dpr, 0, 0, scaleY * dpr, 0, 0);
```

- 缓存：以几何参数为 key 缓存 10 秒，同一区域重复拖不再截。
- 防抖：同一几何形状 150ms 内不重复触发。
- 坐标换算：`(clientX - rect.left) * (offsetWidth / rect.width)`，先折算回 CSS 像素再乘 DPR。

### 4.6 拖拽：手搓 touch/mouse 拖放

Obsidian 在移动端没有原生 HTML5 drag，所以 PDF Flow 自己实现：

```js
// 拖起：造一个 fixed 定位的预览 div 跟手
// 移动：mousemove / touchmove 更新 left/top，preventDefault
// 落下：elementFromPoint(x, y) → closest("[data-pdfflow-drop-listener]")
//       命中后手工合成一个 drop 事件：
const evt = new CustomEvent("drop", { bubbles: true, cancelable: true });
evt.dataTransfer = { getData: () => text, types: ["text/plain"], files: [] };
evt.clientX = x; evt.clientY = y; evt.preciseClientX = x; evt.preciseClientY = y;
target.dispatchEvent(evt);
```

这样 Canvas / Excalidraw / Markdown 三种落点可以共用同一套 drop 处理逻辑。
另外有 5 秒超时自动取消，以及 `cleanupDragPreviews()` 这种"扫所有 fixed+zIndex≥10000 且文本含关键字的 div 并删掉"的兜底清洁。

### 4.7 文档类型着色

高亮覆盖层的颜色编码"这条摘录去哪了"：

| 类型 | 判据（摘录所在源文件扩展名） | 颜色 |
|---|---|---|
| MD | `.md` | `#4CAF50` 绿 |
| CA | `.canvas` | `#2196F3` 蓝 |
| EX | `.excalidraw` / `.excalidraw.md` | `#FF9800` 橙 |

带缓存（`docTypeCache` + 超时）与批量计算（5/10 个一批，批间 sleep）。

---

## 5. 打包卫生：40% 是 React

`main.js` 里 vendored 了 `react`、`react-dom`、`scheduler`：

| 区间 | 内容 | 体积 |
|---|---|---|
| 7,410 – 223,544 | React + react-dom + scheduler | **216,134 B（40%）** |
| 223,544 – 534,506 | 插件自身 55 个模块 | 317,962 B（60%） |

而 `createRoot` 的两次出现**都在 vendor 区内部**（react-dom 自己的导出），`src/` 区零引用；`React.createElement`、`jsx(`、`jsxDEV` 出现次数均为 0。

**结论：React 完全没有被使用，是打包配置的残留。** 在 iPad 上每次启动都白解析 216KB 死代码。

---

## 6. 与你自己的 `pdf-plus-drag` 逐项对比

你的插件（`main.js` 94KB，单文件）已知能力：框选截图（`startRectDrag`/`captureRectImage`）、拖出 chip（`showChip`/`hideChip`）、写入 Canvas 卡片（`processCanvas`/`fitNode`/`estimateSizeFor`）、相关笔记（`findRelatedNotes`/`tokenizeForSearch`）、颜色标签（`detectColorTag`/`collectHighlightColors`）、Canvas 同步（`scheduleCanvasSync`/`ppdLayoutGroup`）。

> ⚠️ **本节于 2026-09-02 修订。** 初版只扫了函数签名就下结论，把 `buildSelectionParams`
> 误判为"缺失"。实际读完源码后修正如下——你插件在摘录格式与 ID 设计上**已经领先**，
> 真正的差距集中在"回绘 / 索引 / 定位跳转"这一层。

| 能力 | pdf-plus-drag v0.8.4（你的） | PDF Flow | 差距性质 |
|---|---|---|---|
| 区域框选截图 | ✅ | ✅ | 持平 |
| 截图落到 Canvas 卡片 | ✅ | ✅ | 你的还多了自动尺寸估算、笔记框、重叠规范化、自动连线 |
| 相关笔记推荐（本地零 AI） | ✅ | ❌ | **你领先** |
| 文本选区摘录 span 索引 | ✅ `selection=a,b,c,d`（`buildSelectionParams`，L1137） | ✅ `select=a,b,c,d` | **持平**（同构实现） |
| 摘录 ID | ✅ `^ex-` **内容寻址** | 时间戳 | **你领先**：同选区重复拖 → 同 ID → 天然去重；时间戳每次都是新 ID |
| 摘录文档格式 | ✅ `## P.21` 按页分组 + 嵌套引用块表达树形层级 | 扁平 `### Note<时间戳>` | **你领先** |
| 颜色语义（高亮色 → 标签） | ✅ `colorMap` 可配置 | ❌（只有"去向着色"） | **你领先** |
| 回忆模式 | ✅ | ❌ | **你领先** |
| node 冒烟测试 | ✅ `__test` 钩子 + `tools/test-chip-flow.mjs` | ❌ | **你领先** |
| **高亮回绘到 PDF** | ❌（`overlay`/`highlight` 出现 0 次） | ✅ | **缺核心能力** |
| **全库索引（md → PDF 反查）** | ❌（只有 canvas → md 单向） | ✅ | **缺核心能力** |
| **点击摘录精确跳转定位** | ⚠️ 有链接但 `selection=` 依赖 PDF++ 解析，而该 vault 里 **pdf-plus 未启用** | ✅ 自管 interceptor | **缺 + 有隐患** |
| 评论 / 自由标签 | 部分（仅颜色标签） | ✅ + Meta Bind 行内编辑 | 落后 |
| 外部 PDF（仓库外） | ❌ | ✅ 虚拟 PDF hack | 落后 |
| Excalidraw 支持 | ❌ | ✅ | 落后 |
| 移动端 | ❌ `isDesktopOnly: true` | ✅ 手搓 touch 拖放 | 落后 |
| 对象存储 | ❌ | ✅ COS/OSS | 看你是否需要 |
| 代码组织 | 单文件 2394 行，无构建步骤 | 55 模块 mixin | 各有取舍 |

**修正后的结论**：你做的是"截图 → 卡片"深挖 + 摘录文档格式设计（这两块都比 PDF Flow 强），
PDF Flow 做的是"摘录 → 索引 → 回绘 → 跳转"闭环。**要补的不是摘录格式，而是回绘与索引这一层，
并且把 `selection=` 的解析权从 pdf-plus 手里拿回来自己实现。**

**关键隐患**：`pdf-plus` 装了但**没有启用**（不在 `community-plugins.json` 里）。
你摘录文档里的 `[[x.pdf#page=N&selection=a,b,c,d]]` 中的 `selection=` 只有 PDF++ 能解析；
现在点链接只能跳到页（Obsidian 内核处理 `#page=`），精确选区定位是失效的。

---

## 7. 可借鉴清单

### P0 — 直接抄，收益最大

1. **唯一真相源 = markdown 笔记，索引可重建**
   别把摘录存进 `data.json`（PDF Flow 只把 `lastHighlightCache` 这类"当前位置"存 data.json，**摘录本身一条都不存**）。好处：同步安全、可 diff、插件挂了数据还在、能随时重建索引。

2. ~~**时间戳做摘录 ID**~~ → **不适用，你的更好，别换**
   PDF Flow 的 `Note20260902043814` 确定性、天然按时间排序，但**同选区重复拖会得到两个不同 ID**。
   你的 `^ex-<6位base36>` 是内容寻址（hash of `path|page|selectionParams`），同选区 → 同 ID → 天然去重。
   保留你自己的。

3. **百分比定位覆盖层 + `position: relative` 注入**
   避免监听 zoom 重算，一套 CSS 解决所有缩放场景。

4. **分批处理 + 批间 sleep**
   ```js
   for (let i = 0; i < files.length; i += 20) {
     for (const f of files.slice(i, i + 20)) await this.indexFile(f);
     if (i + 20 < files.length) await new Promise(r => setTimeout(r, 10));
   }
   ```
   全库扫描不卡 UI 的最小代价做法。

5. **视口内先画、视口外 `requestAnimationFrame` 再画**
   ```js
   pages.forEach(p => { const r = p.getBoundingClientRect();
     (r.top < innerHeight && r.bottom > 0 ? visible : offscreen).push(p); });
   visible.forEach(draw);
   if (offscreen.length) requestAnimationFrame(() => offscreen.forEach(draw));
   ```

### P1 — 值得做，但要想清楚

6. **三个生命周期管理器**（`EventManager` / `TimerManager` / `DomManager`）
   你单文件插件里定时器泄漏的风险更高（你已经有过 `persistAutoSizeSoon` 的 `clearTimeout` 模式）。抽成三个小类成本很低。

7. ~~**文本层 span 索引坐标**~~ → **你已实现（`buildSelectionParams` L1137），别重复造**
   但要注意一处差异：PDF Flow 枚举 `.textLayer` 内**所有有定位样式的后代元素**，
   你只取 **`.textLayer` 的直接子元素**。两者各自自洽即可，**但必须保证生成端和消费端用同一套规则**。
   另外 PDF Flow 没有 fallback——span 对不上高亮就静默消失，只能靠「强制刷新所有高亮」兜底。
   你做回绘时必须加降级：span 对不上 → 至少标记整页，而不是什么都不画。

8. **文档类型着色**（MD 绿 / Canvas 蓝 / Excalidraw 橙）
   一眼看出摘录流向，实现成本极低。

9. **复用 pdf.js 现有 canvas 合成截图**
   你已经实现了 `captureRectImage`，可以对比一下它是否也走了"挑重叠面积最大的几个 canvas 合成"这条路；如果走的是整页 canvas 裁切，在超高 DPI 下会更慢。

10. **meta bind 行内输入做批注 UI**
    你 vault 里已装 Meta Bind，可以白拿一套批注输入控件，不用自己写弹窗。

### P2 — 看需求

11. **虚拟 PDF hack** — 如果你不需要在 iPad 上读仓库外的 PDF，不必做。
12. **手搓 touch 拖放 + 合成 drop 事件** — 只在你真要支持移动端时才需要；合成 `dataTransfer` 那招挺脏但是唯一可行的路。
13. **对象存储上传** — 看你仓库体积压力。

---

## 8. 不要借鉴的

| 做法 | 为什么不要 |
|---|---|
| 216KB 无用 React | 纯打包事故，别让自己的插件也这样 |
| `try {} catch(e) {}` 吞异常 | 在 `yaml.js`、`detect.js` 里成片出现，Debug 时是灾难。至少 `console.error` 出来 |
| 硬编码路径 `Books/读书笔记/` | 用户换个目录就废。应该做成设置项（它自己只有虚拟 PDF 目录做了设置项） |
| 靠正则回找 `### NoteN` 标题 | 脆弱。应当在写入时就记下稳定的锚点（比如加一个 HTML 注释锚或 block-id） |
| 6 个正则变体匹配 `page=` / `select=` 顺序 | 说明格式本身不够严格。要么固定顺序，要么解析后规范化 |
| 三个常驻定时器做同一件事 | 30s / 5min / 10min 三个 interval 都在跑校验 |
| 全平铺的 `this.xxx` 状态 | 39 个模块共享一个命名空间，是后期维护债 |
| "扫所有 div 按 zIndex 和文本关键字猜并删除"的清理 | `cleanupDragPreviews()` 里的这段兜底，说明前面自己的引用管理没做好 |

---

## 9. 复现方法（你可以自己验证本报告）

```bash
# 模块边界（能看到全部 55 个源文件路径）
grep -o '"src/[a-zA-Z0-9_/\.-]*\.js"' "PDF Flow/main.js" | sort -u

# 统计 Obsidian API 注册点
grep -o 'addCommand\|registerEvent\|addSettingTab' "PDF Flow/main.js" | sort | uniq -c

# 验证 security 层是死代码（业务代码零调用）
python -c "
s=open('PDF Flow/main.js',encoding='utf-8').read()
for k in ['_0xSec.','_0xStr.','isActivated','deviceId']:
    print(k, s.count(k))
"

# 验证 React 未被使用（createRoot 只出现在 vendor 区）
python -c "
import re
s=open('PDF Flow/main.js',encoding='utf-8').read()
print([m.start() for m in re.finditer('createRoot', s)])  # 都 < 223544
"
```

---

## 10. 边界声明

- 本报告基于**压缩后产物**的静态分析，无 source map，部分标识符为重建结果。核心机制均已通过交叉验证（`data.json` 实际内容、vault 已装插件列表、模块间调用关系）确认。
- **未做运行时验证**，未实际启动插件观察行为。涉及 pdf.js 内部结构（`textDivs`、`textContentItems`、`transform`）的推断依赖当前 Obsidian 内置 pdf.js 版本。
- 对授权机制只描述存在性与调用关系，不提供绕过方法。
