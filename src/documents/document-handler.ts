/**
 * Document upload handler — processes PDF, DOCX, CSV, XLSX files from Telegram.
 *
 * Supports two modes:
 * 1. **Single file**: process individually (PDF→analysis, CSV/XLSX→data analysis)
 * 2. **Media group** (multi-file upload): buffers files for 3s, then processes together
 *    - PDF + DOCX template → extract data from PDF, fill DOCX template, return filled DOCX
 *    - CSV/XLSX in group → data analysis included in combined response
 */

import type { Bot } from 'grammy';
import { InputFile } from 'grammy';
import type { BotContext } from '../bot.js';
import { config } from '../config.js';
import { logger } from '../core/logger.js';
import { eventBus } from '../core/event-bus.js';
import { isOk } from '../result.js';
import { sendLongMessage, formatUserError } from '../telegram/helpers.js';
import { downloadTelegramFile } from './file-downloader.js';
import { parseDocument } from './parsers.js';
import { extractTemplateTags, fillDocxTemplate, type DocxFieldValues } from './docx-filler.js';
import { DOC_CONFIG, type ParsedDocument, type FileGroup } from './types.js';

// ── Media group buffer ──────────────────────────────────────────────
// Telegram sends multi-file uploads as separate updates with the same media_group_id.
// We buffer them and process together after a short timeout.

const mediaGroupBuffers = new Map<string, FileGroup>();

// ── Public API ──────────────────────────────────────────────────────

export function setupDocumentHandler(bot: Bot<BotContext>): void {
  bot.on('message:document', async (ctx) => {
    const userId = ctx.from?.id;
    const chatId = ctx.chat.id;
    const doc = ctx.message.document;

    if (!userId || !doc) return;

    // Admin-only for now
    if (userId !== config.ADMIN_USER_ID) {
      await ctx.reply('目前檔案處理功能僅供管理員使用。');
      return;
    }

    const fileName = doc.file_name || 'unknown';
    const mimeType = doc.mime_type;
    const mediaGroupId = ctx.message.media_group_id;

    await eventBus.emit('document:received', { chatId, userId, type: mimeType || 'unknown', fileName });

    // Download and parse
    const downloadResult = await downloadTelegramFile(bot, doc.file_id, fileName, mimeType);
    if (!downloadResult.ok) {
      await ctx.reply(formatUserError('cli-error', downloadResult.error));
      return;
    }

    const { buffer, docType } = downloadResult.value;

    const parseResult = await parseDocument(docType, buffer, fileName);
    if (!parseResult.ok) {
      await ctx.reply(formatUserError('cli-error', parseResult.error));
      return;
    }

    const parsed = parseResult.value;

    // If part of a media group, buffer and wait for more files
    if (mediaGroupId) {
      await bufferMediaGroupFile(mediaGroupId, chatId, userId, parsed, ctx);
      return;
    }

    // Single file — process immediately
    await processSingleFile(ctx, chatId, userId, parsed);
  });
}

// ── Media Group Buffering ───────────────────────────────────────────

async function bufferMediaGroupFile(
  mediaGroupId: string,
  chatId: number,
  userId: number,
  parsed: ParsedDocument,
  ctx: BotContext,
): Promise<void> {
  let group = mediaGroupBuffers.get(mediaGroupId);

  if (!group) {
    group = {
      chatId,
      userId,
      caption: ctx.message?.caption || undefined,
      files: [],
      timer: setTimeout(() => {
        processMediaGroup(mediaGroupId, ctx).catch((err) => {
          logger.error('document-handler', `Media group processing error: ${err}`);
        });
      }, DOC_CONFIG.MEDIA_GROUP_TIMEOUT_MS),
    };
    mediaGroupBuffers.set(mediaGroupId, group);
  }

  // Capture caption from any file in the group
  if (ctx.message?.caption && !group.caption) {
    group.caption = ctx.message.caption;
  }

  group.files.push(parsed);
  await logger.info('document-handler',
    `Buffered ${parsed.type} (${parsed.fileName}) in media group ${mediaGroupId}, total: ${group.files.length}`);
}

// ── Media Group Processing ──────────────────────────────────────────

async function processMediaGroup(mediaGroupId: string, ctx: BotContext): Promise<void> {
  const group = mediaGroupBuffers.get(mediaGroupId);
  mediaGroupBuffers.delete(mediaGroupId);

  if (!group || group.files.length === 0) return;

  const { chatId, userId, files, caption } = group;
  const start = Date.now();

  await logger.info('document-handler',
    `Processing media group: ${files.map(f => `${f.type}(${f.fileName})`).join(', ')}`);

  const progressMsg = await ctx.reply(`📎 收到 ${files.length} 個檔案，分析中...`);

  try {
    // Classify files by type
    const pdfFiles = files.filter(f => f.type === 'pdf');
    const docxFiles = files.filter(f => f.type === 'docx');
    const spreadsheetFiles = files.filter(f => f.type === 'csv' || f.type === 'xlsx');

    const responses: string[] = [];

    // Case 1: PDF + DOCX template → extract data, fill template
    if (pdfFiles.length > 0 && docxFiles.length > 0) {
      const fillResult = await handlePdfToDocx(ctx, chatId, userId, pdfFiles[0]!, docxFiles[0]!, caption);
      if (fillResult) responses.push(fillResult);
    } else if (pdfFiles.length > 0) {
      // PDF only → just analyze
      const analysis = await analyzeWithClaude(chatId, userId, pdfFiles[0]!, caption);
      if (analysis) responses.push(analysis);
    }

    // Case 2: CSV/XLSX → data analysis
    for (const spreadsheet of spreadsheetFiles) {
      const analysis = await analyzeWithClaude(chatId, userId, spreadsheet, caption);
      if (analysis) responses.push(analysis);
    }

    // Clean up progress message
    try { await ctx.api.deleteMessage(chatId, progressMsg.message_id); } catch { /* ignore */ }

    // Send combined response
    if (responses.length > 0) {
      const combined = responses.join('\n\n---\n\n');
      await sendLongMessage(ctx, chatId, combined, 'Markdown');
    }

    const durationMs = Date.now() - start;
    await eventBus.emit('document:processed', {
      chatId,
      type: files.map(f => f.type).join('+'),
      fileName: files.map(f => f.fileName).join(', '),
      durationMs,
    });

  } catch (err) {
    try { await ctx.api.deleteMessage(chatId, progressMsg.message_id); } catch { /* ignore */ }
    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(formatUserError('system-error', errMsg));
    await eventBus.emit('document:error', {
      chatId,
      type: files.map(f => f.type).join('+'),
      fileName: files.map(f => f.fileName).join(', '),
      error: errMsg,
    });
  }
}

// ── Single File Processing ──────────────────────────────────────────

async function processSingleFile(
  ctx: BotContext,
  chatId: number,
  userId: number,
  parsed: ParsedDocument,
): Promise<void> {
  const start = Date.now();
  const progressMsg = await ctx.reply(`📎 正在分析 ${parsed.fileName}...`);

  try {
    const caption = ctx.message?.caption || undefined;
    const analysis = await analyzeWithClaude(chatId, userId, parsed, caption);

    try { await ctx.api.deleteMessage(chatId, progressMsg.message_id); } catch { /* ignore */ }

    if (analysis) {
      await sendLongMessage(ctx, chatId, analysis, 'Markdown');
    }

    await eventBus.emit('document:processed', {
      chatId, type: parsed.type, fileName: parsed.fileName,
      durationMs: Date.now() - start,
    });
  } catch (err) {
    try { await ctx.api.deleteMessage(chatId, progressMsg.message_id); } catch { /* ignore */ }
    const errMsg = err instanceof Error ? err.message : String(err);
    await ctx.reply(formatUserError('system-error', errMsg));
    await eventBus.emit('document:error', {
      chatId, type: parsed.type, fileName: parsed.fileName, error: errMsg,
    });
  }
}

// ── PDF + DOCX Template Flow ────────────────────────────────────────

async function handlePdfToDocx(
  ctx: BotContext,
  _chatId: number,
  userId: number,
  pdfDoc: ParsedDocument,
  docxTemplate: ParsedDocument,
  caption?: string,
): Promise<string | null> {
  // 1. Extract template tags
  const tagsResult = await extractTemplateTags(docxTemplate.buffer);
  const tags = tagsResult.ok ? tagsResult.value : [];
  const templateText = docxTemplate.textContent;

  // 2. Build prompt for Claude to extract field values from PDF
  const prompt = buildPdfDocxPrompt(pdfDoc, templateText, tags, caption);

  // 3. Call Claude to analyze PDF and extract field values
  const { askClaudeCode, LIGHTWEIGHT_CWD } = await import('../claude/claude-code.js');

  const result = await askClaudeCode(prompt, userId, {
    skipResume: true,
    maxTurns: 5,
    cwd: LIGHTWEIGHT_CWD,
    model: config.MODEL_TIER_SONNET,
  });

  if (!isOk(result)) {
    await ctx.reply(formatUserError('cli-error', result.error));
    return null;
  }

  const aiResponse = result.value.result;

  // 4. Parse JSON field values from AI response
  const fieldValues = extractJsonFromResponse(aiResponse);

  if (tags.length === 0) {
    await ctx.reply('⚠️ DOCX 範本中沒有找到 {佔位符} 標籤，無法自動填充。');
    await logger.warn('document-handler', `No template tags found in ${docxTemplate.fileName}`);
  } else if (!fieldValues) {
    await ctx.reply('⚠️ AI 未回傳可解析的 JSON 欄位值，DOCX 填充已跳過。');
    await logger.warn('document-handler', `JSON extraction failed from AI response for ${docxTemplate.fileName}`);
  } else {
    // 5. Fill DOCX template
    const fillResult = await fillDocxTemplate(docxTemplate.buffer, fieldValues);
    if (fillResult.ok) {
      // Replace {yyyyMMdd} in filename with today's date
      const now = new Date();
      const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const outputName = docxTemplate.fileName
        .replace(/\{yyyyMMdd\}/gi, dateStr)
        .replace('.docx', '_filled.docx');
      await ctx.replyWithDocument(
        new InputFile(fillResult.value, outputName),
        { caption: '✅ 申請單已填寫完成' },
      );
      await logger.info('document-handler', `DOCX template filled: ${outputName}`);
    } else {
      await ctx.reply(`⚠️ DOCX 填充失敗: ${fillResult.error}\n\n以下是 AI 分析結果：`);
    }
  }

  // Return AI's analysis text (includes summary of extracted data)
  return aiResponse;
}

// ── Claude Integration ──────────────────────────────────────────────

async function analyzeWithClaude(
  _chatId: number,
  userId: number,
  doc: ParsedDocument,
  caption?: string,
): Promise<string | null> {
  const prompt = buildAnalysisPrompt(doc, caption);

  const { askClaudeCode, LIGHTWEIGHT_CWD } = await import('../claude/claude-code.js');
  const result = await askClaudeCode(prompt, userId, {
    skipResume: true,
    maxTurns: 5,
    cwd: LIGHTWEIGHT_CWD,
    model: config.MODEL_TIER_SONNET,
  });

  if (!isOk(result)) {
    return formatUserError('cli-error', result.error);
  }

  return result.value.result || '(無分析結果)';
}

// ── Prompt Builders ─────────────────────────────────────────────────

function buildPdfDocxPrompt(
  pdfDoc: ParsedDocument,
  templateText: string,
  tags: string[],
  caption?: string,
): string {
  const parts: string[] = [];

  parts.push('你是文件數據提取助手。用戶上傳了一份 PDF 帳單和一份 DOCX 申請單範本。');
  parts.push('');
  parts.push('## 任務');
  parts.push('1. 從 PDF 帳單中提取關鍵數據（折扣後金額、付款地址等）');
  parts.push('2. 根據 DOCX 範本的欄位結構，產生對應的欄位值');
  parts.push('3. 輸出分析摘要 + JSON 格式的欄位值');
  parts.push('');

  if (caption) {
    parts.push(`## 用戶指示`);
    parts.push(caption);
    parts.push('');
  }

  parts.push(`## PDF 帳單內容 (${pdfDoc.fileName})`);
  parts.push('```');
  parts.push(pdfDoc.textContent.slice(0, 30000));
  parts.push('```');
  parts.push('');

  parts.push(`## DOCX 範本內容 (${templateText ? '已提取文字' : '無法提取'})`);
  if (templateText) {
    parts.push('```');
    parts.push(templateText.slice(0, 10000));
    parts.push('```');
  }
  parts.push('');

  if (tags.length > 0) {
    parts.push(`## 範本佔位符 (需要填入的欄位)`);
    parts.push(tags.map(t => `- {${t}}`).join('\n'));
    parts.push('');
  }

  parts.push('## 輸出格式');
  parts.push('先提供分析摘要（中文），然後在最後以 JSON 格式輸出欄位值：');
  parts.push('```json');
  if (tags.length > 0) {
    const example: Record<string, string> = {};
    for (const tag of tags) example[tag] = '從 PDF 提取的值';
    parts.push(JSON.stringify(example, null, 2));
  } else {
    parts.push('{ "欄位名": "值", ... }');
  }
  parts.push('```');

  return parts.join('\n');
}

function buildAnalysisPrompt(doc: ParsedDocument, caption?: string): string {
  const parts: string[] = [];

  if (doc.type === 'pdf') {
    parts.push(`用戶上傳了 PDF 檔案: ${doc.fileName}`);
    if (doc.meta.pageCount) parts.push(`(共 ${doc.meta.pageCount} 頁)`);
    parts.push('');
    if (caption) { parts.push(`用戶指示: ${caption}`); parts.push(''); }
    parts.push('請分析以下 PDF 內容，提取關鍵資訊：');
    parts.push('```');
    parts.push(doc.textContent.slice(0, 30000));
    parts.push('```');
  } else {
    // CSV / XLSX
    parts.push(`用戶上傳了${doc.type === 'csv' ? ' CSV' : ' XLSX'} 數據檔案: ${doc.fileName}`);
    if (doc.meta.rowCount !== undefined) {
      parts.push(`(${doc.meta.rowCount} 行 × ${doc.meta.columnCount} 欄)`);
    }
    parts.push('');
    if (caption) { parts.push(`用戶指示: ${caption}`); parts.push(''); }
    parts.push('請分析以下數據，總結重點，並指出是否有異常值或需要注意的趨勢：');
    parts.push('');
    parts.push(doc.textContent);
  }

  return parts.join('\n');
}

// ── JSON Extraction ─────────────────────────────────────────────────

function extractJsonFromResponse(response: string): DocxFieldValues | null {
  // Strategy 1: Find ```json ... ``` blocks (try last one first — prompt puts JSON at end)
  const jsonBlocks = [...response.matchAll(/```json\s*\r?\n([\s\S]*?)\r?\n\s*```/g)];
  for (let i = jsonBlocks.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(jsonBlocks[i]![1]!) as DocxFieldValues;
    } catch { /* try next */ }
  }

  // Strategy 2: Find any ``` ... ``` block that looks like JSON
  const codeBlocks = [...response.matchAll(/```\s*\r?\n([\s\S]*?)\r?\n\s*```/g)];
  for (let i = codeBlocks.length - 1; i >= 0; i--) {
    const content = codeBlocks[i]![1]!.trim();
    if (content.startsWith('{')) {
      try {
        return JSON.parse(content) as DocxFieldValues;
      } catch { /* try next */ }
    }
  }

  // Strategy 3: Bare JSON object — find last { ... } pair using bracket matching
  const lastBrace = response.lastIndexOf('}');
  if (lastBrace !== -1) {
    // Walk backwards to find matching opening brace
    let depth = 0;
    for (let i = lastBrace; i >= 0; i--) {
      if (response[i] === '}') depth++;
      else if (response[i] === '{') depth--;
      if (depth === 0) {
        try {
          return JSON.parse(response.slice(i, lastBrace + 1)) as DocxFieldValues;
        } catch { break; }
      }
    }
  }

  logger.warn('document-handler', `Failed to extract JSON from AI response (length=${response.length})`);
  return null;
}
