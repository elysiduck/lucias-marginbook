/* 41-settings-tab —— 设置页 */

/* ==================== 设置页 ==================== */

class LMBSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("当前运行版本")
      .setDesc((this.plugin.manifest && this.plugin.manifest.version || "0.48.0") + " · " + (this.plugin.isMobile ? "iPad / 移动端" : "桌面端"));
    new Setting(containerEl)
      .setName("调试提示（Notice）")
      .setDesc("在屏幕上显示每一步检测结果，用于定位问题。稳定后可关闭。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.debug)
        .onChange(async (v) => { this.plugin.settings.debug = v; await this.plugin.saveSettings(); }));
    containerEl.createEl("h2", { text: "AI 词汇卡" });
    containerEl.createEl("p", { text: "PDF 选中单词或短语后，点击浮动工具条的「Aa 查词建卡」。支持兼容 Chat Completions 的接口。只在主动查词或测试连接时发送请求；按服务商计费。" });
    new Setting(containerEl).setName("API 接口地址")
      .setDesc("填写服务商的基础地址（含 /v1 等路径），或完整的 /chat/completions 地址。")
      .addText(t => t.setPlaceholder("https://dashscope.aliyuncs.com/compatible-mode/v1")
        .setValue(this.plugin.settings.wordAiUrl || "")
        .onChange(async v => { this.plugin.settings.wordAiUrl = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("API Key")
      .setDesc("保存在本地插件 data.json 中，未加密；若同步插件配置，也会同步此密钥。本地免密服务可以留空。")
      .addText(t => { t.inputEl.type = "password"; t.inputEl.autocomplete = "off";
        t.setPlaceholder("服务商提供的密钥").setValue(this.plugin.settings.wordAiKey || "")
          .onChange(async v => { this.plugin.settings.wordAiKey = v.trim(); await this.plugin.saveSettings(); }); });
    new Setting(containerEl).setName("模型名称")
      .setDesc("填写服务商支持的模型 ID，例如 qwen-flash。")
      .addText(t => t.setPlaceholder("qwen-flash").setValue(this.plugin.settings.wordAiModel || "")
        .onChange(async v => { this.plugin.settings.wordAiModel = v.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName("发送原句语境")
      .setDesc("开启时发送选中词附近的少量 PDF 原文，用于判断本句词义；关闭后只发送选中的单词或短语。")
      .addToggle(t => t.setValue(this.plugin.settings.wordAiContext !== false)
        .onChange(async v => { this.plugin.settings.wordAiContext = v; await this.plugin.saveSettings(); }));
    let promptInput;
    const promptSetting = new Setting(containerEl).setName("自定义生成要求")
      .setDesc("默认含 7 个助记示例。可编辑翻译、例句和助记的生成风格，自动保存；留空使用默认要求。无需编写 JSON。修改只影响后续查询，已有卡片需主动重新生成并确认替换。")
      .addTextArea(t => {
        promptInput = t;
        t.setValue(lmbWordPrompt(this.plugin.settings.wordAiPrompt));
        t.inputEl.rows = 18; t.inputEl.maxLength = 16000;
        t.inputEl.style.cssText = "width:100%;min-height:280px;resize:vertical;font-size:13px;line-height:1.65;";
        t.inputEl.setAttribute("aria-label", "AI 词汇卡自定义生成要求");
        t.onChange(async v => { this.plugin.settings.wordAiPrompt = v; await this.plugin.saveSettings(); });
      });
    promptSetting.settingEl.style.flexWrap = "wrap";
    promptSetting.controlEl.style.cssText = "width:100%;flex:1 1 100%;margin-top:12px;";
    new Setting(containerEl).setName("恢复默认生成要求")
      .setDesc("恢复内置助记规则及全部示例，不改动接口配置和已有卡片。")
      .addButton(b => b.setButtonText("恢复默认").onClick(async () => {
        this.plugin.settings.wordAiPrompt = LMB_WORD_DEFAULT_PROMPT;
        promptInput.setValue(LMB_WORD_DEFAULT_PROMPT);
        await this.plugin.saveSettings(); new Notice("已恢复默认生成要求及 7 个助记示例");
      }));
    new Setting(containerEl).setName("测试 AI 连接")
      .setDesc("发送一次 example 查词请求，检查接口和返回格式；不创建卡片，可能产生少量费用。")
      .addButton(b => b.setButtonText("测试连接").onClick(async () => {
        b.setDisabled(true); b.setButtonText("测试中…");
        try { await this.plugin.lmbQueryWord("example", ""); new Notice("AI 连接成功，词汇卡格式正常"); }
        catch (error) { new Notice("AI 连接测试失败：" + error.message); }
        finally { b.setDisabled(false); b.setButtonText("测试连接"); }
      }));
    // 补丁 B：颜色语义映射
    new Setting(containerEl)
      .setName("颜色语义映射")
      .setDesc("每行一条：rrggbb=标签名（如 fff3a3=核心观点）。PDF 高亮注释的背景色命中映射时，"
        + "拖出的摘录卡会自动附带 #标签名。留空 = 禁用（行为与旧版一致）。")
      .addTextArea((t) => {
        t.setValue(this.plugin.settings.colorMap || "")
          .setPlaceholder("fff3a3=核心观点\na3f3ff=待验证\ncffcfc=反例");
        t.inputEl.setAttribute("rows", "4");
        t.inputEl.style.width = "320px";
        t.inputEl.style.fontFamily = "var(--font-monospace, monospace)";
        t.inputEl.style.fontSize = "12px";
        t.onChange(async (v) => {
          this.plugin.settings.colorMap = v;
          await this.plugin.saveSettings();
        });
      });
    // 补丁 C：回忆模式默认开启
    new Setting(containerEl)
      .setName("回忆模式默认开启")
      .setDesc("插件加载时自动开启回忆模式（阅读模式中模糊摘录，点击揭示）。")
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.recallDefault)
        .onChange(async (v) => { this.plugin.settings.recallDefault = v; await this.plugin.saveSettings(); }));

    containerEl.createEl("h2", { text: "PDF 手写批注" });
    new Setting(containerEl)
      .setName("书写输入")
      .setDesc("“触控笔和鼠标”适合桌面；“仅触控笔”可防止鼠标误画。手指始终交给 PDF 滚动和双指缩放。")
      .addDropdown((d) => d
        .addOption("pen-mouse", "触控笔和鼠标")
        .addOption("pen-only", "仅触控笔")
        .setValue(this.plugin.settings.inkInputMode === "pen-only" ? "pen-only" : "pen-mouse")
        .onChange(async (v) => { this.plugin.settings.inkInputMode = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("笔压效果")
      .setDesc("自然压感保留提按、顿笔与轻收尖锋，适合汉字书写；钢笔效果的粗细变化较克制；固定宽度适合画图。只影响新笔迹。")
      .addDropdown((d) => d
        .addOption("natural", "自然压感 · 细腻笔锋")
        .addOption("fountain", "钢笔效果")
        .addOption("fixed", "固定宽度")
        .setValue(this.plugin.settings.inkPressureMode || "natural")
        .onChange(async (v) => { this.plugin.settings.inkPressureMode = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("跟笔稳定")
      .setDesc("抑制细小偏移；提按、确认转向和顿笔微调时减弱阻尼以保留细节。轻档更跟手，标准更稳；只影响新笔迹。更多设置中也能调整。")
      .addDropdown(d => d.addOption("0", "关闭").addOption("1", "轻").addOption("2", "标准").addOption("3", "强")
        .setValue(String(lmbInkStabilityLevel(this.plugin.settings.inkStabilization)))
        .onChange(async value => { this.plugin.settings.inkStabilization = Number(value); await this.plugin.saveSettings(); this.plugin.lmbRenderInkTools(); }));
    new Setting(containerEl)
      .setName("橡皮命中范围")
      .setDesc("局部／整笔橡皮的半径（屏幕像素）；可在手写工具栏的更多设置中切换模式。")
      .addSlider((s) => s.setLimits(8, 48, 2).setDynamicTooltip()
        .setValue(Number(this.plugin.settings.inkEraserSize) || 18)
        .onChange(async (v) => { this.plugin.settings.inkEraserSize = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("橡皮模式")
      .addDropdown(d => d.addOption("partial", "局部擦除").addOption("stroke", "整笔擦除")
        .setValue(this.plugin.settings.inkEraserMode || "partial")
        .onChange(async value => { this.plugin.settings.inkEraserMode = value; await this.plugin.saveSettings(); this.plugin.lmbRenderInkTools(); }));
    new Setting(containerEl)
      .setName("擦完自动回到画笔")
      .setDesc("一次擦除结束后回到之前的画笔；关闭后可以连续擦除。")
      .addToggle(t => t.setValue(this.plugin.settings.inkEraserAutoReturn !== false)
        .onChange(async value => { this.plugin.settings.inkEraserAutoReturn = value; await this.plugin.saveSettings(); this.plugin.lmbRenderInkTools(); }));

    /* ---- v0.14.8 / v0.15.0：摘录附件与删除清理 ---- */
    containerEl.createEl("h2", { text: "摘录卡片与附件" });

    new Setting(containerEl)
      .setName("Canvas 摘录卡统一宽度")
      .setDesc("新拖入 Canvas 的摘录卡统一使用该宽度；之后手动调整的宽度会被保留。")
      .addSlider((s) => s
        .setLimits(320, 800, 20)
        .setDynamicTooltip()
        .setValue(Math.max(320, Math.min(800, Number(this.plugin.settings.excerptCardWidth) || 560)))
        .onChange(async (v) => { this.plugin.settings.excerptCardWidth = v; await this.plugin.saveSettings(); }));

    new Setting(containerEl)
      .setName("新摘录自动附截图")
      .setDesc("拖出摘录时一并截取选中区域存成 webp 附件（卡片可在「文字 / 图片」视图间切换）。"
        + "关闭后新摘录只有文字，卡片更紧凑、也不占 vault 空间。"
        + "注意：关闭不影响已有的双重摘录卡。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoAttachScreenshot !== false)
        .onChange(async (v) => { this.plugin.settings.autoAttachScreenshot = v; await this.plugin.saveSettings(); }));

    if (this.plugin.settings.storageLayout === "central") {
      new Setting(containerEl).setName("MarginBook 工作区")
        .setDesc(`摘录、Canvas 与附件统一保存至 ${this.plugin.settings.storageRoot || "Lucia's Marginbook"}/课程路径/PDF名称/；PDF 原文保持原位。现有历史摘录保留独立关联，不自动合并。`);
    }

    if (this.plugin.settings.storageLayout !== "central") new Setting(containerEl)
      .setName("摘录截图保存目录")
      .setDesc("相对于 Vault 根目录；{pdf} 会替换为 PDF 文件名。默认：附件/{pdf}")
      .addText((t) => t
        .setPlaceholder("附件/{pdf}")
        .setValue(this.plugin.settings.excerptImageFolder || "附件/{pdf}")
        .onChange(async (v) => {
          this.plugin.settings.excerptImageFolder = String(v || "").trim().replace(/^\/+|\/+$/g, "") || "附件/{pdf}";
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName("图片摘录的 PDF 标记")
      .setDesc("仅控制纯图片摘录在原 PDF 上的定位方式；带自动附图的文字摘录始终使用荧光笔底色。")
      .addDropdown((d) => d
        .addOption("dashed", "虚线边框（默认）")
        .addOption("highlight", "半透明高亮")
        .setValue(this.plugin.settings.imageExcerptMarkStyle === "highlight" ? "highlight" : "dashed")
        .onChange(async (v) => {
          this.plugin.settings.imageExcerptMarkStyle = v === "highlight" ? "highlight" : "dashed";
          await this.plugin.saveSettings();
          this.plugin.lmbRefreshAllMarks();
        }));

    const cleanIntro = containerEl.createEl("p", {
      text: "删除画布上的摘录卡时，一并清理它留下的残留（截图附件 + md 摘录文档里的对应条目）。"
        + "⚠ 这是数据级操作，默认关闭 —— 请确认理解风险后再开启。"
    });
    cleanIntro.style.cssText = "font-size:12px;color:var(--text-muted);line-height:1.6;margin:0 0 4px;";

    new Setting(containerEl)
      .setName("删除卡片时级联清理")
      .setDesc("开启后：删除画布摘录卡 → 自动把截图附件移入回收目录 + 从 md 摘录文档移除该条目。"
        + "安全策略：① 只删插件自己命名的附件（xxx-P<页>-<戳>.webp），你的图片不碰；"
        + "② 全 vault 扫描，其他笔记还在引用就不删（避免 broken image）；"
        + "③ Markdown 原块与截图会先移入 .lmb-trash，可真正恢复；"
        + "④ 引用检查只要有一个文件读取失败，就保留截图；"
        + "⑤ 底部弹提示告知清理了几项。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.autoCleanOnDelete === true)
        .onChange(async (v) => {
          this.plugin.settings.autoCleanOnDelete = v;
          await this.plugin.saveSettings();
        }));

    /* ---- v0.8.0：卡片补充描述 ---- */
    containerEl.createEl("h2", { text: "卡片补充描述（v0.8.0）" });
    const noteIntro = containerEl.createEl("p", {
      text: "给摘录卡片补一段自己的想法，以 callout 形式显示在卡片下方（Obsidian 原生可折叠）。"
        + "内容内联存在卡片里，复制/导出卡片不会丢。"
    });
    noteIntro.style.cssText = "font-size:12px;color:var(--text-muted);line-height:1.6;margin:0 0 12px;";

    new Setting(containerEl)
      .setName("Callout 类型名")
      .setDesc("补充描述渲染成哪种 callout。改了类型名只影响之后新建的描述，已有的不受影响。")
      .addText((t) => t
        .setValue(this.plugin.settings.noteCalloutType || "ppd-note")
        .setPlaceholder("ppd-note")
        .onChange(async (v) => {
          this.plugin.settings.noteCalloutType = (v || "").trim() || "ppd-note";
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("Callout 标题")
      .setDesc("补充描述框顶部显示的标题。")
      .addText((t) => t
        .setValue(this.plugin.settings.noteTitle || "补充描述")
        .setPlaceholder("补充描述")
        .onChange(async (v) => {
          this.plugin.settings.noteTitle = v;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName("新建时默认折叠")
      .setDesc("开启后，新加的补充描述默认是折叠状态（只显示标题行），点开才展开。")
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.noteFoldByDefault)
        .onChange(async (v) => { this.plugin.settings.noteFoldByDefault = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("同步进摘录文档")
      .setDesc("关闭（默认）：补充描述只留在画布卡片上，<PDF名>-摘录.md 保持「原文镜像」不被污染。"
        + "开启：补充描述也会写进摘录文档。")
      .addToggle((t) => t
        .setValue(!!this.plugin.settings.noteIntoSync)
        .onChange(async (v) => { this.plugin.settings.noteIntoSync = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("新摘录卡自动挂空描述框")
      .setDesc("关闭（v0.12.0 起默认）：新拖出的摘录卡不再自动带空描述框（v0.12.0 卡片精简迁移）。"
        + "开启：新拖出的摘录卡下方自动带一个空的补充描述框，点开即可写。"
        + "插件首次扫描某画布时会给已有摘录卡也补上（不覆盖已写过的内容）。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.noteAutoBoxOnNew !== false)
        .onChange(async (v) => { this.plugin.settings.noteAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("新摘录卡自动挂评论栏")
      .setDesc("关闭（v0.16.0 起默认）：新拖出的摘录卡**不再**自动带「💬 添加评论」底栏，卡里只留摘录内容。"
        + "评论功能照常可用 —— 入口是选中卡片后左侧悬浮栏的「评论」按钮、命令面板"
        + "（给卡片添加/编辑评论）、以及侧边栏 ribbon。"
        + "开启：恢复旧行为，新卡底部自动带评论栏，点它直接弹编辑框（仿 PDF Flow 批注样式）。"
        + "存量卡与已写过的评论不受此开关影响。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.commentAutoBoxOnNew === true)
        .onChange(async (v) => { this.plugin.settings.commentAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
  }
}
