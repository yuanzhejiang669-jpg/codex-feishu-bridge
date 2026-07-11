---
name: tencent-docs-sheet-batch
description: Precise Tencent Docs spreadsheet automation through a logged-in browser session. Use for guarded range writes, formatting, row lookup, and read-back verification without touching unrelated collaborator cells.
---

# Tencent Docs Sheet Batch

## Core Rule

Treat Tencent Docs as a live collaborative document. Do not guess ranges, rely on visual selection alone, or write until the target rows, columns, sheet id, and existing cell state have been read back from the page.

Use the logged-in browser tab through Browser Control. If the target tab is not connected, list or repair Browser Control tabs before proceeding. Do not use guest browser state for authenticated editing.

Tencent Docs Sheet is canvas-rendered, so ordinary DOM queries may not expose reliable cell text. Clipboard and synthetic paste paths can appear successful while leaving cells unchanged. Prefer the page's `window.SpreadsheetApp` APIs when available, inspect methods rather than assuming minified internals, and verify all results by reading cells back.

## Standard Workflow

1. Identify the authenticated Tencent Docs sheet tab.
2. Probe `window.SpreadsheetApp`, the current selection, and the sheet location without changing data.
3. Resolve the actual `sheetId`; never reuse one from a previous document.
4. Read target rows and cells with `SpreadsheetApp.e2eTools.getCellEditValue`.
5. Confirm row identities, exact target range, blank-only requirements, and collaborator-owned values.
6. Write values with `behaviorApi.cellApi.setRangeValue`.
7. Apply formatting with `behaviorApi.cellApi.setFormat` when requested.
8. Read back every changed value and the relevant style properties.
9. Report exact cloud ranges changed and every local file produced.

Use this read-only probe first:

```js
(() => {
  const app = window.SpreadsheetApp;
  return JSON.stringify({
    href: location.href,
    title: document.title,
    hasApp: !!app,
    selection: app?.view?.getSelection?.(),
    selectionRanges: app?.view?.getSelectionRanges?.(),
    sheetLocation: app?.view?.getSheetLocation?.()
  }, null, 2);
})()
```

## Helper Template

Inject `scripts/tencent-sheet-helpers.js` into the connected page, then call its helper methods in separate Browser Control evaluations. Loading it is read-only. Every write requires an explicit call with the current document's confirmed `sheetId` and zero-based, inclusive row and column indexes.

Example shape:

```js
await window.__codexTencentSheetBatch.setRangeValues({
  sheetId: confirmedSheetId,
  startRowIndex: targetStartRow,
  startColIndex: targetStartColumn,
  values: rowsToWrite
});
```

Before calling it, use `assertNamesAndBlank` or equivalent read-back guards. Afterward, use `readRange` and style checks to prove the intended cells changed.

## Formatting

For alignment and fill, load the current page's webpack enums and use `cellApi.setFormat`. Module identifiers are implementation details and can change, so stop if the expected modules or APIs are unavailable. Determine the real used column range before formatting a whole row, and clarify whether a request applies to one cell or the full data row.

## Stop Conditions

Stop and ask before writing when:

- the sheet id cannot be confirmed;
- row identities do not match the source data;
- protected target cells are not blank;
- the requested formatting scope is ambiguous;
- Browser Control cannot access the logged-in tab;
- `SpreadsheetApp` or required page APIs are missing or changed.

## Reporting

Report cloud edits separately from local files. Include exact ranges changed, the read-back verification method and result, and every local file created, modified, downloaded, generated, left behind, or cleaned up.
