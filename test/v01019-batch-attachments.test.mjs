import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { isTransientLarkError } from "../src/feishu/lark-cli.mjs";
import { createAttachmentManager } from "../src/feishu/attachments.mjs";
import { createPendingAttachmentStore } from "../src/attachments/pending.mjs";
import { partitionVisionAttachments } from "../src/attachments/vision-guard.mjs";
import { antigravityContent } from "../src/antigravity/acp-client.mjs";
import { claudeContent } from "../src/claude/bridge-runner.mjs";
import { createAppServerProtocol } from "../src/codex/app-server-protocol.mjs";

function makeTmpDir(prefix = "v01019-att-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("v0.10.19: isTransientLarkError matches EOF / i/o timeout / connection reset / broken pipe while rejecting 4xx", () => {
  assert.equal(isTransientLarkError({ stderr: 'Post "https://accounts.feishu.cn/oauth/v3/token": EOF', stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "unexpected EOF while downloading body", stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "read tcp 127.0.0.1: i/o timeout", stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "read: connection reset by peer", stdout: "" }), true);
  assert.equal(isTransientLarkError({ stderr: "write: broken pipe", stdout: "" }), true);

  assert.equal(isTransientLarkError({ stderr: "HTTP 400 bad request EOF", stdout: "" }), false);
  assert.equal(isTransientLarkError({ stderr: "HTTP 403 forbidden", stdout: "" }), false);
  assert.equal(isTransientLarkError({ stderr: "HTTP 404 not found", stdout: "" }), false);
});

test("v0.10.19: downloadAllAttachments uses bounded 6-concurrency, 3 attempts, and preserves order", async () => {
  const dir = makeTmpDir();
  try {
    let active = 0;
    let peak = 0;
    const seenAttempts = [];

    const mgr = createAttachmentManager({
      CONFIG: {
        workspace: dir,
        attachmentRelDir: ".codex-feishu-attachments",
        maxFileAttachmentBytes: 50 * 1024 * 1024,
        attachmentDownloadConcurrency: 6,
        engine: "antigravity",
      },
      log: () => {},
      safeFilePart: (v) => String(v || "").replace(/[^A-Za-z0-9._-]+/g, "_"),
      runLark: async (args, opts) => {
        seenAttempts.push(opts.attempts);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 25));
        const outIdx = args.indexOf("--output");
        const rel = args[outIdx + 1];
        const abs = path.join(dir, rel);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, "payload");
        active -= 1;
        return { code: 0, stdout: JSON.stringify({ data: { saved_path: abs, size_bytes: 7 } }), stderr: "" };
      },
    });

    const content = [
      ...Array.from({ length: 5 }, (_, i) => `[Image: img_k${i + 1}]`),
      ...Array.from({ length: 5 }, (_, i) => `<file key="file_k${i + 1}" name="doc${i + 1}.pdf"/>`),
    ].join("\n");
    const event = { message_id: "om_conc_1", content };

    const downloaded = await mgr.downloadAllAttachments(event);
    assert.equal(downloaded.length, 10);
    assert.equal(peak, 6, `expected peak concurrency 6, got ${peak}`);
    assert.ok(seenAttempts.every((a) => a === 3), "expected attempts: 3 on all downloads");
    assert.deepEqual(
      downloaded.slice(0, 5).map((a) => a.fileKey),
      ["img_k1", "img_k2", "img_k3", "img_k4", "img_k5"],
    );
    assert.deepEqual(
      downloaded.slice(5).map((a) => a.fileName),
      ["doc1.pdf", "doc2.pdf", "doc3.pdf", "doc4.pdf", "doc5.pdf"],
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.10.19: batch file .jpg/.png promotes to vision image while .pdf/.svg stays file, and /steer counts by sourceKind", async () => {
  const dir = makeTmpDir();
  try {
    const mgr = createAttachmentManager({
      CONFIG: {
        workspace: dir,
        attachmentRelDir: ".codex-feishu-attachments",
        maxFileAttachmentBytes: 50 * 1024 * 1024,
        attachmentDownloadConcurrency: 6,
        engine: "antigravity",
      },
      log: () => {},
      safeFilePart: (v) => String(v || "").replace(/[^A-Za-z0-9._-]+/g, "_"),
      runLark: async (args) => {
        const outIdx = args.indexOf("--output");
        const abs = path.join(dir, args[outIdx + 1]);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, Buffer.alloc(128, 1));
        return { code: 0, stdout: JSON.stringify({ data: { saved_path: abs, size_bytes: 128 } }), stderr: "" };
      },
    });

    const content = [
      '<file key="file_jpg" name="Screenshot_01.JPG"/>',
      '<file key="file_png" name="diagram.png"/>',
      '<file key="file_svg" name="vector.svg"/>',
      '<file key="file_pdf" name="paper.pdf"/>',
    ].join("\n");
    const event = { message_id: "om_promo_1", content };
    const items = await mgr.downloadAllAttachments(event);

    assert.equal(items.length, 4);
    assert.equal(items[0].type, "image");
    assert.equal(items[0].sourceKind, "file");
    assert.equal(items[0].promotedFromFile, true);
    assert.equal(items[1].type, "image");
    assert.equal(items[1].sourceKind, "file");
    assert.equal(items[2].type, "file");
    assert.equal(items[3].type, "file");

    const steerEvent = { message_id: "om_steer_1", content: `/steer 看一下\n${content}` };
    await mgr.prepareCommandAttachments(steerEvent, { name: "/steer", rest: "看一下" });
    assert.equal(steerEvent.attachmentDownload.failed.file, 0);
    assert.equal(steerEvent.attachmentDownload.failed.image, 0);
    assert.equal(steerEvent.attachmentDownload.downloaded.file, 4);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.10.19: distinguishes too_large vs network failure in notices and prompt notes", async () => {
  const dir = makeTmpDir();
  try {
    const mgr = createAttachmentManager({
      CONFIG: {
        workspace: dir,
        attachmentRelDir: ".codex-feishu-attachments",
        maxFileAttachmentBytes: 1024,
        attachmentDownloadConcurrency: 6,
        engine: "codex",
      },
      log: () => {},
      safeFilePart: (v) => String(v || "").replace(/[^A-Za-z0-9._-]+/g, "_"),
      runLark: async (args) => {
        const key = args[args.indexOf("--file-key") + 1];
        const abs = path.join(dir, args[args.indexOf("--output") + 1]);
        if (key === "file_eof") {
          return { code: 1, stdout: "", stderr: 'Post "https://accounts.feishu.cn/oauth/v3/token": EOF' };
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        if (key === "file_huge") {
          fs.writeFileSync(abs, Buffer.alloc(2048, 2));
          return { code: 0, stdout: JSON.stringify({ data: { saved_path: abs, size_bytes: 2048 } }), stderr: "" };
        }
        fs.writeFileSync(abs, Buffer.alloc(100, 3));
        return { code: 0, stdout: JSON.stringify({ data: { saved_path: abs, size_bytes: 100 } }), stderr: "" };
      },
    });

    const event = {
      message_id: "om_fail_1",
      content: '帮我看一下\n<file key="file_ok" name="ok.pdf"/>\n<file key="file_huge" name="huge.zip"/>\n<file key="file_eof" name="net.pdf"/>',
    };
    const downloaded = await mgr.downloadAllAttachments(event);
    assert.equal(downloaded.length, 1);
    assert.equal(event.attachmentFailures.length, 2);

    const notice = mgr.formatAttachmentFailureNotice(event.attachmentFailures, { partial: true, withText: true });
    assert.match(notice, /huge\.zip/);
    assert.match(notice, /超过 1\.0 KB 限制/);
    assert.match(notice, /net\.pdf/);
    assert.match(notice, /网络波动下载失败/);

    event.attachments = downloaded;
    const prompt = mgr.buildPrompt(event, { history: [] });
    assert.match(prompt, /附件下载缺失提示/);
    assert.match(prompt, /huge\.zip/);
    assert.match(prompt, /net\.pdf/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.10.19: vision guardrail gracefully demotes >10 images, >totalBytes, or >singleBytes instead of throwing", () => {
  const dir = makeTmpDir();
  try {
    const files = [];
    for (let i = 1; i <= 12; i += 1) {
      const fp = path.join(dir, `img_${String(i).padStart(2, "0")}.png`);
      fs.writeFileSync(fp, Buffer.alloc(1024, i));
      files.push({ type: "image", fileName: path.basename(fp), path: fp, sizeBytes: 1024 });
    }
    const hugeFp = path.join(dir, "huge.jpg");
    fs.writeFileSync(hugeFp, Buffer.alloc(5000, 9));

    const partCount = partitionVisionAttachments(files, { maxImages: 10, maxSingleBytes: 10_000, maxTotalBytes: 100_000 });
    assert.equal(partCount.inlineImages.length, 10);
    assert.equal(partCount.demotedImages.length, 2);
    assert.equal(partCount.demotedImages[0].reason, "count_limit");

    const partSingle = partitionVisionAttachments(
      [{ type: "image", fileName: "huge.jpg", path: hugeFp }],
      { maxImages: 10, maxSingleBytes: 2048, maxTotalBytes: 100_000 },
    );
    assert.equal(partSingle.inlineImages.length, 0);
    assert.equal(partSingle.demotedImages.length, 1);
    assert.equal(partSingle.demotedImages[0].reason, "too_large");

    const partTotal = partitionVisionAttachments(files.slice(0, 5), { maxImages: 10, maxSingleBytes: 10_000, maxTotalBytes: 3200 });
    assert.equal(partTotal.inlineImages.length, 3);
    assert.equal(partTotal.demotedImages.length, 2);
    assert.equal(partTotal.demotedImages[0].reason, "total_size_limit");

    // Antigravity: no throw, first 10 inline image blocks + 2 resource_link + demotion text note
    const agBlocks = antigravityContent("看这些图", files, { maxImages: 10, maxSingleBytes: 10_000, maxTotalBytes: 100_000 });
    assert.equal(agBlocks.filter((b) => b.type === "image").length, 10);
    assert.equal(agBlocks.filter((b) => b.type === "resource_link").length, 2);
    assert.match(agBlocks[0].text, /图片附件降级保留/);

    // Claude: no throw, first 10 inline image blocks + demotion notice + full path metadata
    const clBlocks = claudeContent("看这些图", files, { maxImages: 10, maxSingleBytes: 10_000, maxTotalBytes: 100_000 });
    assert.equal(clBlocks.filter((b) => b.type === "image").length, 10);
    assert.ok(clBlocks.some((b) => b.type === "text" && b.text.includes("图片附件降级保留")));

    // Codex app-server protocol: caps localImage at 10 and keeps failure/demotion notes in text
    const proto = createAppServerProtocol({
      config: { workspace: dir, codexSandbox: "danger-full-access", maxFileAttachmentBytes: 50 * 1024 * 1024 },
      applySessionThreadOverrides: (p) => p,
      applySessionTurnOverrides: (p) => p,
      userTextFromContent: (c) => String(c || ""),
      attachmentPromptBlock: () => "Local image attachments: ...",
    });
    const input = proto.inputItems({ content: "看图", attachments: files, attachmentFailures: [{ kind: "file", fileName: "miss.pdf", reason: "download_failed" }] }, "看图");
    assert.equal(input.filter((i) => i.type === "localImage").length, 10);
    assert.match(input[0].text, /图片附件降级保留/);
    assert.match(input[0].text, /miss\.pdf/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v0.10.19: pending attachment store defaults to 50 and reports droppedCount on overflow", () => {
  const store = createPendingAttachmentStore();
  const batch20 = Array.from({ length: 20 }, (_, i) => ({
    type: "file",
    messageId: "om_p1",
    fileKey: `fk_${i}`,
    path: `C:/tmp/f${i}.pdf`,
    receivedAt: Date.now() + i,
  }));
  const res1 = store.add("oc_1", batch20);
  assert.equal(res1.total.length, 20);
  assert.equal(res1.droppedCount, 0);

  const batch35 = Array.from({ length: 35 }, (_, i) => ({
    type: "file",
    messageId: "om_p2",
    fileKey: `fk2_${i}`,
    path: `C:/tmp/g${i}.pdf`,
    receivedAt: Date.now() + 100 + i,
  }));
  const res2 = store.add("oc_1", batch35);
  assert.equal(res2.total.length, 50);
  assert.equal(res2.droppedCount, 5);
  assert.equal(res2.droppedItems.length, 5);
});
