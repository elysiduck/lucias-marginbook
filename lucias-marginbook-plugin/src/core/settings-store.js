/* core/settings-store — defaults, migrations, and persistence shape */

const LMB_WORD_DEFAULT_PROMPT = `你是一位擅长联想记忆的英语词汇老师。请根据选中的单词或短语及原句语境，生成翻译、例句和助记。

翻译：给出词性和简洁、准确的中文释义。有原句时优先解释本句含义。
例句：给出一个自然、简短、便于理解的英文例句，并附中文翻译。
助记：从谐音、近形词、真实词根词缀、拆分联想、熟悉事物和场景联想中，选择最自然有效的 1～2 种。

助记要求：
1. 先展示联想依据，再用一句话串起具体、有画面的场景，最后落到目标词义。
2. 优先选择容易理解、容易复述的联想，避免牵强拆分和冗长故事。不必凑齐所有方法。
3. 自创拆分标注“拼写联想”，谐音标注“近似谐音”；不得冒充真实词根、词源或标准发音。
4. 没有自然的拆分或谐音时，给出简洁的语义或场景联想，不编造构词关系。
5. 涉及其他英文词时，附上与联想有关的中文意思。目标词义、关联词义和例句须准确。
6. 助记约 80～150 个汉字，简单词可以更短。可分行展示联想依据和记忆句。

以下示例仅示范风格，不要机械套用：

【拼写联想】incentive【激励；奖励；诱因】
in【进来】＋ cent【一分钱】。想象完成任务后，硬币一枚枚“进”口袋：有钱进账，就有行动的动力。
注意：这是自创拼写联想，不是真实词根拆解。

【近形词对照】contend【争论；竞争】与 content【满足的】
末尾 d 联想 defend【捍卫】：争论时捍卫自己的观点。末尾 t 联想 tea【茶】：心满意足地坐着喝茶。
一句记忆：contend 忙着争，content 满足地喝茶。这是字母联想，不是词源解释。

【真实词缀】dehumidify【除湿】
de-【去除】＋ humid【潮湿的】＋ -ify【使……】。空气太潮湿，就把湿气去掉：dehumidify，除湿。
关联词：dehumidifier【除湿机】。

【近似谐音】wry【挖苦的；带嘲讽意味的】
发音 /raɪ/ 可近似联想“歪”。想象一个人歪着嘴角，露出带点嘲讽的笑：a wry smile。
“歪”只是近似谐音，发音以音标为准。

【熟词与场景】uniformity【一致性；统一性】
uniform【制服；一致的】＋ -ity【名词后缀】。全班穿上相同的制服 uniform，队伍看起来整齐一致：uniformity。
一句记忆：制服都一样，整体有一致性。

【近形词与画面】coddle【溺爱；过分呵护】
联想近形词 cobble【鹅卵石】。把一块鹅卵石都当宝宝，裹上小被子、捧在手心怕它受凉——这也太溺爱了！
这是近形词场景联想，两词并非因此具有词源关系。

【语义对比】bolster【支持；加强】与 boost【提升；促进】
boost 像从后面推一把，让它升高；bolster 像在下面加一个支撑，让它更稳。
画面：给摇晃的桌腿加支撑，就像用证据 bolster an argument【加强论证】。`;

function lmbWordPrompt(value) {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 16000) : LMB_WORD_DEFAULT_PROMPT;
}

const LMB_DEFAULT_SETTINGS = Object.freeze({
  debug: false,
  wordAiUrl: "",
  wordAiKey: "",
  wordAiModel: "",
  wordAiContext: true,
  wordAiPrompt: LMB_WORD_DEFAULT_PROMPT,
  colorMap: "",
  noteCalloutType: "ppd-note",
  noteTitle: "补充描述",
  noteFoldByDefault: false,
  noteIntoSync: false,
  noteAutoBoxOnNew: false,
  commentAutoBoxOnNew: false,
  excerptCardWidth: 560,
  autoAttachScreenshot: true,
  excerptImageFolder: "附件/{pdf}",
  storageLayout: "central",
  storageRoot: "Lucia's Marginbook",
  pdfSourceRoot: "Books/pdf书籍",
  storageBindings: {},
  imageExcerptMarkStyle: "dashed",
  autoCleanOnDelete: true,
  moveDescendantsWithParent: false,
  nodeViews: {},
  excerptViews: {},
  quickExcerpts: {},
  pdfTextBlocks: {},
  excerptColors: {},
  notePlaceholderOffMigrated: false,
  commentBoxOffMigrated: false,
  naturalHeightV2Migrated: false,
  overflowHeightVerifiedMigrated: false,
  managedExcerptAssetsV1Migrated: false,
  inkSidecarV2Migrated: false,
  inkInputMode: "pen-mouse",
  inkPressureMode: "natural",
  inkStabilization: 2,
  inkLastTool: "pen",
  inkPenColor: "#e05252",
  inkPenWidth: 3,
  inkHighlighterColor: "#ffd84d",
  inkHighlighterWidth: 12,
  inkEraserSize: 18,
  inkEraserMode: "partial",
  inkEraserAutoReturn: true,
  inkToolbarCollapsed: false,
  pdfSidebarSide: "right",
  inkAnnotations: {},
  inkExcerptLinks: {},
  inkLinkCounters: {}
});

class LmbSettingsStore {
  constructor(plugin) {
    this.plugin = plugin;
  }

  async load() {
    const saved = await this.plugin.loadData();
    const settings = Object.assign({}, LMB_DEFAULT_SETTINGS, saved);
    // Existing vaults retain their paths until an explicit, backed-up migration.
    if (saved && Object.keys(saved).length && !saved.storageLayout) settings.storageLayout = "legacy";
    let migrated = false;
    if (!settings.notePlaceholderOffMigrated) {
      settings.noteAutoBoxOnNew = false;
      settings.notePlaceholderOffMigrated = true;
      migrated = true;
    }
    if (!settings.commentBoxOffMigrated) {
      settings.commentAutoBoxOnNew = false;
      settings.commentBoxOffMigrated = true;
      migrated = true;
    }
    if (!settings.managedExcerptAssetsV1Migrated) {
      settings.excerptImageFolder = settings.excerptImageFolder || "附件/{pdf}";
      settings.autoCleanOnDelete = true;
      settings.managedExcerptAssetsV1Migrated = true;
      migrated = true;
    }
    return { settings, migrated };
  }

  serialize(settings, state) {
    const obj = {
      debug: !!settings.debug,
      wordAiUrl: String(settings.wordAiUrl || ""),
      wordAiKey: String(settings.wordAiKey || ""),
      wordAiModel: String(settings.wordAiModel || ""),
      wordAiContext: settings.wordAiContext !== false,
      wordAiPrompt: lmbWordPrompt(settings.wordAiPrompt),
      recallDefault: !!settings.recallDefault,
      colorMap: settings.colorMap,
      noteCalloutType: settings.noteCalloutType,
      noteTitle: settings.noteTitle,
      noteFoldByDefault: !!settings.noteFoldByDefault,
      noteIntoSync: !!settings.noteIntoSync,
      noteAutoBoxOnNew: settings.noteAutoBoxOnNew !== false,
      commentAutoBoxOnNew: settings.commentAutoBoxOnNew === true,
      excerptCardWidth: Math.max(320, Math.min(800, Number(settings.excerptCardWidth) || 560)),
      autoAttachScreenshot: settings.autoAttachScreenshot !== false,
      excerptImageFolder: String(settings.excerptImageFolder || "附件/{pdf}"),
      storageLayout: settings.storageLayout === "central" ? "central" : "legacy",
      storageRoot: String(settings.storageRoot || "Lucia's Marginbook"),
      pdfSourceRoot: String(settings.pdfSourceRoot || "Books/pdf书籍"),
      storageBindings: settings.storageBindings || {},
      imageExcerptMarkStyle: settings.imageExcerptMarkStyle === "highlight" ? "highlight" : "dashed",
      autoCleanOnDelete: settings.autoCleanOnDelete === true,
      moveDescendantsWithParent: settings.moveDescendantsWithParent === true,
      nodeViews: settings.nodeViews && typeof settings.nodeViews === "object" ? settings.nodeViews : {},
      excerptViews: settings.excerptViews && typeof settings.excerptViews === "object" ? settings.excerptViews : {},
      quickExcerpts: settings.quickExcerpts && typeof settings.quickExcerpts === "object" ? settings.quickExcerpts : {},
      pdfSidebarSide: settings.pdfSidebarSide === "left" ? "left" : "right",
      inkExcerptLinks: settings.inkExcerptLinks && typeof settings.inkExcerptLinks === "object" ? settings.inkExcerptLinks : {},
      inkLinkCounters: settings.inkLinkCounters && typeof settings.inkLinkCounters === "object" ? settings.inkLinkCounters : {},
      pdfTextBlocks: settings.pdfTextBlocks && typeof settings.pdfTextBlocks === "object" ? settings.pdfTextBlocks : {},
      excerptColors: settings.excerptColors && typeof settings.excerptColors === "object" ? settings.excerptColors : {},
      notePlaceholderOffMigrated: !!settings.notePlaceholderOffMigrated,
      commentBoxOffMigrated: !!settings.commentBoxOffMigrated,
      naturalHeightV2Migrated: !!settings.naturalHeightV2Migrated,
      overflowHeightVerifiedMigrated: !!settings.overflowHeightVerifiedMigrated,
      managedExcerptAssetsV1Migrated: !!settings.managedExcerptAssetsV1Migrated,
      inkSidecarV2Migrated: !!settings.inkSidecarV2Migrated,
      inkInputMode: settings.inkInputMode === "pen-only" ? "pen-only" : "pen-mouse",
      inkPressureMode: ["fixed", "natural", "fountain"].includes(settings.inkPressureMode) ? settings.inkPressureMode : "natural",
      inkStabilization: settings.inkStabilization != null && [0, 1, 2, 3].includes(Number(settings.inkStabilization)) ? Number(settings.inkStabilization) : 2,
      inkLastTool: typeof settings.inkLastTool === "string" ? settings.inkLastTool : "pen",
      inkPenColor: String(settings.inkPenColor || "#e05252"),
      inkPenWidth: Math.max(1, Math.min(14, Number(settings.inkPenWidth) || 3)),
      inkHighlighterColor: String(settings.inkHighlighterColor || "#ffd84d"),
      inkHighlighterWidth: Math.max(4, Math.min(30, Number(settings.inkHighlighterWidth) || 12)),
      inkEraserSize: Math.max(8, Math.min(48, Number(settings.inkEraserSize) || 18)),
      inkEraserMode: settings.inkEraserMode === "stroke" ? "stroke" : "partial",
      inkEraserAutoReturn: settings.inkEraserAutoReturn !== false,
      inkToolbarCollapsed: !!settings.inkToolbarCollapsed,
      inkAnnotations: this.plugin._lmbInkSidecarReady ? {} :
        (this.plugin._lmbInkDocs && typeof this.plugin._lmbInkDocs === "object" ? this.plugin._lmbInkDocs :
          (settings.inkAnnotations && typeof settings.inkAnnotations === "object" ? settings.inkAnnotations : {}))
    };
    let runtime = this.plugin._lmbSerializedRuntimeCaches;
    if (!runtime || this.plugin._lmbRuntimeStateDirty) {
      runtime = {};
      if (state.autoSize.size) {
        runtime.autoSizes = Object.fromEntries(Array.from(state.autoSize, ([path, store]) => [path, Array.from(store)]));
      }
      if (state.imgDims.size) runtime.imgDims = Object.fromEntries(state.imgDims);
      const positions = this._nonEmptyEntries(state.canvasPositions);
      if (positions) runtime.canvasPositions = positions;
      const edges = this._nonEmptyEntries(state.autoEdges);
      if (edges) runtime.autoEdges = edges;
      this.plugin._lmbSerializedRuntimeCaches = runtime;
      this.plugin._lmbRuntimeStateDirty = false;
    }
    Object.assign(obj, runtime);
    return obj;
  }

  _nonEmptyEntries(source) {
    const result = {};
    for (const [path, values] of source || []) {
      if (values.size) result[path] = Array.from(values);
    }
    return Object.keys(result).length ? result : null;
  }
}
