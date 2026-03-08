/**
 * DOCX Template Filler — reads a .docx template and fills {placeholder} fields.
 *
 * Uses docxtemplater to find and replace {tag} placeholders in Word documents.
 * Example: A template with {申請日期}, {付款金額}, {付款地址} gets filled
 * with actual values extracted from a PDF invoice.
 */

import { ok, fail, type Result } from '../result.js';

export interface DocxFieldValues {
  [key: string]: string | number | undefined;
}

/**
 * List all {placeholder} tags found in a DOCX template.
 */
export async function extractTemplateTags(buffer: Buffer): Promise<Result<string[]>> {
  try {
    const PizZip = (await import('pizzip')).default;
    const Docxtemplater = (await import('docxtemplater')).default;

    const zip = new PizZip(buffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{', end: '}' },
    });

    // getFullText and scan for tags
    const fullText = doc.getFullText();
    const tagRegex = /\{([^}]+)\}/g;
    const tags: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = tagRegex.exec(fullText)) !== null) {
      if (!tags.includes(match[1]!)) {
        tags.push(match[1]!);
      }
    }

    return ok(`Found ${tags.length} tags`, tags);
  } catch (err) {
    return fail(`DOCX 範本解析失敗: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Fill a DOCX template with the given field values.
 * Returns the filled DOCX as a Buffer ready to send.
 */
export async function fillDocxTemplate(
  templateBuffer: Buffer,
  values: DocxFieldValues,
): Promise<Result<Buffer>> {
  try {
    const PizZip = (await import('pizzip')).default;
    const Docxtemplater = (await import('docxtemplater')).default;

    const zip = new PizZip(templateBuffer);
    const doc = new Docxtemplater(zip, {
      paragraphLoop: true,
      linebreaks: true,
      delimiters: { start: '{', end: '}' },
    });

    // Replace all tags with values (undefined → empty string)
    const safeValues: Record<string, string | number> = {};
    for (const [key, val] of Object.entries(values)) {
      safeValues[key] = val ?? '';
    }
    doc.render(safeValues);

    const outputBuffer = doc.getZip().generate({
      type: 'nodebuffer',
      compression: 'DEFLATE',
    }) as Buffer;

    return ok('DOCX 填充完成', outputBuffer);
  } catch (err) {
    // docxtemplater throws TemplateError with detailed info
    const errMsg = err instanceof Error ? err.message : String(err);
    return fail(`DOCX 填充失敗: ${errMsg}`);
  }
}
