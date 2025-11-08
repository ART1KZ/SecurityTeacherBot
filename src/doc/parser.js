// src/doc/parser.js
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import parseRTF from '@extensionengine/rtf-parser';

async function extractPdfText(filePath) {
  const buf = await readFile(filePath);
  const data = new Uint8Array(buf);
  const loadingTask = pdfjs.getDocument({ data });
  const pdf = await loadingTask.promise;
  try {
    let out = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent({ normalizeWhitespace: true });
      const text = content.items
        .map(item => (typeof item.str === 'string' ? item.str : ''))
        .join(' ');
      out += text + '\n';
    }
    return out.trim();
  } finally {
    await pdf.cleanup?.();
    await pdf.destroy?.();
  }
}

async function extractRtfText(filePath) {
  const buf = await readFile(filePath);
  const doc = await parseRTF(buf); // Promise<RTFDocument>
  const paragraphs = Array.isArray(doc?.content) ? doc.content : [];
  const lines = paragraphs.map(p => {
    const spans = Array.isArray(p?.content) ? p.content : [];
    return spans.map(s => (typeof s?.value === 'string' ? s.value : '')).join('');
  });
  return lines.join('\n').trim();
}

export async function extractText(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return extractPdfText(filePath);
  if (ext === '.rtf') return extractRtfText(filePath);
  throw new Error(`Unsupported file format: ${ext}. Supported: .pdf, .rtf`);
}
