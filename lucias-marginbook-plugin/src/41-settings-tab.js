/* 41-settings-tab —— 设置页 */

/* ==================== 设置页 ==================== */

class LMBSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    new Setting(containerEl)
      .setName("调试提示（Notice）")
      .setDesc("在屏幕上显示每一步检测结果，用于定位问题。稳定后可关闭。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.debug)
        .onChange(async (v) => { this.plugin.settings.debug = v; await this.plugin.saveSettings(); }));
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
      .setDesc("开启（默认）：新拖出的摘录卡下方自动带一个空的补充描述框，点开即可写。"
        + "插件首次扫描某画布时会给已有摘录卡也补上（不覆盖已写过的内容）。"
        + "嫌占位或不想改造存量卡就关掉。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.noteAutoBoxOnNew !== false)
        .onChange(async (v) => { this.plugin.settings.noteAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
    new Setting(containerEl)
      .setName("新摘录卡自动挂评论栏")
      .setDesc("开启（默认）：新拖出的摘录卡底部自动带一条「添加评论」栏（仿 PDF Flow 批注样式），"
        + "点评论栏直接弹编辑框；插件首次扫描某画布时也会给存量卡补上（不覆盖已写内容）。"
        + "与「补充描述」是两套独立数据，嫌重复可只留其一。")
      .addToggle((t) => t
        .setValue(this.plugin.settings.commentAutoBoxOnNew !== false)
        .onChange(async (v) => { this.plugin.settings.commentAutoBoxOnNew = v; await this.plugin.saveSettings(); }));
  }
}
