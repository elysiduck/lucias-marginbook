/* 40-modals —— 评论/补充描述输入弹窗 + 卡片模糊选择器 */

/* ==================== v0.8.0：补充描述输入弹窗 ==================== */

/**
 * 补充描述输入弹窗。多行文本域，Enter 换行、Ctrl/Cmd+Enter 提交。
 * 说明文字里点明「存储方式」，让用户知道这段内容会以 callout 形式内联进卡片。
 */
class LMBNoteModal extends Modal {
  constructor(app, opts) {
    super(app);
    this.opts = opts || {};
    this.value = this.opts.value || "";
    this.onSubmit = this.opts.onSubmit || (() => {});
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.opts.title || "卡片补充描述" });
    const tip = contentEl.createEl("p", {
      text: "补充描述会以 callout 形式显示在卡片下方（Obsidian 原生可折叠）。内容内联存进卡片本身，复制/导出卡片不会丢。"
    });
    tip.style.cssText = "font-size:12px;color:var(--text-muted);margin:0 0 10px;line-height:1.6;";

    const ta = contentEl.createEl("textarea");
    ta.style.cssText = "width:100%;min-height:160px;resize:vertical;font-size:14px;line-height:1.6;" +
      "background:var(--background-primary);color:var(--text-normal);" +
      "border:1px solid var(--background-modifier-border);border-radius:6px;padding:8px;";
    ta.value = this.value;
    ta.placeholder = "写下你对这段摘录的想法、疑问、联想…";
    this.ta = ta;

    const hint = contentEl.createEl("div", { text: "Ctrl/Cmd + Enter 保存 · Esc 取消 · 清空内容并保存 = 移除补充描述" });
    hint.style.cssText = "font-size:11px;color:var(--text-faint);margin-top:6px;";

    const bar = contentEl.createEl("div");
    bar.style.cssText = "display:flex;justify-content:flex-end;gap:8px;margin-top:12px;";
    const cancel = bar.createEl("button", { text: "取消" });
    const ok = bar.createEl("button", { text: "保存" });
    ok.style.cssText = "background:var(--interactive-accent);color:var(--text-on-accent);border:none;border-radius:6px;padding:6px 14px;cursor:pointer;";
    cancel.onclick = () => this.close();
    ok.onclick = () => this.submit();
    ta.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); this.submit(); }
    });
    setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 30);
  }
  submit() {
    const v = this.ta ? this.ta.value : "";
    this.close();
    this.onSubmit(v);
  }
  onClose() { this.contentEl.empty(); }
}
/**
 * v0.8.0：卡片选择器（内部 API 不可用时的兜底，纯公开 API）。
 * 列出当前画布所有文本卡片，已带补充描述的加 📝 前缀。
 */
class LMBNodeSuggester extends FuzzySuggestModal {
  constructor(app, items, onChoose, onCancel) {
    super(app);
    this.items = items;
    this.onChoose = onChoose;
    this.onCancel = onCancel;
    this.done = false;
  }
  getItems() { return this.items; }
  getItemText(it) { return it.label; }
  onChooseItem(it) { this.done = true; this.onChoose(it); }
  onClose() { if (!this.done && this.onCancel) this.onCancel(); }
}
