// Run with Playwright available in NODE_PATH. Uses installed Edge; no downloads.
// Real CSS cascade/geometry regression; PDF.js and physical iPad are not simulated.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { LMB_STYLES } = require('../src/shared/foundation.js').__lmbStyles;

(async () => {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const results = [];
  try {
    const page = await browser.newPage({ hasTouch: true });
    await page.setContent(`<style>body{margin:0}.view-content{width:100vw;height:100vh}.pdf-viewer-container{width:100%;height:100%}</style>
      <div class="view-content lmb-pdf-sidebar-host" style="--lmb-pdf-sidebar-width:340px">
      <div class="pdf-viewer-container"></div><div class="lmb-pdf-excerpt-sidebar" style="width:340px"></div></div>`);
    await page.addStyleTag({ content: LMB_STYLES.join('') });
    for (const mobile of [false, true]) for (const width of [600, 700, 701, 834, 1024, 1194]) {
      await page.setViewportSize({ width, height: 900 });
      // Repeat close/open and side switches, including switching side while closed.
      for (const [side, open] of [['right', true], ['right', false], ['left', false], ['left', true], ['left', false], ['right', false], ['right', true]]) {
        const actual = await page.evaluate(({ mobile, side, open }) => {
          document.body.classList.toggle('lmb-mobile', mobile);
          const host = document.querySelector('.lmb-pdf-sidebar-host');
          host.classList.toggle('lmb-sidebar-left', side === 'left');
          host.classList.toggle('lmb-pdf-sidebar-closed', !open);
          const css = getComputedStyle(host);
          return { left: parseFloat(css.paddingLeft), right: parseFloat(css.paddingRight),
            viewer: host.querySelector('.pdf-viewer-container').getBoundingClientRect().width,
            bar: getComputedStyle(host.querySelector('.lmb-pdf-excerpt-sidebar')).display };
        }, { mobile, side, open });
        const gutter = mobile && width <= 700 ? Math.min(width * .46, 320) : 340;
        const left = open && side === 'left' ? gutter : 0;
        const right = open && side === 'right' ? gutter : 0;
        const label = `${mobile ? 'mobile' : 'desktop'}/${width}/${side}/${open ? 'open' : 'closed'}`;
        assert(Math.abs(actual.left - left) < 1 && Math.abs(actual.right - right) < 1, `${label}: ${JSON.stringify(actual)}`);
        assert(Math.abs(actual.viewer - (width - left - right)) < 1, `${label}: PDF must regain all released space`);
        assert.equal(actual.bar === 'none', !open, `${label}: sidebar visibility`);
        results.push({ label, ...actual });
      }
    }
    const report = { checks: results.length, engine: 'headless Edge', nativeIPad: false, results };
    fs.writeFileSync(path.join(__dirname, 'evidence/sidebar-layout-0.45.2.json'), JSON.stringify(report, null, 2) + '\n');
    console.log(`PASS ${results.length} sidebar layout cases`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
