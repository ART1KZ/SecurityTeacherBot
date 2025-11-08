import 'dotenv/config';
import { Bot, InlineKeyboard } from 'grammy';
import { hydrateFiles } from '@grammyjs/files';
import { createClient } from '@supabase/supabase-js';
import { Mistral } from '@mistralai/mistralai';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { extractText } from '../../../doc/parser.js'; // PDF/RTF -> text

/* === ИНИЦИАЛИЗАЦИЯ === */
const bot = new Bot(process.env.BOT_TOKEN);
bot.api.config.use(hydrateFiles(bot.token)); // корректная работа с файлами Telegram 

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY); // supabase-js 
const mistral = new Mistral({ apiKey: process.env.MISTRAL_API_KEY }); // JS клиент Mistral 

/* === UI === */
function kbMain() {
  return new InlineKeyboard()
    .text('➕ Загрузить документ', 'upload')
    .row()
    .text('📊 Отчёты', 'reports')
}
function kbBack() {
  return new InlineKeyboard().text('⬅️ Назад', 'back');
}

/* === УТИЛИТЫ === */
function chunkText(text, size = 2000, overlap = 200) {
  const out = [];
  for (let i = 0; i < text.length; i += (size - overlap)) out.push(text.slice(i, i + size));
  return out;
} // базовый чанкинг [web:36]

async function uploadToStorage(bucket, storagePath, buffer, contentType) {
  const { data, error } = await supabase.storage.from(bucket).upload(storagePath, buffer, {
    contentType,
    upsert: false,
  });
  if (error) throw error;
  return data.path;
} // загрузка в Storage [web:102]

async function upsertDocumentRecord({ title, source, mime, sha256 }) {
  const { data, error } = await supabase
    .from('documents')
    .insert({ title, source, mime, sha256 })
    .select('id')
    .single();
  if (error) throw error;
  return data.id;
} // запись документа [web:61]

async function insertChunks(rows) {
  const { error } = await supabase.from('chunks').insert(rows);
  if (error) throw error;
} // вставка чанков с vector [web:61]

/* === РЕТРАИ + БАТЧИ ДЛЯ MISTRAL === */
async function withRetry(fn, { retries = 6, baseMs = 600, factor = 2, jitter = true } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
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
        /service[_-]tier.*exceeded/i.test(err?.message || '');
      if (!is429 || attempt > retries) throw err;
      const delay = Math.min(15000, (baseMs * (factor ** (attempt - 1))) * (jitter ? (0.8 + Math.random() * 0.4) : 1));
      await new Promise(r => setTimeout(r, delay));
    }
  }
} // обработка лимитов/перегрузки 429 [web:302]

async function embedTextsWithBackoff(texts, { initialBatch = 64, minBatch = 8 } = {}) {
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
      if (batch < initialBatch) batch = Math.min(initialBatch, batch * 2);
    } catch (err) {
      if (batch > minBatch) {
        batch = Math.max(minBatch, Math.floor(batch / 2));
        continue;
      }
      throw err;
    }
  }
  return vectors;
} // батчинг embeddings [web:21]

/* === ОЧЕРЕДЬ И КОНКУРЕНТНОСТЬ === */
const CONCURRENCY = Number(process.env.INGEST_CONCURRENCY ?? 2); // ограничиваем одновременные задания 
const queue = [];
let active = 0;

function enqueueJob(job) {
  return new Promise((resolve, reject) => {
    queue.push({ job, resolve, reject });
    pump();
  });
}

async function pump() {
  if (active >= CONCURRENCY) return;
  const next = queue.shift();
  if (!next) return;
  active++;
  next.job().then(next.resolve, next.reject).finally(() => {
    active--;
    pump();
  });
}

/* === ПРОГРЕСС (краткие статусы + проценты) === */
const steps = [
  { key: 'download', text: 'Загрузка файла…', pct: 10 },
  { key: 'to_storage', text: 'Сохранение…', pct: 25 },
  { key: 'doc_row', text: 'Регистрация…', pct: 35 },
  { key: 'parse', text: 'Чтение текста…', pct: 45 },
  { key: 'chunk', text: 'Подготовка…', pct: 55 },
  { key: 'embed', text: 'Анализ содержания (может занять время)…', pct: 85 },
  { key: 'write', text: 'Завершаем…', pct: 100 },
]; // краткие статусы для не‑тех админа [web:282]

async function updateProgress(ctx, msgId, idx, extra = '') {
  const s = steps[idx];
  await ctx.api.editMessageText(
    ctx.chat.id,
    msgId,
    `${s.pct}% — ${s.text}${extra ? `\n${extra}` : ''}`,
    { reply_markup: kbBack() }
  );
} // лаконичные этапы [web:282]

/* === КОМАНДЫ === */
bot.command('start', async (ctx) => {
  await ctx.reply('Выберите действие:', { reply_markup: kbMain() });
}); // стартовое меню [web:342]

bot.callbackQuery('back', async (ctx) => {
  await ctx.editMessageText('Выберите действие:', { reply_markup: kbMain() });
  await ctx.answerCallbackQuery();
}); // возврат [web:345]

bot.callbackQuery('upload', async (ctx) => {
  await ctx.editMessageText('Отправьте PDF или RTF документ одним сообщением', { reply_markup: kbBack() });
  await ctx.answerCallbackQuery();
}); // подсказка по загрузке [web:282]

bot.callbackQuery('reports', async (ctx) => {
  const { count: docsCount } = await supabase.from('documents').select('*', { count: 'exact', head: true });
  const { count: chunksCount } = await supabase.from('chunks').select('*', { count: 'exact', head: true });
  await ctx.editMessageText(`📊 Отчёт\nДокументов: ${docsCount ?? 0}\nЧанков: ${chunksCount ?? 0}`, {
    reply_markup: kbBack(),
  });
  await ctx.answerCallbackQuery();
}); // минимальные отчёты [web:61]

/* === ПРИЁМ НЕСКОЛЬКИХ ФАЙЛОВ (ОЧЕРЕДЬ) === */
bot.on('message:document', async (ctx) => {
  const doc = ctx.message.document;
  const progress = await ctx.reply('0% — Ожидание…', { reply_markup: kbBack() });

  // каждую загрузку обрабатываем как отдельную задачу в очереди
  enqueueJob(async () => {
    let savedPath = null;
    try {
      // Шаг 1: скачать файл
      await updateProgress(ctx, progress.message_id, 0);
      const file = await ctx.getFile(); // загрузка из Telegram [web:282]
      const tmpDir = path.join(process.cwd(), 'tmp');
      await fs.mkdir(tmpDir, { recursive: true });
      savedPath = path.join(tmpDir, `${crypto.randomUUID()}_${doc.file_name}`);
      await file.download(savedPath);

      // Шаг 2: в Storage
      await updateProgress(ctx, progress.message_id, 1);
      const buffer = await fs.readFile(savedPath);
      const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
      const ext = path.extname(doc.file_name).toLowerCase();
      const storagePath = `${new Date().getFullYear()}/${String(new Date().getMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}${ext}`;
      const bucket = 'documents';
      await uploadToStorage(bucket, storagePath, buffer, doc.mime_type || 'application/octet-stream'); // Storage [web:102]

      // Шаг 3: запись документа
      await updateProgress(ctx, progress.message_id, 2);
      const documentId = await upsertDocumentRecord({
        title: doc.file_name,
        source: `telegram:${ctx.chat.id}`,
        mime: doc.mime_type || 'application/octet-stream',
        sha256,
      }); // запись в Postgres [web:61]

      // Шаг 4: парсинг
      await updateProgress(ctx, progress.message_id, 3);
      const text = await extractText(savedPath); // PDF/RTF -> текст

      // Шаг 5: чанкинг
      await updateProgress(ctx, progress.message_id, 4);
      const chunks = chunkText(text, 2000, 200); // базовые параметры

      // Шаг 6: эмбеддинги (долго)
      await updateProgress(ctx, progress.message_id, 5, `Чанков: ${chunks.length}`);
      const vectors = await embedTextsWithBackoff(chunks, { initialBatch: 64, minBatch: 8 }); // ретраи

      // Шаг 7: запись чанков
      await updateProgress(ctx, progress.message_id, 6);
      const rows = chunks.map((t, i) => ({
        document_id: documentId,
        ord: i,
        text: t,
        embedding: vectors[i],
        tokens: null,
        section: null,
      }));
      await insertChunks(rows); // вставка в pgvector

      await ctx.api.editMessageText(
        ctx.chat.id,
        progress.message_id,
        `✅ Готово: "${doc.file_name}" • чанков: ${rows.length}`,
        { reply_markup: kbMain() }
      ); // финал
    } catch (err) {
      await ctx.api.editMessageText(
        ctx.chat.id,
        progress.message_id,
        `❌ Ошибка: ${err.message}`,
        { reply_markup: kbBack() }
      ); // сообщение об ошибке [web:282]
    } finally {
      if (savedPath) { try { await fs.unlink(savedPath); } catch {} } // гарантированная очистка tmp [web:282]
    }
  }).catch(async (err) => {
    // если enqueue/job упал до старта
    await ctx.api.editMessageText(ctx.chat.id, progress.message_id, `❌ Ошибка очереди: ${err.message}`, { reply_markup: kbBack() });
  });
}); // параллельные задания с ограничением concurrency [web:330]

bot.start(); // запуск long polling [web:342]
