// src/bot/index.js
import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { hydrateFiles } from '@grammyjs/files';
import { createClient } from '@supabase/supabase-js';
import { Mistral } from '@mistralai/mistralai';
import { transliterate, slugify } from 'transliteration';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { extractText } from '../../doc/parser.js';

/* === ИНИЦИАЛИЗАЦИЯ === */
const bot = new Bot(process.env.BOT_TOKEN);
bot.api.config.use(hydrateFiles(bot.token));

// КРИТИЧНО: используем SERVICE_ROLE для полного доступа [web:384]
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY // не SUPABASE_KEY!
);
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY });

/* === UI КЛАВИАТУРЫ === */
function kbMain() {
  return new InlineKeyboard()
    .text('➕ Загрузить документ', 'upload')
    .row()
    .text('📄 Документы', 'documents')
    .row()
    .text('📊 Отчёты', 'reports')
    .row()
    .text('👤 Пользовательский режим', 'user_mode');
}

function kbBack() {
  return new InlineKeyboard().text('⬅️ Назад', 'back');
}

function kbMainMenu() {
  return new InlineKeyboard().text('🏠 Главное меню', 'main_menu');
}

function kbDocumentsList(currentPage, totalPages, documents) {
  const kb = new InlineKeyboard();
  documents.forEach(doc => {
    kb.text(`📄 ${doc.title.substring(0, 30)}${doc.title.length > 30 ? '...' : ''}`, `doc_view:${doc.id}`).row();
  });

  const navButtons = [];
  if (currentPage > 1) {
    navButtons.push({ text: '« 1', callback_data: 'docs_page:1' });
    if (currentPage > 2) {
      navButtons.push({ text: `‹ ${currentPage - 1}`, callback_data: `docs_page:${currentPage - 1}` });
    }
  }

  navButtons.push({ text: `· ${currentPage} ·`, callback_data: 'noop' });

  if (currentPage < totalPages) {
    if (currentPage < totalPages - 1) {
      navButtons.push({ text: `${currentPage + 1} ›`, callback_data: `docs_page:${currentPage + 1}` });
    }
    navButtons.push({ text: `${totalPages} »`, callback_data: `docs_page:${totalPages}` });
  }

  if (navButtons.length > 0) {
    navButtons.forEach(btn => kb.text(btn.text, btn.callback_data));
    kb.row();
  }

  kb.text('⬅️ Назад', 'main_menu');
  return kb;
}

function kbDocumentView(docId) {
  return new InlineKeyboard()
    .text('✏️ Переименовать', `doc_rename:${docId}`)
    .text('🗑️ Удалить', `doc_delete_confirm:${docId}`)
    .row()
    .text('⬅️ К списку', 'documents')
    .row()
    .text('🏠 Главное меню', 'main_menu');
}

function kbDeleteConfirm(docId) {
  return new InlineKeyboard()
    .text('✅ Да, удалить', `doc_delete:${docId}`)
    .text('❌ Отмена', `doc_view:${docId}`);
}

/* === УТИЛИТЫ === */
// Безопасное имя файла для S3/Supabase Storage [web:261][web:390]
function sanitizeStoragePath(filename) {
  const ext = path.extname(filename); // .pdf, .rtf
  const base = path.basename(filename, ext);
  // транслитерация + slugify: кириллица → латиница, безопасные символы [web:390]
  const slug = slugify(base, {
    lowercase: true,
    separator: '_',
    replace: [], // дополнительные замены при необходимости
  });
  // добавляем UUID для уникальности и исходное расширение
  return `${slug}_${crypto.randomUUID().slice(0, 8)}${ext}`;
}

async function safeEditMessageText(ctx, chatId, messageId, text, options = {}) {
  try {
    await ctx.api.editMessageText(chatId, messageId, text, options);
  } catch (err) {
    if (err.error_code !== 400 || !err.description?.includes('message is not modified')) {
      throw err;
    }
  }
}

function escapeMarkdown(text) {
  return text.replace(/([_*\[\]()~`>#+=|{}.!-])/g, '\\$1');
}

function chunkText(text, size = 2000, overlap = 200) {
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap)) {
    out.push(text.slice(i, i + size));
  }
  return out;
}

async function uploadToStorage(bucket, storagePath, buffer, contentType) {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(storagePath, buffer, {
      contentType,
      upsert: false,
    });
  if (error) throw error;
  return data.path;
}

async function deleteFromStorage(bucket, storagePath) {
  const { error } = await supabase.storage
    .from(bucket)
    .remove([storagePath]);
  if (error) throw error;
}

async function upsertDocumentRecord({ title, source, mime, sha256, storagePath }) {
  const { data, error } = await supabase
    .from('documents')
    .insert({ title, source, mime, sha256, storage_path: storagePath })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
}

async function insertChunks(rows) {
  const { error } = await supabase.from('chunks').insert(rows);
  if (error) throw error;
}

/* === РЕТРАИ И БАТЧИ === */
async function withRetry(fn, { retries = 6, baseMs = 600, factor = 2, jitter = true } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      const is429 =
        err?.status === 429 ||
        err?.statusCode === 429 ||
        err?.response?.status === 429 ||
        err?.code === '3505' ||
        err?.body?.type === 'service_tier_capacity_exceeded' ||
        /rate.*limit|too.*many.*requests|service[_-]tier.*exceeded/i.test(err?.message || '');
      if (!is429 || attempt > retries) throw err;
      const delay = Math.min(
        15000,
        baseMs * (factor ** (attempt - 1)) * (jitter ? 0.8 + Math.random() * 0.4 : 1)
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function embedTextsWithBackoff(texts, { initialBatch = 16, minBatch = 8 } = {}) {
  let batch = initialBatch;
  const vectors = [];
  for (let i = 0; i < texts.length; ) {
    const slice = texts.slice(i, i + batch);
    try {
      const res = await withRetry(() =>
        mistral.embeddings.create({
          model: 'mistral-embed',
          inputs: slice,
        })
      );
      vectors.push(...res.data.map(d => d.embedding));
      i += batch;
      await new Promise(r => setTimeout(r, 200));
      if (batch < initialBatch) {
        batch = Math.min(initialBatch, batch * 2);
      }
    } catch (err) {
      if (batch > minBatch) {
        batch = Math.max(minBatch, Math.floor(batch / 2));
        continue;
      }
      throw err;
    }
  }
  return vectors;
}

/* === ОЧЕРЕДЬ === */
const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 2);
const queue = [];
let active = 0;

function enqueueJob(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}

async function pump() {
  if (active >= CONCURRENCY || queue.length === 0) return;
  const next = queue.shift();
  active++;
  next.job()
    .then(next.resolve, next.reject)
    .finally(() => {
      active--;
      pump();
    });
}

/* === ПРОГРЕСС === */
const steps = [
  { text: 'Загрузка файла...', pct: 10 },
  { text: 'Сохранение в хранилище...', pct: 25 },
  { text: 'Регистрация документа...', pct: 35 },
  { text: 'Извлечение текста...', pct: 45 },
  { text: 'Разбиение на фрагменты...', pct: 55 },
  { text: 'Генерация эмбеддингов векторов (может занять МНОГО времени)...', pct: 75 },
  { text: 'Сохранение в БД...', pct: 100 },
];

async function updateProgress(ctx, msgId, idx, extra = '') {
  const s = steps[idx];
  await safeEditMessageText(
    ctx,
    ctx.chat.id,
    msgId,
    `${s.pct}% — ${s.text}${extra ? `\n${extra}` : ''}`,
    { reply_markup: kbBack() }
  );
}

/* === РАБОТА С ДОКУМЕНТАМИ === */
async function getDocuments(page = 1, perPage = 5) {
  const from = (page - 1) * perPage;
  const to = from + perPage - 1;
  const { data, error, count } = await supabase
    .from('documents')
    .select('id, title, created_at, mime', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range(from, to);
  if (error) throw error;
  const totalPages = Math.max(1, Math.ceil((count || 0) / perPage));
  return { documents: data || [], totalPages, currentPage: page, total: count || 0 };
}

async function getDocumentInfo(docId) {
  const { data: doc, error: docError } = await supabase
    .from('documents')
    .select('*')
    .eq('id', docId)
    .single();
  if (docError) throw docError;
  const { count } = await supabase
    .from('chunks')
    .select('*', { count: 'exact', head: true })
    .eq('document_id', docId);
  return { ...doc, chunksCount: count || 0 };
}

async function deleteDocument(docId) {
  const doc = await getDocumentInfo(docId);
  await supabase.from('chunks').delete().eq('document_id', docId);
  await supabase.from('documents').delete().eq('id', docId);
  if (doc.storage_path) {
    try {
      await deleteFromStorage('documents', doc.storage_path);
    } catch (err) {
      console.error('Ошибка удаления из Storage:', err);
    }
  }
}

async function renameDocument(docId, newTitle) {
  const { error } = await supabase
    .from('documents')
    .update({ title: newTitle })
    .eq('id', docId);
  if (error) throw error;
}

/* === СОСТОЯНИЯ === */
const renamingStates = new Map();

/* === КОМАНДЫ === */
bot.command('start', async (ctx) => {
  await ctx.reply('🤖 *Админ-панель SecurityTeacher*\n\nВыберите действие:', {
    parse_mode: 'Markdown',
    reply_markup: kbMain(),
  });
});

bot.callbackQuery(['back', 'main_menu'], async (ctx) => {
  await ctx.editMessageText('🤖 *Админ-панель SecurityTeacher*\n\nВыберите действие:', {
    parse_mode: 'Markdown',
    reply_markup: kbMain(),
  });
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('noop', async (ctx) => {
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('user_mode', async (ctx) => {
  await ctx.editMessageText(
    '👤 *Пользовательский режим*\n\nЗдесь будет основной интерфейс для пользователей.\n\n_Функционал в разработке..._',
    {
      parse_mode: 'Markdown',
      reply_markup: kbMainMenu(),
    }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('upload', async (ctx) => {
  await ctx.editMessageText(
    '📤 *Загрузка документа*\n\nОтправьте PDF или RTF документ.\n\nПоддерживаемые форматы: PDF, RTF',
    {
      parse_mode: 'Markdown',
      reply_markup: kbMainMenu(),
    }
  );
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('documents', async (ctx) => {
  try {
    const { documents, totalPages, currentPage, total } = await getDocuments(1);
    if (documents.length === 0) {
      await ctx.editMessageText(
        '📄 *Документы*\n\nУ вас пока нет загруженных документов.',
        {
          parse_mode: 'Markdown',
          reply_markup: kbMainMenu(),
        }
      );
    } else {
      await ctx.editMessageText(
        `📄 *Документы* (всего: ${total})\n\nВыберите документ:`,
        {
          parse_mode: 'Markdown',
          reply_markup: kbDocumentsList(currentPage, totalPages, documents),
        }
      );
    }
  } catch (err) {
    await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
      reply_markup: kbMainMenu(),
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^docs_page:(\d+)$/, async (ctx) => {
  const page = parseInt(ctx.match[1]);
  try {
    const { documents, totalPages, currentPage, total } = await getDocuments(page);
    await safeEditMessageText(
      ctx,
      ctx.chat.id,
      ctx.callbackQuery.message.message_id,
      `📄 *Документы* (всего: ${total})\n\nВыберите документ:`,
      {
        parse_mode: 'Markdown',
        reply_markup: kbDocumentsList(currentPage, totalPages, documents),
      }
    );
  } catch (err) {
    await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
      reply_markup: kbMainMenu(),
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^doc_view:(\d+)$/, async (ctx) => {
  const docId = parseInt(ctx.match[1]);
  try {
    const doc = await getDocumentInfo(docId);
    const date = new Date(doc.created_at).toLocaleString('ru-RU');
    const info = [
      `📄 *${escapeMarkdown(doc.title)}*`,
      '',
      `📅 Загружен: ${date}`,
      `📦 Тип: ${doc.mime}`,
      `🔢 Фрагментов: ${doc.chunksCount}`,
    ].join('\n');
    await ctx.editMessageText(info, {
      parse_mode: 'Markdown',
      reply_markup: kbDocumentView(docId),
    });
  } catch (err) {
    await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
      reply_markup: kbMainMenu(),
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^doc_delete_confirm:(\d+)$/, async (ctx) => {
  const docId = parseInt(ctx.match[1]);
  try {
    const doc = await getDocumentInfo(docId);
    await ctx.editMessageText(
      `⚠️ Подтверждение удаления\n\nВы уверены?\n\nДокумент: "${doc.title}"\nФрагментов: ${doc.chunksCount}\n\nДействие необратимо!`,
      { reply_markup: kbDeleteConfirm(docId) }
    );
  } catch (err) {
    await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
      reply_markup: kbMainMenu(),
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^doc_delete:(\d+)$/, async (ctx) => {
  const docId = parseInt(ctx.match[1]);
  try {
    await ctx.editMessageText('🗑️ Удаление...', {});
    await deleteDocument(docId);
    await ctx.editMessageText('✅ Документ удалён!', {
      reply_markup: kbMainMenu(),
    });
  } catch (err) {
    await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
      reply_markup: kbMainMenu(),
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery(/^doc_rename:(\d+)$/, async (ctx) => {
  const docId = parseInt(ctx.match[1]);
  try {
    const doc = await getDocumentInfo(docId);
    renamingStates.set(ctx.chat.id, { docId, oldTitle: doc.title });
    await ctx.editMessageText(
      `✏️ *Переименование*\n\nТекущее название:\n"${escapeMarkdown(doc.title)}"\n\nОтправьте новое название:`,
      {
        parse_mode: 'Markdown',
        reply_markup: new InlineKeyboard().text('❌ Отмена', `doc_view:${docId}`),
      }
    );
  } catch (err) {
    await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
      reply_markup: kbMainMenu(),
    });
  }
  await ctx.answerCallbackQuery();
});

bot.callbackQuery('reports', async (ctx) => {
  const { count: docsCount } = await supabase
    .from('documents')
    .select('*', { count: 'exact', head: true });
  const { count: chunksCount } = await supabase
    .from('chunks')
    .select('*', { count: 'exact', head: true });
  await ctx.editMessageText(
    `📊 *Статистика*\n\n📄 Документов: ${docsCount ?? 0}\n🔢 Векторов: ${chunksCount ?? 0}`,
    {
      parse_mode: 'Markdown',
      reply_markup: kbMainMenu(),
    }
  );
  await ctx.answerCallbackQuery();
});

/* === ТЕКСТ === */
bot.on('message:text', async (ctx) => {
  const chatId = ctx.chat.id;
  if (renamingStates.has(chatId)) {
    const { docId } = renamingStates.get(chatId);
    const newTitle = ctx.message.text.trim();
    if (!newTitle || newTitle.length < 1 || newTitle.length > 255) {
      await ctx.reply('❌ Название должно быть от 1 до 255 символов.');
      return;
    }
    try {
      await renameDocument(docId, newTitle);
      renamingStates.delete(chatId);
      const doc = await getDocumentInfo(docId);
      const date = new Date(doc.created_at).toLocaleString('ru-RU');
      const info = [
        `✅ *Переименовано!*`,
        '',
        `📄 *${escapeMarkdown(doc.title)}*`,
        '',
        `📅 Загружен: ${date}`,
        `📦 Тип: ${doc.mime}`,
        `🔢 Фрагментов: ${doc.chunksCount}`,
      ].join('\n');
      await ctx.reply(info, {
        parse_mode: 'Markdown',
        reply_markup: kbDocumentView(docId),
      });
    } catch (err) {
      await ctx.reply(`❌ Ошибка: ${err.message}`, {
        reply_markup: kbMainMenu(),
      });
      renamingStates.delete(chatId);
    }
  }
});

/* === ДОКУМЕНТЫ === */
bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  const allowedMimeTypes = ['application/pdf', 'application/rtf', 'text/rtf'];
  if (!allowedMimeTypes.includes(doc.mime_type)) {
    await ctx.reply(
      '❌ Неподдерживаемый формат.\n\nПоддерживаются: PDF, RTF',
      { reply_markup: kbMainMenu() }
    );
    return;
  }

  const progress = await ctx.reply('0% — Ожидание...', { reply_markup: kbBack() });

  enqueueJob(async () => {
    let savedPath = null;
    try {
      await updateProgress(ctx, progress.message_id, 0);
      const file = await ctx.getFile();
      const tmpDir = path.join(process.cwd(), 'tmp');
      await fs.mkdir(tmpDir, { recursive: true });
      savedPath = path.join(tmpDir, `${crypto.randomUUID()}_${doc.file_name}`);
      await file.download(savedPath);

      await updateProgress(ctx, progress.message_id, 1);
      const buffer = await fs.readFile(savedPath);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      
      // ИСПРАВЛЕНИЕ: безопасное имя через транслитерацию [web:390][web:261]
      const storagePath = sanitizeStoragePath(doc.file_name);
      const bucket = 'documents';
      await uploadToStorage(bucket, storagePath, buffer, doc.mime_type);

      await updateProgress(ctx, progress.message_id, 2);
      const documentId = await upsertDocumentRecord({
        title: doc.file_name, // оригинальное имя для UI
        source: `telegram:${ctx.chat.id}`,
        mime: doc.mime_type,
        sha256,
        storagePath, // безопасное имя для Storage
      });

      await updateProgress(ctx, progress.message_id, 3);
      const text = await extractText(savedPath);

      await updateProgress(ctx, progress.message_id, 4);
      const chunks = chunkText(text, 2000, 200);

      await updateProgress(ctx, progress.message_id, 5, `Фрагментов: ${chunks.length}`);
      const vectors = await embedTextsWithBackoff(chunks, {
        initialBatch: 16,
        minBatch: 8,
      });

      await updateProgress(ctx, progress.message_id, 6);
      const rows = chunks.map((t, i) => ({
        document_id: documentId,
        ord: i,
        text: t,
        embedding: vectors[i],
        tokens: null,
        section: null,
      }));
      await insertChunks(rows);

      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        progress.message_id,
        `✅ Загружено!\n\n📄 "${doc.file_name}"\n🔢 Фрагментов: ${rows.length}`,
        { reply_markup: kbMain() }
      );
    } catch (err) {
      await safeEditMessageText(
        ctx,
        ctx.chat.id,
        progress.message_id,
        `❌ Ошибка\n\n${err.message}`,
        { reply_markup: kbMainMenu() }
      );
    } finally {
      if (savedPath) {
        try {
          await fs.unlink(savedPath);
        } catch {}
      }
    }
  }).catch(async (err) => {
    await safeEditMessageText(
      ctx,
      ctx.chat.id,
      progress.message_id,
      `❌ Ошибка очереди: ${err.message}`,
      { reply_markup: kbMainMenu() }
    );
  });
});

bot.start();
console.log('🤖 Бот запущен');
