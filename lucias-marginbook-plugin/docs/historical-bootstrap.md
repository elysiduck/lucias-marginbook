/*
 * ============================================================================
 * Lucia's MarginBook (lmb) v0.16.14
 * ----------------------------------------------------------------------------
 * 独立运行的 PDF 摘录工作流插件：不依赖任何第三方 PDF 插件，不修改其他插件文件。
 * 与 PDF++ 等其他 pdf 链接处理插件可共存（本插件在 DOM 捕获层拥有更高优先级）。
 *
 * v0.16.5 变更（第二轮审计修复，详见 lucias-marginbook-v0.16.4-第二轮审计报告.md）：
 *   - R1（P1）重叠规范化不再绕过「首连锁定」：
 *       ① 命令路径跳过「已有自动父边」的卡 —— 不再给卡建第二条父边（一卡双父）；
 *       ② 新建的边一律登记进 sidecar（消除「recenter 认它 / 清理不认它」的账本矛盾）；
 *       ③ 跳转后的自动自愈改走 healOnly：只重排「已有父子关系 + 当前仍重叠」的组，
 *          **不新建任何边** —— 自愈不该替用户决定父子关系，也不该挪动用户摆好的卡。
 *   - R2（P2）回绘标记按条目类型分流：rect（截图摘录）不再被 textLayer 闸门挡掉，
 *     与 lmbDrawEntryMark「rect 不依赖文本层」的实现承诺对齐。
 *   - R3（P2）reindexFile 记账修复：拿不到 f.stat 时不再写 Date.now()（旧值 ≥ 任何
 *     真实 mtime → 该文件索引永久冻结），改为不记账、等 stat 可用后自然补上。
 *   - R4（P2）回忆模式「开启」时主动触发阅读视图重渲染（旧版只清 class，已打开的
 *     笔记不会重跑 postProcessor → 开了却看不到模糊，要手动切页）。
 *   - R5（P2）PDF 回跳链接路径解码（%20 → 空格），解码失败保留原样；直接取不到文件
 *     时回退 metadataCache.getFirstLinkpathDest —— 路径含空格的 PDF 不再「找不到 PDF」。
 *   - R6（P2）activeCanvasContext 加 getMostRecentLeaf() 兜底（activeLeaf 已 deprecated，
 *     一旦被移除所有 canvas 命令会全挂）。
 *   - R7（P3）canvas 索引改走防抖入口 lmbScheduleCanvasIndex（400ms）—— 拖拽期不再
 *     每次 modify 全量 cachedRead + JSON.parse 整张画布。
 *   - R8（P3）新增 _lmbClearTimers() + _unloaded 标记：卸载后清掉所有自建定时器；
 *     图片等待重试链（setTimeout 无句柄可取消）靠入口标记自行退出。
 *   - 测试：新增 BE1-BE10 **逻辑级**断言（直接调函数 + 最小 mock，非源码正则），
 *     覆盖 R1/R3/R5；BE1 用例已验证「对旧代码必错（旧逻辑选父 p2，ratio 0.60）、
 *     对新代码必对」。662 项全绿。
 *
 * v0.16.4 变更（全量 bug 审计修复，详见 lucias-marginbook-v0.16.3-bug审计报告.md）：
 *   - P0-1 saveSettings 白名单补 autoAttachScreenshot / autoCleanOnDelete —— 此前
 *     两个设置键被 saveData 整体覆盖丢弃，重启后开关静默回退（数据级开关尤甚）
 *   - P1-1 关「自动附截图」后框选不再整链路报废：降级为纯文字摘录（rect= 链接照常）
 *   - P1-2 删除级联顺序修正：先删 md 条目再对附件做引用计数 —— 旧顺序摘录 md 自身
 *     embed 行必然被数进引用 → 附件永远跳过删除（清理功能死锁）
 *   - P1-3 评论/补充描述/批量挂框四条链路迁移到内存优先（_lmbReadCanvasData +
 *     _lmbWriteCanvasData），不再把磁盘旧位置钉回去（Bug6 同款坑）
 *   - P2-1 onunload 清理全部三颗注入按钮（旧版漏 md/canvas 两颗死按钮）
 *   - P2-3 嵌套子摘录锚点 "> > ^ex-xxx" 现可匹配（剥所有层 "> " 前缀）
 *   - P2-4 selfWritten 存时间戳，>5s 旧标志不再吞用户真实 modify
 *   - P2-5 activeCanvasContext 不再静默回退到任意后台画布（只认活动 canvas leaf）
 *   - P2-6 Alt+拖拽框选也 preventDefault（拦截原生文字选区，与注释一致）
 *   - P2-7 手动 fit（locked）改高度后仍做一次组内重居中——locked 锁尺寸不锁对齐
 *   - P3-4/P3-5 设置页文案修正（noteAutoBoxOnNew 实际默认 false）；摘录文档
 *     创建/更新后立即强制入索引（不等 resolvedLinks 异步解析）
 *   - 审计更正：v0.16.3 报告中 P2-2「instantMoveAttach busy-spin」经复核不成立
 *     （循环尾有无条件 return，不构成忙等），未做改动
 *
 * v0.16.1 变更（用户实测六连修）：
 *   - Bug5【v0.16.0 回归】双重卡文字视图下图文并存：CSS 判据
 *     :has(a[href*=".pdf#page="]) 实测不命中 —— canvas 里指向 .pdf 的 internal-link
 *     是非 md 文件，Obsidian 渲染时很可能丢弃 #page= 子路径，属性选择器匹配不上。
 *     修法 = 判定权完全收回 JS：新增 lmbMarkDualCards（轮询里给双重卡的 nodeEl 打
 *     lmb-dual class，带 simpleHash 缓存；nodeEl 不随 markdown 重渲染重建所以稳定），
 *     CSS 改用 .lmb-dual … :not(.lmb-view-img) img{display:none} —— 与悬浮栏
 *     「视图」按钮判定 100% 同源，藏了就一定有按钮能切回来。
 *   - Bug6 删除/拖拽后弹回原位、在几个位置间瞬移：processCanvas 与
 *     normalizeOverlappingExcerpts 仍在「读文件→改→写」（v0.14.9 只修了 fit 链路，
 *     同一个坑分两次踩）。修法 = _lmbMemCanvasData（内存 getData 优先）+
 *     _lmbWriteCanvasData（setData + requestSave + **同一份**内存数据写盘）。
 *   - Bug2 高度点好几次才涨一点、永不收敛：contentEl 无 element children（markdown
 *     未渲染完）时 walk 把被 min-height 拉伸的容器自己当叶节点 → 实测值跟着卡片高度走。
 *     修法 = 测前检查 children.length>0，未就绪走估算兜底。
 *   - Bug1 有评论的卡自动高度裁掉评论底部（两个叠加根因）：
 *     ① addCommentChrome 展开态固定 +50 —— 内容行根本没算（estimateTextSize 的输入
 *        已剥掉评论文本），改按行数算：标题25 + 行数×25 + padding24；
 *     ② 实测叶节点漏算自身 margin-bottom（rect.bottom 不含 margin），补上。
 *   - Bug4 自建长文卡高度调整不正常：钳制放宽 —— 实测路径 1200→4000、
 *     估算路径 900→2000（DOM 实测是真相，长文被钳死怎么点都不对）。
 *   - Bug3 fit 偶发无响应：保守策略（v0.14.9 机制保留），靠 Bug6 修复改善数据竞争面，
 *     复测仍现再定向修（方向 = setData 生效但渲染未跟随时也触发 loadFile）。
 *   - 测试 636 → 647（新增 BD1-BD11 + 更新 Z2.5/AC30 描述）
 *
 * v0.15.0 变更（删除级联 —— 用户确认「实时检测 + 默认关闭」方案）：
 *   - 删除 canvas 摘录卡时，同步清理三处残留：
 *       ① canvas 档案（autoSize / sidecar 自动边）—— 顺带清，无害
 *       ② webp 截图附件 —— 格式白名单 + 全 vault 引用计数，不误删
 *       ③ md 摘录文档条目 —— 按 ^ex-xxx 锚点定位整块删除
 *   - **默认关闭**：settings.autoCleanOnDelete = false，用户需在设置里主动开启。
 *     数据级操作默认不生效，出问题也只是"自己开了开关"。
 *   - **触发方式（实时）**：processCanvas 里 _lmbUpdateNodeMeta(cf, nodes) 顺带返回
 *     "本次消失的节点"（一次遍历同时更新档案 + 算出差集，不需要二次确认 ——
 *     nodes 本身就是刚从文件解析的当前状态）；开启清理时异步调 _lmbCleanupDeletedNodes。
 *     注意：另存轻量元数据档案（只存 {附件名, exId, pdf}，不存全文）—— canvasPositions
 *     只有位置没有 text，节点删除后 data.nodes 里就没了，不预存就拿不到清理目标。
 *   - **五道安全网**：
 *       ① 默认关闭开关
 *       ② 删除前写 .lmb-trash-log.md 备份（含 PDF / exId / 附件名 / 时间戳，可追溯恢复）
 *       ③ 附件格式白名单（只删插件命名的 <PDF名>-P<页>-<戳>.webp，用户自己的图不碰）
 *       ④ 全 vault 引用计数（其它笔记还引用就不删，避免 broken image）
 *       ⑤ Notice 汇总 + 全程 try-catch（单条失败只跳过，不中断、不抛错）
 *   - md 条目删除策略：找锚点行 → 向上到块起点、向下到块终点（含「相关：」行）+ 尾部
 *     空行；**找不到锚点就不动**（保守，防误删用户手写内容）
 *   - LMB_BAR_VERSION → v0.15.0
 *
 * v0.14.9 变更（写入改用内存数据 + 必要时主动重载画布 —— 修「点高度没反应」「跳回拖拽前」）：
 *   - v0.14.5 起只走「读文件→改→写文件」，带来两个副作用，正是用户这次反馈的现象：
 *       ① **文件落后于内存**：用户刚拖动卡片、Obsidian 还没落盘，我读到的文件是拖动前
 *          内容 → 改完写回 = **覆盖了用户的拖动**（症状「卡片跳回拖拽前的位置」）
 *       ② **Obsidian vault 监听不总触发**：数据改了但画面没刷（症状「点高度没反应」、
 *          「要点两下」、「拉伸一下才展开」—— 手动拉伸才让 Obsidian 落盘/重载）
 *   - **修法**：
 *       ① 以 canvas.getData() 的**内存最新数据**为准（含用户未落盘的改动），改 height 后
 *          setData 更新内存 + 用同一份数据写文件 → 不丢任何用户改动
 *       ② 等 250ms 看渲染跟上没；canvas 内存高度 ≠ 设定值时**主动 view.loadFile(file)
 *          强制重载画布**，不再干等 Obsidian 监听
 *   - LMB_BAR_VERSION → v0.14.9
 *
 * v0.14.8 变更（评论余量 + toolbar 文字统一 + 子节点 lock + 关闭自动截图附件）：
 *   - **评论余量**：检测文本含 lmb-comment callout → buffer 24→40（callout 底 padding+边框
 *     比普通行大），否则保持 24。用户反馈带评论卡片底行被裁。
 *   - **toolbar 4 按钮统一加两个字**（评论/跳转/视图/高度）：纯图标按钮看不清用途，
 *     图标+文字双信号更好认。CSS 把 .lmb-bar-fit 的横排规则共享给四个按钮。
 *   - **手动 fit「锁定」防覆盖**：archive 条目新增 `locked: true`。fitNode 看到 locked
 *     直接 return null，processCanvas 的估算不再覆盖手动 fit 值。
 *     用户反馈「子节点调整高度失效」即此原因。
 *   - **settings.autoAttachScreenshot**（默认 true）：关掉时跳过 captureRectImage 与
 *     img.embed 挂载，新摘录不再附 webp 截图 → 摘录更紧凑。用户嫌自动附件占空间。
 *
   - LMB_BAR_VERSION → v0.14.8
 *
 * v0.14.7 变更（递归时只记叶节点 —— 用户铁证「点击导致卡片越变越长」）：
 *   - **v0.14.6 仍被污染**：递归时记录每一层 bottom —— 但被 CSS min-height:100% 拉伸
 *     的中间容器（.markdown-preview-view 填满 .canvas-node-content）其 bottom 跟着
 *     卡片高度涨。用户实测序列 → 内容 164 → 186 → 208 → 230 → 252 ... 每次 +22px：
 *     这是「写文件 → 卡片高度变大 → 拉伸的中间容器 bottom 跟着涨 → 测量取 max 又
 *     设成更大高度」的正反馈循环 → 「高度越变越长」
 *   - **修法：只记录叶节点**（无 element children 的节点）。叶节点是真正由文字
 *     撑开、**不会被任何 CSS 拉伸规则污染**的真相（p / blockquote / callout 内容）。
 *     走「走到无 element 子节点为止才记录 bottom」路径，跳开所有被拉伸的中间容器
 *   - 保留 v0.14.6 合理性校验（实测 < 估算 60% → 估算值，防裁剪）
 *   - LMB_BAR_VERSION → v0.14.7
 *
 * v0.14.6 变更（递归测最深内容元素 —— 用户实测铁证「算出的高度和文字内容无关」）：
 *   - **用户的关键观察**：v0.14.5 测出的「内容 58px」与卡片文字量无关，只和卡片当前
 *     高度相关 → 证明**我测的直接子元素本身被 CSS 拉伸**（height:100% 填满卡片），
 *     它的 offsetHeight = 卡片高度，不是内容高度。测量对象仍然被污染。
 *   - **修法：递归遍历所有后代**，取最靠下的**可见**元素底部：
 *       ① 递归（不只直接子元素）—— 最深层的 p / blockquote / callout 内容才是由
 *         文字撑开、不会被拉伸的真相
 *       ② 只计 height > 0 的可见元素 —— 跳过 display:none 的隐藏块（比如切到文字
 *         视图时被藏起来的截图，不应计入高度）
 *       ③ 用 getBoundingClientRect 相对 content 顶部算偏移，**除以 canvas.scale**
 *         转回布局像素（rect 是缩放后的视觉尺寸）
 *   - **新增合理性校验**：实测值 < 估算值 60% 时改用估算值并提示（防止测量异常把卡片
 *     压得比内容还矮 → 内容被裁剪，比留白糟糕得多）
 *   - LMB_BAR_VERSION → v0.14.6
 *
 * v0.14.5 变更（放弃压缩 + 放弃 setData ——「回读 939 ✓ 但卡片没变」的最终解）：
 *   - **用户实锤数据**：fit 触发后 setData 写入了 data（getData 回读 = finalH ✓），
 *     但 canvas view 没重渲染。说明该环境 **canvas 不响应 setData+requestSave** —
 *     这是 Obsidian canvas 内部实现的差异，typings 不会告诉你。
 *   - **放弃压缩测量**：依赖 canvas 真的压到 60px 才有效；setData 无效 → 压缩空转 →
 *     scrollHeight = 原 939 - 24 buffer = 915 → fit 算出 = 当前高度，永远不变。
 *   - **放弃 setData**：唯一能驱动 canvas 重渲染的路径是「文件写 → Obsidian 原生 vault
 *     监听 → canvas view 重载」。两条通道独立，双写也无意义（一条就够），直接走一条。
 *   - **新测量方法**：不压缩，直接读「子元素 offsetTop + offsetHeight 之和 + padding」。
 *     offsetTop/offsetHeight 是子元素的真实布局位置，**不受父容器拉伸影响**（即使
 *     .canvas-node-content 被拉伸到 939，子元素还是文字 + 评论的真实位置和高度），
 *     完美避开「测被污染的容器高度」陷阱
 *   - **双回读 Notice**：文件回读 + canvas 内存回读，哪条通道生效一目了然
 *   - LMB_BAR_VERSION → v0.14.5
 *
 * v0.14.4 变更（Notice 说已设但卡片没变 —— setData 单通道失效，改双写 + 回读校验）：
 *   - 用户反馈：「卡片高度：260×262（内容 238px + 边距）」弹了，但**卡片实际没变** →
 *     测量、Notice、setData 全走了，唯独渲染/持久化没落地。
 *   - **根因判断**：v0.14.0 起我把「canvas 内部 API」设为优先后**完全跳过了文件写**，
 *     等于把所有赌注押在 setData+requestSave 上。该环境下它没有驱动画布更新。
 *   - **修法：双通道落盘 + 回读校验**
 *       ① setH(h, persist)：内部 API 照走；persist=true 时**额外写文件**（Obsidian
 *          原生 vault 监听会重载画布，是完全独立的第二条通道）
 *       ② 压缩阶段 setH(60, false) 不落盘（避免两次磁盘写抖动），最终 setH(finalH, true)
 *          双通道落盘
 *       ③ 写完后等渲染，重新 getData 回读该节点高度，Notice 同时显示
 *          「设定值 vs 回读值」（回读=设定 → setData 生效；不符 → 没生效）
 *   - LMB_BAR_VERSION → v0.14.4（浮层重建）
 *
 * v0.14.3 变更（功能验证通过，精简正常路径 Notice）：
 *   - 用户确认 fit 全链路通：探针序列「开始调整 → fit[5] → 卡片高度：358×519
 *     （内容 495px + 边距）」完整出现，压缩测量成功。
 *   - 正常路径精简为**一个结果 Notice**：移除入口探针「开始调整卡片高度…」与
 *     中间探针 fit[5]（两者是诊断期工具，使命完成）。失败路径的编号探针
 *     （fit[0]-[4]、Promise 异常、「未能测量内容高度」）**全部保留** —— 异常时
 *     依然每一步都说话。测量段自身有兜底不会静默，精简是安全的。
 *   - LMB_BAR_VERSION → v0.14.3（浮层重建，拿到精简版按钮）
 *
 * v0.14.2 变更（节点对象由调用方直传 —— 修复 fit[4] type=undefined）：
 *   - **编号探针实锤**：用户点按钮看到「fit[4] 在画布里找不到该节点或它不是文本卡
 *     (type=undefined)」→ canvas.nodes.get(nodeId) 返回了一个对象，但它**没有 type
 *     属性** —— 该环境的节点对象结构与社区 typings / 插件既有代码的预期不符。
 *   - **修法：不依赖反查，直传已验证对象**：
 *       ① _barCtx 增加 node 字段（tick 从 selection 拿的、经过
 *         `typeof n.text === "string"` 验证的节点对象）
 *       ② fit 分支 / 命令路径都改为 lmbFitNodeById(file, nodeId, node) 直传
 *       ③ lmbFitNodeById 优先用 nodeHint，拿不到才退化 canvas.nodes.get
 *       ④ type 检查放宽为 `typeof node.text !== "string"` —— 能 fit 的判据是
 *         「有文本可量」，不是某个特定字段的字面值
 *       ⑤ fit[4] 探针升级：命中时打印 node 的前 8 个 key（keys=[...]），
 *         未命中打印 nodeId 前 8 位 —— 若还断在这，诊断信息直接给答案
 *
 * v0.14.1 变更（全链路编号探针 —— fit 函数内部 4 个无声 early return 仍在静默退出）：
 *   - 用户 v0.14.0 反馈：只弹「开始调整卡片高度…」，后续全无（没压缩动画、没高度
 *     Notice、没失败 Notice）→ 探针证明进了 fit 分支，但 `lmbFitNodeById` 在内部的
 *     **4 个无 Notice 的 early return** 之一静默退出了（缺参数 / 无 ctx / 无 canvas /
 *     节点不存在或非 text）。v0.13.9 只探了分支入口，函数内部仍是黑盒 ——
 *     「让每一步都说话」在入口做了，内部却漏了。
 *   - **修法：编号探针**。lmbFitNodeById 每个 early return 都弹带编号的 Notice：
 *       fit[0] 未返回 Promise（typeof 打印）      / fit 调用异常（<message>）
 *       fit[1] 缺少 file 或 nodeId
 *       fit[2] 拿不到画布上下文
 *       fit[3] 拿不到 canvas 对象或 nodes
 *       fit[4] 找不到该节点或非文本卡（打印 type 或 id 前 8 位）
 *       fit[5] 节点已定位开始测量（正常路径标记）
 *       fit Promise 异常（<message>）
 *     用户点一次按钮，看到哪个编号，断点就在哪 —— 无需再猜。
 *   - LMB_BAR_VERSION → v0.14.1（触发浮层重建，确保探针版按钮生效）
 *
 * v0.14.0 变更（压缩测量 —— 「高度永远不变」的最终解）：
 *   - 用户 v0.13.9 反馈的关键信息：toolbar 探针 Notice 弹了（**悬浮栏链路是通的**，
 *     v0.13.8 版本化生效）→ 问题收敛到最后一层：fit 算出的高度 = 当前高度。
 *   - **根因**：processCanvas 老逻辑早就把 node.height 设过一个大值 →
 *     .canvas-node-content 被 CSS 拉伸填满整个节点 → 它的 scrollHeight ≈ 节点高度
 *     （**连下方那片空白一起算**）→ 直接读 scrollHeight = 当前高度 → 永远"不变"。
 *     用户卡片下方的那片空白，恰恰就是被算进 scrollHeight 的元凶 —— 测量对象本身就是
 *     被污染的。
 *   - **解法：压缩测量**。先把 node.height 压到 60px（setData + requestSave 真渲染）→
 *     等两帧 + 60ms → 此时容器不再有空白、内容自然溢出 → 此时的 scrollHeight 才是
 *     内容真正需要的最小高度 → finalH = naturalH + 24 buffer → 再 setH(finalH)。
 *     副作用：点击瞬间卡片先缩小再弹开（约 120ms），测量原理决定，可接受。
 *   - 测不到（naturalH = 0）→ 恢复原高度 + Notice「未能测量内容高度，已恢复原高度」，
 *     绝不假装成功。内部 API 不可用时整体退回 estimateSizeFor 文件写路径。
 *   - 另：命令面板入口用户反馈"没反应"待查 —— 但 toolbar 链路已通且功能等价
 *     （lmbFitNodeById），先以 toolbar 为主入口推进。
 *
 * v0.13.9 变更（命令面板独立入口 + 链路探针 —— 悬浮栏排查 5 版无果后的二分手段）：
 *   - **新增命令「调整选中卡片高度（按内容自适应）」**（id: fit-card-height）：
 *     完全不依赖悬浮栏 —— 命令面板是 Obsidian 最稳的入口。选卡复用现成的
 *     pickCanvasNode（已选中一张直接用；没选中/多选弹模糊搜索列表让用户挑）。
 *     用途是**二分定位**：命令能用 → 问题锁定在悬浮栏链路；命令也坏 → fit 逻辑问题。
 *     同时它本身就是一个永久可用的备选入口（悬浮栏坏了也有路走）
 *   - **fit 分支开头加链路探针 Notice**「开始调整卡片高度…」（900ms）：
 *     弹了 = 回调链路通（问题在 fit 逻辑）；没弹 = 回调根本没进 fit 分支
 *     （按钮 DOM / 事件分派问题）
 *   - LMB_BAR_VERSION → v0.13.9（触发浮层重建，确保用户拿到带探针的新按钮）
 *
 * v0.13.8 变更（悬浮栏版本化 —— "代码改了、插件也重载了，行为却还是老样子"的根因）：
 *   - **根因**：重载插件时 Obsidian 只重新执行插件 JS，**workspace layout 与 canvas leaf
 *     的 DOM 不会被重建**。而 lmbEnsureCanvasBarEl 是靠 className 幂等复用浮层的 ——
 *     于是「某个旧版本造的那颗浮层」会被新代码一直复用，**它的按钮绑的是旧版 click
 *     回调**（如 v0.13.4 的 fit 按钮绑的是 `if (!c) return` 静默版，v0.13.7 的 Notice
 *     补丁对它完全无效）。表现极其迷惑：源码明明改了、也重载了，行为却是老样子。
 *   - **修法**：新增常量 LMB_BAR_VERSION（26-pure-canvasbar.js）。三层防线：
 *       ① 建浮层时打 `dataset.lmbBarVer = LMB_BAR_VERSION`
 *       ② lmbEnsureCanvasBarEl 复用前校验版本，不匹配就 remove 重建
 *       ③ lmbStartCanvasBarWatch 启动时调新增的 _lmbPurgeStaleBars()，
 *          全局清掉所有版本不匹配的旧浮层（覆盖其他 canvas leaf 上残留的）
 *   - ⚠️ 维护约定：**以后改浮动栏的按钮组成或事件绑定方式，必须把 LMB_BAR_VERSION +1**，
 *     否则用户手上的浮层不会更新（会一直用旧按钮、旧回调）
 *
 * v0.13.7 变更（堵死两处静默失败 —— 用户反馈"Notice 都没弹"）：
 *   - **① _barCtx 为空时即时重建，不再静默 return**：轮询每 120ms 跑，而 canvas
 *     getSelection() 会**间歇性**返回空（焦点切换 / Modal 开关 / canvas 内部 state
 *     刷新）。那一刻 tick 走 _lmbHideBar() 把 _barCtx 清成 null；下次 tick 重建
 *     （最多 120ms 后）之前用户点按钮 → 拿到 null → 旧版 `if (!c) return` 直接退出，
 *     **连 Notice 都不弹**。
 *     新增 _lmbRebuildBarCtx()：绕开轮询缓存，直接从当前选中重新解析一次
 *     （只认"恰好 1 个 text 节点"，与 tick 判定一致）。仍空才 Notice「没找到选中的卡片」
 *   - **② lmbFitNodeById 内部异常不再静默吞掉**：旧版最外层是 `catch (_) {}`，
 *     里面任何一步抛错（getData 不存在 / autoSize 未初始化 / vault 读取失败…）都被吞。
 *     现在改成弹 Notice「调整高度失败：<message>」+ console.warn，任何异常都暴露
 *
 * v0.13.6 变更（fit 按钮"按了没反应"的真根因 —— 改了数据但没触发 canvas 刷新）：
 *   - **真根因**：lmbFitNodeById / _actualFitRetryForFile 走的是「读文件 → 改 data.nodes →
 *     写文件」，改完 live node 的 width/height 后**没调 canvas.requestSave()** → canvas
 *     内部 state 不刷新 → 磁盘上尺寸改了，但**画面上什么都没变**。
 *     而 instantAttach（v0.5.0 起）早就证明正确路径是 canvas 内部 API：
 *       getData() 读内存 → setData(data) 写回 → requestSave() 触发保存 + 重渲染（毫秒级）
 *     本项目自己就有这个成熟模式（31-plugin-selection.js 的 instantAttach / instantMoveAttach
 *     都在用），写 fit 按钮时却没沿用 —— 属于"自己项目里已有正确答案却另起炉灶"。
 *     现在两处都改成：优先 canInternal（getData/setData/requestSave 三者都有才用），
 *     内部 API 不可用时回退文件写（vault.adapter.write + selfWritten）
 *   - **修二次点击改坏高度**：lmbFitNodeActual 返回新尺寸时会顺手写 store，导致第二次
 *     点击必然命中 unchanged → 旧版 fallback 到 estimate，把已调好的高度改坏。
 *     现在 unchanged 直接 return null + Notice「已是合适高度：W×H」，绝不动
 *
 * v0.13.5 变更（fit 按钮带文字 + 三层保险 + retry 多试一次）：
 *   - **fit 按钮加「高度」文字**（v0.13.4 的 move-vertical 双向上下箭头用户还是误认为切图）：
 *     mk 增加可选 withText 参数，fit 按钮传 "高度"；CSS 给 .lmb-bar-fit 单独规则
 *     （width:auto, padding 0 8px, gap 4px），加 .lmb-bar-text 文字样式（11px / 中等字重）。
 *     用户看图标 + 文字"高度"立刻明白，不再混淆
 *   - **lmbFitNodeById 三层保险**（用户反馈"按了没反应"）：① 等 nodeEl 就绪
 *     _lmbWaitForNodeEl（30ms 步进、最长 500ms，避免 markdown 还在 layout 时拿到 null）；
 *     ② actual 失败回退 estimateSizeFor（v0.13.3 修了 lmbRenderedText，估算现在挺准）；
 *     ③ 发 Notice 告知用户实际尺寸 + 数据来源（actual / estimate / unchanged），
 *     永远有反馈
 *   - **_actualFitRetryForFile 200ms 多试一次**：retry 第一次可能 actual 仍为 null
 *     （markdown 异步渲染第二次才好），等 200ms 再测。仍失败就用 prev（已是估算值，
 *     反正比 v0.13.4 什么都不做要好）
 *
 * v0.13.4 变更（卡片过高真修复 + fit 按钮图标换）：
 *   - **修"直接摘录卡片还是太高"的根因**：v0.13.3 修了 lmbRenderedText，但没修时序——
 *     processCanvas（拖入后 600ms 兜底触发）跑的时候，新节点的 nodeEl 还没填充
 *     （canvas reactive 异步渲染），fitNode 走估算（仍偏大）→ 估算值被写文件永久化。
 *     即使用户立刻点 fit 按钮重测，估错值已落到 autoSize store，下次 fitNode 命中
 *     hash 相等就跳过（"已适配或用户手动调整过"那个 return null）。
 *     修法：processCanvas 末尾调度 _scheduleActualFitRetry（250ms 后），等 canvas
 *     渲染完成跑 _actualFitRetryForFile：实际测每张卡的 scrollHeight → 若新尺寸与
 *     档案不同则改档案 + 写文件。每文件独立 timer 防抖，processCanvas 连续跑也安全
 *   - **fit 按钮图标改 chevrons-down-up**（v0.13.3 是 arrow-down-to-line）：
 *     用户反馈"看着像切换图片/文字视图"——arrow-down-to-line 是一个向下箭头到水平线，
 *     lucide 里画出来确实像"图片占位符 + 底线"。换成 chevrons-down-up 双向下上箭头，
 *     语义直白（"上下高度调整"），不会与 view 按钮（image 图标）混淆
 *
 * v0.13.3 变更（卡片高度自适应 + 手动 fit 按钮）：
 *   - **修复卡片底部留白**：v0.8.3 的 lmbRenderedText 是空实现（"原样返回"），导致
 *     estimateTextSize 把折叠态的「添加评论」按钮行按字符行高（25px/行）算高度，
 *     与实际渲染（≈30px）不一致；展开态的 lmb-comment 也没被估算高度
 *     → 卡片底部大量空白。改为 lmbRenderedText **真的剥离** ppd-note / lmb-view /
 *     lmb-comment 三种辅助 callout，让 estimateTextSize 只算纯文本行；
 *     callout 自占的空间由 estimateSizeFor 的 addNoteChrome（已存在，ppd-note +46px）
 *     和新增的 addCommentChrome（lmb-comment：折叠态 +30、展开态 +50）单独加
 *   - **新增 lmbFitNodeActual**：DOM 是真相。实际测 .canvas-node-content 的
 *     scrollHeight + canvas 节点 padding buffer 24px，设回 node.height。fitNode 优先
 *     走 actual（节点已渲染时），未渲染或 DOM 拿不到时回退 estimateSizeFor 估算
 *   - **悬浮栏新增第 4 个按钮「自适应高度」**（lmb-bar-fit，图标 chevrons-down-up）：
 *     手动按实际 DOM 高度 fit 一张卡片。点击后调 lmbFitNodeById → lmbFitNodeActual →
 *     直接写回 canvas json（不依赖 canvas reactive 自动保存）。applyCardComment
 *     评论保存链路已自动调 fitNode（评论改后卡片高度自动跟随）。
 *     v0.13.3 试过 arrow-down-to-line（向下到线的箭头），用户反馈"看着像切图"，
 *     v0.13.4 换成双向下上箭头 chevrons-down-up，语义更直白
 *
 * v0.13.2 变更（竖排 + 贴卡片左侧 + 展开态评论正常显示）：
 *   - 悬浮栏竖排（flex-direction: column）+ 贴卡片左外侧：v0.13.1 是横排 + 卡片上方，
 *     用户反馈贴左更顺手、视觉上更像"卡片的"工具栏。默认 left = relLeft − barW − gap
 *     （卡片左边缘外侧）、top = relTop（顶端对齐卡片顶端）；左侧空间不够退到卡片
 *     内侧左侧（placement "left" / "inside"，不再有 "top"）。新增 wrapper 高度
 *     钳制 —— 竖排后浮层最高 86px
 *   - **修复 v0.13.1 的真 bug**：上一版用 `.callout[data-callout="lmb-comment"]` 全藏，
 *     结果**展开态的评论内容也被藏了**，用户加完评论在卡片里看不到、只能进编辑界面
 *     才能看到。这不是有意设计，是 bug。改为只藏**折叠态**（按钮形态），用
 *     `:not(:has(.callout-content))` 精准匹配；展开态评论内容正常显示在卡片里。
 *     lmb-view callout 仍然全藏（入口在悬浮栏）
 *   - z-index 1000 → 9999：防御被 canvas 节点遮挡（canvas 的 zIndexCounter 可顶
 *     到 1000+，v0.13.1 的 1000 不够）
 *   - 三个按钮动作后**立即**触发 tick（不等 120ms 自然 tick）：
 *       comment 走 Promise.then（等 LMBNoteModal 关闭）
 *       jump 同步触发（canvas leaf 可能失焦切到 PDF leaf）
 *       view 走 setTimeout(0)（等 toggleCardView 改完 host class）
 *     这是 v0.13.1 指针守卫之外的**第二道保险** —— 守卫保住按下时选中，但 Modal
 *     关闭这种纯逻辑事件守卫拦不到，只能靠这里主动 tick
 *
 * v0.13.1 变更（悬浮栏：卡内入口收拢 + 左上对齐 + 点击失效修复）：
 *   - 卡片只留摘录内容：canvas 卡内的「添加评论」栏与「文字/图片切换」按钮隐藏。
 *     用 display:none 而非移除 DOM —— 元素还在，故 toggleCardView() 靠 querySelector
 *     反查宿主仍然有效，且卡片 markdown 一字未改、导出摘录 md 不受影响。
 *     只作用于 canvas 节点；md 阅读视图保留原入口（那边没有悬浮栏接管）
 *   - 悬浮栏改为「卡片左上角」：左边缘与卡片对齐，默认浮在卡片上边缘外侧；
 *     卡片贴着容器顶边时退到**内侧**左上角（刻意不翻到下方，那就成左下角了）
 *   - 修复「按钮点过一次就失效」：_lmbHideBar() 会清掉 _barCtx 却**不**重置指纹，而
 *     _barCtx 只在指纹变化时才重建 → 点击瞬间 canvas 选中被清空再恢复、指纹未变 →
 *     上下文永不再建 → 按钮点了没反应。改为「指纹变化 **或** 上下文丢失」都重建
 *   - 加浮层指针守卫：document **捕获**阶段拦 pointerdown / mousedown（只拦传播、
 *     不 preventDefault），让 canvas 在按下瞬间就收不到事件，从源头保住选中状态。
 *     挂按钮自身拦不住 —— document 的捕获比元素自身的捕获更早执行
 *
 * v0.13.0 变更（canvas 卡片悬浮操作栏）：
 *   - 选中 canvas 里的一张摘录卡 → 卡片正上方浮出一条操作栏，三个按钮：
 *     评论 / 跳回 PDF / 切换文字·图片视图。三者分别复用 v0.11.0 / v0.9.1 / v0.11.3
 *     的既有实现（editCommentForNode / lmbParsePdfLink+lmbJumpToSelection /
 *     toggleCardView）—— 本版本只是把入口从卡内搬到悬浮栏，未重写任何业务逻辑
 *   - 新增 src/26-pure-canvasbar.js：lmbCalcBarPos（坐标换算，含贴顶翻下方与左右钳制）、
 *     lmbPickBarActions（按卡片内容决定显示哪些按钮，不放点了没反应的死按钮）、
 *     lmbBarSignature（轮询指纹：节点 id 排序 + viewport 取 2 位小数防浮点抖动）
 *   - 新增 src/37-plugin-canvasbar.js：浮层创建 / 轮询 / 动作派发
 *   - 关键设计：浮层挂 canvas.wrapperEl（.canvas-wrapper）而非卡片 —— canvas 的
 *     transform:scale() 加在 .canvas 上，wrapper 是其父级、不参与缩放，故按钮尺寸恒定
 *   - canvas 无原生选中事件（advanced-canvas 的 selection-changed 是它自己 monkey-patch
 *     出来的，要引 monkey-around 依赖），故用 120ms 轮询。一次轮询同时解决两件事：
 *     选中变化重建按钮、视口平移缩放重算位置。位置每轮都算（getBoundingClientRect 只读
 *     两个元素，很便宜），按钮只在指纹变化时才动 DOM
 *   - 只服务「恰好选中 1 个文本节点」：没选中 / 多选 / group 节点一律不显示
 *     （多选取第一个容易误操作，不如干脆不显示）
 *
 * v0.12.1 变更（工具栏宿主解析层重构 —— 借鉴 editing-toolbar v4.1.1）：
 *   - 新增 src/25-pure-toolbar.js：视图规格表 LMB_VIEW_SPECS（判定 + 选择器**同源**，
 *     不学 editing-toolbar 拆两张表导致 meld-encrypted-view / meld_encrypted_view
 *     字符串不一致、选择器表变死代码）、lmbResolveToolbarAnchor（映射表 → 兜底
 *     .view-content 首个子 div → 放弃）、LmbDomCache（isConnected 失效校验，
 *     key 必须带 leaf 标识）、lmbSetToolbarVisibility（display / visibility 分级）
 *   - 新增 src/11-styles.js：CSS 全部从 injectStyles() 抽出为 LMB_STYLES，
 *     并新增 per-view-type 适配段（视图差异交给 CSS，加视图类型不改 JS）
 *   - 时序修复：兜底宿主只在重试**最后一轮**（tries>=8）才放行。此前若在第 1 轮就
 *     放行，pdf.js 的 .pdf-toolbar 尚未渲染时会把按钮挂进 .view-content 内容区，
 *     且该错误宿主被写进缓存 → 真工具栏出现后缓存命中，按钮永远迁移不回来
 *   - 行为不变：三个工具栏按钮的功能、位置、视觉与 v0.12.0 完全一致
 *
 * v0.12.0 变更（工具栏双按钮 / 回绘 Observer 根因修复 / 卡片精简）：
 *   - PDF 工具栏新增「打开摘录 md」「打开专属 canvas」两按钮（打开或创建，
 *     <PDF名>-摘录.md / <PDF名>.canvas，与 PDF 同目录，点击时实时反查所在 leaf）
 *   - 回绘标记「有时显示/不显示/延迟」根因修复：lmbDrawMarksForView 在页面未渲染
 *     提前 return 时 Observer 从未挂上 → 现在只要有文件先挂 Observer（幂等）
 *   - 卡片精简：引用行 📖 化（lmbBookLink 收拢 / lmbRestoreRefDisplayName 导出还原
 *     全名）；lmb-view 切换按钮图标化 + float 与评论栏同行；lmb-comment 图标改
 *     message-square；新卡不再自动挂 ppd-note 空占位（一次性迁移标记
 *     notePlaceholderOffMigrated，手动添加能力保留，存量卡不动）；间距整体压紧
 *
 * 功能：
 *   1. 文字选区 → 手柄 → md 引用块 / canvas 文本卡
 *   2. 图片框选（三选一）：
 *      a) PDF 顶部工具栏「框选」按钮（PDF++ 式 crop 按钮，v0.11.2 新增）
 *      b) 侧边栏 ribbon 按钮「图片框选」
 *      c) Alt + 拖拽
 *      a/b 一次性：点击 → 拖拽截图 → 自动复原（v0.11.3 定版）；Esc 随时可关；
 *      松手后直接裁剪页面渲染画布，存为 webp 附件 → 拖拽生成 ![[xxx.webp]]
 *   3. 双重摘录（v0.11.3）：文字选区拖拽时自动同时截一张选区区域图，
 *      有文字 → 卡片默认文字摘录，卡上挂 lmb-view 切换按钮，点击在
 *      文字/图片显示间切换（CSS 显隐，卡片宽度不变）
 *   4. 回跳链接 selection=文本层索引（沿用 PDF++ 的 URL 参数约定以兼容存量笔记，
 *      解析/生成本插件自理），点击高亮定位
 *   5. Canvas 摘录卡自动适配内容大小（图片卡按截图真实宽高比；尊重手动调整）
 *   6. Canvas 变更 → 自动创建/同步「<PDF名>-摘录.md」（canvas 主本 → md）
 *
 * v0.11.4 变更（框选路径也走双重识别）：
 *   - 框选截图完成后，用页面 textLayer DOM 与选区矩形求交集提取文字
 *     （extractRectText，零 OCR / 零 pdfjs API，按行聚合）；
 *     提到文字 → 双重卡（rect= 回跳链接 + 文字引用块 + 截图 + lmb-view 切换按钮，
 *     默认文字视图）；提不到 → 纯截图卡（原行为）
 *   - 与划选路径殊途同归：无论从哪个入口摘录，只要区域里有文字就能文/图切换
 *
 * v0.11.3 变更（框选一次性复原 + 双重摘录 + 卡片视图切换）：
 *   - 框选模式回到一次性：截图成功后自动 setRectMode(false)，需再点按钮再截
 *   - mouseup 文字选区 → captureSelectionImage 用选区外接矩形截图（失败降级纯文字）；
 *     buildDropText 双重格式 = 引用块 + 截图 embed + lmb-view 切换 callout + ^ex
 *   - lmb-view callout = 卡上的切换按钮（点击 toggleCardView 切 host class）；
 *     CSS :has 识别双重卡默认藏图，.lmb-view-img 切到图片视图藏引用块；
 *     不改节点文本 → fitNode 不触发 → 宽度固定
 *   - lmbSplitNote 跳过 lmb-view（防被当成补充描述破坏自动挂框/编辑）；
 *     摘录 md 同步剥掉 lmb-view 行；estimateSizeFor 双重卡取文字/图片布局较大高
 *
 * v0.11.2 变更（PDF 工具栏框选按钮 + 工具栏收紧）：
 *   - 往 Obsidian 原生 .pdf-toolbar 注入「图片框选」按钮（box-select 图标，
 *     is-active 高亮），点击即开/关框选模式 —— 摆脱每次按 Alt / 去侧边栏找按钮
 *   - CSS 收紧 PDF 工具栏：.pdf-toolbar gap/按钮边距压缩，顶部一排不再松散
 *   - build.js 自动部署到 vault 插件目录（修复「改了没效果」—— 之前从未部署）
 *
 * v0.11.0 变更（首连锁定 / 改挂侧 / 乱放根因修复 / 独立评论体系）：
 *   - R1 乱放根因修复：instantAttach 用落下时的默认小尺寸组居中 → fitNode 随后撑大卡片
 *     → 高度变了 y 不变 → 中心偏出父卡轴线。新增 lmbRecenterNode：fitNode/补充描述/
 *     评论改变尺寸后按自动父边做组内重新居中
 *   - R3 首连锁定（lmbPlanAutoLink）：一张卡只自动建一条连线；已有自动边后压中其他卡
 *     不再换父、不再新建（换父已移除，想换父手动删线重拖）；手动边不参与锁定
 *   - R4 改挂侧（lmbApplyReside）：拖回已连线的卡上 → 按落点方位改边端点（上下左右）
 *     + 新旧两侧组重排；同侧重拖 = 重新对齐
 *   - R2 独立评论体系（lmb-comment callout，仿 PDF Flow 批注底栏）：新卡自动挂评论栏
 *     （可关）、canvas 里点评论栏直接弹编辑框、ribbon/命令/批量入口齐全；
 *     与补充描述是两套独立数据，摘录 md 同步时两者都剥离
 *
 * v0.10.0 变更（与 PDF++ 彻底解耦）：
 *   - 删除「借 PDF++ 选框出 chip」的跟踪层（_ppBox/seenBoxes/onDocMouseMove/
 *     mouseup 路径①②）；图片框选只走自带 Alt+拖拽 / 侧栏按钮，文字选区走
 *     原生 getSelection —— 零 PDF++ DOM 读取、零插件对象访问
 *   - 品牌 / id / 类名 / 命令 id 全量更名：lucias-marginbook / lmb-*
 *   - 数据格式不变：ppd-note callout、<!-- ppd-note-start/end --> 旧锚点、
 *     selection=/rect= 链接参数原样保留（存量笔记零迁移）
 *
 * v0.3.0 变更（MarginNote 4 借鉴改造，三路补丁合入）：
 *   - P0-1 内容寻址 exId：同一选区重复拖拽 → 同一 ^ex id → 引用计数正确、
 *     canvas 卡按 id 去重（卡片轴心架构的地基）
 *   - P1-3 摘录文档按页分组（## P.N 标题）：Obsidian 核心大纲插件自动获得
 *     摘录大纲视图（P2-7 免费达成）；frontmatter 增加 updated 时间戳
 *   - P1-4 相关笔记检索（MN4「标题链接」平替）：新摘录自动查全库元数据，
 *     命中 ≥2 个分词的 top3 写入「> 相关：」行，纯本地零 AI
 *   - P1-5 颜色语义：设置页映射表 + annotationLayer 高亮色探测（best-effort，
 *     探不到静默跳过），命中映射时摘录卡自动附 #标签
 *   - P2-6 Recall 回忆模式：阅读模式模糊含【*-P.N】的引用块，点击揭示 3 秒
 *   - 新增命令：recall-toggle / open-excerpt-doc
 *
 * 已知边界：
 *   - 截图分辨率 = 当前缩放下的屏幕像素（放大后再框选更清晰）
 *   - md 落点需为编辑模式；canvas 尺寸估算近似
 *
 * 调试：console 前缀 [lmb]；Notice 调试链可在设置里关闭。
 * ============================================================================
 */

"use strict";

/* ============================================================
 * 10-constants —— 正则与数据格式常量
 * 修改注意：ppd-note / lmb-comment / selection= 是数据格式字面量，
 * 改了会破坏存量笔记，动前先确认。
 * ============================================================ */

const { Plugin, Notice, TFile, PluginSettingTab, Setting, normalizePath, Modal, FuzzySuggestModal, setIcon } = require("obsidian");
const EX_ID_RE = /\^ex-[0-9a-z]{4,8}/;
