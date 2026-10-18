/*
 * Lucia's MarginBook v0.16.14
 * Independent PDF excerpt workflow for Obsidian.
 *
 * This file starts the generated CommonJS bundle. Release history lives in
 * CHANGELOG.md and docs/historical-bootstrap.md.
 */
"use strict";

const {
  Plugin, Notice, Menu, TFile, PluginSettingTab, Setting, normalizePath, Modal,
  FuzzySuggestModal, MarkdownRenderer, setIcon, Platform
} = require("obsidian");

// Platform is part of Obsidian's public API and is available on desktop and mobile.
// Keep the fallback for older test stubs that do not expose it.
const LMB_IS_MOBILE = !!(Platform && (Platform.isMobileApp || Platform.isMobile));

// Stable excerpt identifier embedded in Markdown blocks.
const EX_ID_RE = /\^ex-[0-9a-z]{4,16}/;
