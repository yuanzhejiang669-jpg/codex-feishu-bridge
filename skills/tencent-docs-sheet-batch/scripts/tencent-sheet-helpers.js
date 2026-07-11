// Tencent Docs Sheet helpers for Browser Control page-context evaluation.
// Inject this file into a logged-in docs.qq.com sheet tab. Loading it does not modify the sheet.
(function () {
  function getApp() {
    if (!window.SpreadsheetApp) {
      throw new Error('window.SpreadsheetApp is unavailable');
    }
    return window.SpreadsheetApp;
  }

  function getWebpackRequire() {
    if (window.__codexWebpackRequire) return window.__codexWebpackRequire;
    if (!window.webpackChunk_tencent_sheet || !window.webpackChunk_tencent_sheet.push) {
      throw new Error('webpackChunk_tencent_sheet is unavailable');
    }
    window.webpackChunk_tencent_sheet.push([
      [Math.floor(Math.random() * 1e9)],
      {},
      function (req) {
        window.__codexWebpackRequire = req;
      }
    ]);
    return window.__codexWebpackRequire;
  }

  function getSheet(sheetId) {
    const app = getApp();
    const sheet = app.workbook.worksheetManager.getSheetBySheetId(sheetId);
    if (!sheet) throw new Error('Sheet not found: ' + sheetId);
    return sheet;
  }

  function getCellText(sheetId, rowIndex, colIndex) {
    const app = getApp();
    const sheet = getSheet(sheetId);
    const cell = sheet.getCellDataAtPosition(rowIndex, colIndex);
    return app.e2eTools.getCellEditValue(app.workbook, rowIndex, colIndex, sheetId, cell);
  }

  function readRange(opts) {
    const rows = [];
    for (let r = opts.startRowIndex; r <= opts.endRowIndex; r++) {
      const values = [];
      for (let c = opts.startColIndex; c <= opts.endColIndex; c++) {
        values.push(getCellText(opts.sheetId, r, c));
      }
      rows.push({ rowIndex: r, rowNumber: r + 1, values });
    }
    return rows;
  }

  function findRowsByName(opts) {
    const hits = [];
    const names = new Set(opts.names);
    for (let r = opts.startRowIndex || 0; r <= opts.endRowIndex; r++) {
      const value = getCellText(opts.sheetId, r, opts.nameColIndex);
      if (names.has(value)) {
        hits.push({ rowIndex: r, rowNumber: r + 1, colIndex: opts.nameColIndex, name: value });
      }
    }
    return hits;
  }

  function assertNamesAndBlank(opts) {
    const errors = [];
    for (let i = 0; i < opts.expectedNames.length; i++) {
      const rowIndex = opts.startRowIndex + i;
      const actualName = getCellText(opts.sheetId, rowIndex, opts.nameColIndex);
      if (actualName !== opts.expectedNames[i]) {
        errors.push({
          rowNumber: rowIndex + 1,
          issue: 'name mismatch',
          expected: opts.expectedNames[i],
          actual: actualName
        });
      }
      for (const colIndex of opts.blankColIndexes || []) {
        const value = getCellText(opts.sheetId, rowIndex, colIndex);
        if (value !== '') {
          errors.push({ rowNumber: rowIndex + 1, colIndex, issue: 'target cell not blank', value });
        }
      }
    }
    if (errors.length) {
      const err = new Error('Tencent Docs guard check failed');
      err.details = errors;
      throw err;
    }
    return { ok: true, checkedRows: opts.expectedNames.length };
  }

  async function setRangeValues(opts) {
    const app = getApp();
    const rangeValues = [];
    for (let r = 0; r < opts.values.length; r++) {
      for (let c = 0; c < opts.values[r].length; c++) {
        rangeValues.push({
          rowIndex: opts.startRowIndex + r,
          colIndex: opts.startColIndex + c,
          userEnterValue: String(opts.values[r][c])
        });
      }
    }
    const result = await app.behaviorApi.cellApi.setRangeValue({
      sheetId: opts.sheetId,
      rangeValues
    });
    return { ok: true, wroteCells: rangeValues.length, resultType: typeof result };
  }

  async function centerRange(opts) {
    const app = getApp();
    const req = getWebpackRequire();
    const StyleKey = req(283532).A;
    const HAlign = req(357572).J;
    const VAlign = req(432665).j;
    const range = new app.e2eTools.GridRange(
      opts.sheetId,
      opts.startRowIndex,
      opts.endRowIndex,
      opts.startColIndex,
      opts.endColIndex
    );
    const result = await app.behaviorApi.cellApi.setFormat({
      gridRanges: [range],
      formatItem: {
        [String(StyleKey.HORIZONTAL_ALIGN)]: HAlign.Center,
        [String(StyleKey.VERTICAL_ALIGN)]: VAlign.SmlCenter
      }
    });
    return { ok: true, resultType: typeof result };
  }

  async function fillRangesRed(opts) {
    const app = getApp();
    const req = getWebpackRequire();
    const StyleKey = req(283532).A;
    const PatternType = req(238915).g;
    const CTPatternFill = req(851652).CTPatternFill;
    const Color = req(443058).Color;
    const gridRanges = opts.ranges.map(function (range) {
      return new app.e2eTools.GridRange(
        opts.sheetId,
        range.startRowIndex,
        range.endRowIndex,
        range.startColIndex,
        range.endColIndex
      );
    });
    const result = await app.behaviorApi.cellApi.setFormat({
      gridRanges,
      formatItem: {
        [String(StyleKey.FILL_GRADIENT)]: void 0,
        [String(StyleKey.FILL_PATTERN)]: CTPatternFill.factory.createInstance({
          patternType: PatternType.Solid,
          fgColor: Color.factory.createInstance({ rgb: opts.rgb || '#ff0000' })
        })
      }
    });
    return { ok: true, resultType: typeof result };
  }

  function readFillRgb(sheetId, rowIndex, colIndex) {
    const sheet = getSheet(sheetId);
    const cell = sheet.getCellDataAtPosition(rowIndex, colIndex);
    return cell && cell.getStyle && cell.getStyle().getFill &&
      cell.getStyle().getFill() &&
      cell.getStyle().getFill().patternFill &&
      cell.getStyle().getFill().patternFill.fgColor &&
      cell.getStyle().getFill().patternFill.fgColor.rgb || null;
  }

  function verifyFillRgb(opts) {
    const cells = [];
    for (const range of opts.ranges) {
      for (let r = range.startRowIndex; r <= range.endRowIndex; r++) {
        for (let c = range.startColIndex; c <= range.endColIndex; c++) {
          const fillRgb = readFillRgb(opts.sheetId, r, c);
          cells.push({ rowIndex: r, rowNumber: r + 1, colIndex: c, fillRgb });
        }
      }
    }
    return { cells, allMatch: cells.every(cell => cell.fillRgb === opts.expectedFillRgb) };
  }

  window.__codexTencentSheetBatch = {
    getCellText,
    readRange,
    findRowsByName,
    assertNamesAndBlank,
    setRangeValues,
    centerRange,
    fillRangesRed,
    verifyFillRgb
  };
})();
