/**
 * ⚙️ АДМИНИСТРАТИВНАЯ ПАНЕЛЬ БОТА
 *
 * Обрабатывает загрузку, управление и удаление документов.
 * Все обработчики регистрируются на adminComposer для правильной архитектуры.
 */

import { InlineKeyboard, InputFile } from "grammy";
import { slugify } from "transliteration";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { extractText } from "../../doc/parser.js";
import { bot, supabase, mistral } from "../bot.js";
import { adminComposer } from "../handlers.js";

// ═══════════════════════════════════════════════════════════════
// 📋 КЛАВИАТУРЫ АДМИНКИ
// ═══════════════════════════════════════════════════════════════

function adminMainMenu() {
    return new InlineKeyboard()
        .text("📤 Загрузить документ", "admin_upload")
        .row()
        .text("📄 Документы", "admin_documents")
        .row()
        .text("📊 Статистика", "admin_stats")
        .row()
        .text("👤 Пользовательский режим", "user_main_menu");
}

function adminBackButton() {
    return new InlineKeyboard().text("⬅️ Назад", "admin_back");
}

function adminDocumentsList(currentPage, totalPages, documents) {
    const kb = new InlineKeyboard();

    documents.forEach((doc) => {
        const title =
            doc.title.length > 30
                ? doc.title.substring(0, 30) + "..."
                : doc.title;
        kb.text(`📄 ${title}`, `admin_doc_view_${doc.id}`).row();
    });

    const nav = [];
    if (currentPage > 1) {
        nav.push({ text: "« 1", callback_data: "admin_docs_page_1" });
        if (currentPage > 2) {
            nav.push({
                text: `‹ ${currentPage - 1}`,
                callback_data: `admin_docs_page_${currentPage - 1}`,
            });
        }
    }

    nav.push({ text: `· ${currentPage} ·`, callback_data: "admin_noop" });

    if (currentPage < totalPages) {
        if (currentPage < totalPages - 1) {
            nav.push({
                text: `${currentPage + 1} ›`,
                callback_data: `admin_docs_page_${currentPage + 1}`,
            });
        }
        nav.push({
            text: `${totalPages} »`,
            callback_data: `admin_docs_page_${totalPages}`,
        });
    }

    if (nav.length > 0) {
        nav.forEach((btn) => kb.text(btn.text, btn.callback_data));
        kb.row();
    }

    kb.text("⬅️ Назад", "admin_main_menu");
    return kb;
}

function adminDocumentActions(docId) {
    return new InlineKeyboard()
        .text("📥 Скачать", `admin_doc_download_${docId}`)
        .row()
        .text("✏️ Переименовать", `admin_doc_rename_${docId}`)
        .text("🗑️ Удалить", `admin_doc_del_confirm_${docId}`)
        .row()
        .text("⬅️ К списку", "admin_documents")
        .row()
        .text("🏠 Главное меню", "admin_main_menu");
}

function adminBackToDocument(docId) {
    return new InlineKeyboard().text(
        "⬅️ Назад к документу",
        `admin_doc_view_${docId}`
    );
}

function adminDeleteConfirm(docId) {
    return new InlineKeyboard()
        .text("✅ Да, удалить", `admin_doc_delete_${docId}`)
        .text("❌ Отмена", `admin_doc_view_${docId}`);
}

// ═══════════════════════════════════════════════════════════════
// 🔧 УТИЛИТЫ
// ═══════════════════════════════════════════════════════════════

function sanitizeStoragePath(filename) {
    const ext = path.extname(filename);
    const base = path.basename(filename, ext);
    const slug = slugify(base, {
        lowercase: true,
        separator: "_",
        replace: [],
    });
    return `${slug}_${crypto.randomUUID().slice(0, 8)}${ext}`;
}

async function safeEditMessageText(ctx, chatId, messageId, text, options = {}) {
    try {
        await ctx.api.editMessageText(chatId, messageId, text, options);
    } catch (err) {
        if (
            err.error_code !== 400 ||
            !err.description?.includes("message is not modified")
        ) {
            throw err;
        }
    }
}

function escapeMarkdown(text) {
    return text.replace(/([_*\[\]()~`>#+=|{}.!-])/g, "\\$1");
}

/**
 * Семантический чанкинг для больших юридических документов
 * - Разбивает текст по абзацам (двойной перевод строки)
 * - Если абзац длинный, разбивает по предложениям с сохранением контекста (overlap)
 * - Учитывает сохранение логических блоков для избежания разрывов в середине предложений/пунктов
 *
 * @param {string} text - Исходный текст документа
 * @param {number} maxSize - Максимальный размер чанка в символах
 * @param {number} overlap - Кол-во символов перекрытия между чанками для лучшего контекста
 * @returns {string[]} - массив чанков
 */
function chunkText(text, maxSize = 1500, overlap = 200) {
    const chunks = [];
    const paragraphs = text.split(/\n\s*\n/); // Разбиваем на абзацы

    let currentChunk = "";

    for (const paragraph of paragraphs) {
        const trimmed = paragraph.trim();
        if (!trimmed) continue;

        // Если абзац больше maxSize - разбиваем на предложения
        if (trimmed.length > maxSize) {
            // Сначала добавляем текущий накопленный чанк, если он не пуст
            if (currentChunk) {
                chunks.push(currentChunk.trim());
                currentChunk = "";
            }
            // Разбиваем абзац на предложения
            const sentences = trimmed.match(/[^.!?]+[.!?]+(\s|$)/g) || [
                trimmed,
            ];
            for (const sentence of sentences) {
                if ((currentChunk + sentence).length > maxSize) {
                    if (currentChunk) {
                        chunks.push(currentChunk.trim());
                        // overlap - берем последние слова для контекста
                        const overlapWords = currentChunk
                            .split(" ")
                            .slice(-Math.floor(overlap / 5));
                        currentChunk = overlapWords.join(" ") + " " + sentence;
                    } else {
                        currentChunk = sentence;
                    }
                } else {
                    currentChunk += " " + sentence;
                }
            }
        } else {
            // Если добавление абзаца к текущему чанку превышает maxSize, создаем новый чанк
            if ((currentChunk + "\n\n" + trimmed).length > maxSize) {
                if (currentChunk) {
                    chunks.push(currentChunk.trim());
                    // overlap
                    const overlapWords = currentChunk
                        .split(" ")
                        .slice(-Math.floor(overlap / 5));
                    currentChunk = overlapWords.join(" ") + "\n\n" + trimmed;
                } else {
                    currentChunk = trimmed;
                }
            } else {
                currentChunk += (currentChunk ? "\n\n" : "") + trimmed;
            }
        }
    }

    if (currentChunk.trim()) {
        chunks.push(currentChunk.trim());
    }

    return chunks;
}

// ═══════════════════════════════════════════════════════════════
// 📦 РАБОТА С SUPABASE STORAGE
// ═══════════════════════════════════════════════════════════════

async function uploadToStorage(bucket, storagePath, buffer, contentType) {
    const { data, error } = await supabase.storage
        .from(bucket)
        .upload(storagePath, buffer, { contentType, upsert: false });
    if (error) throw error;
    return data.path;
}

async function downloadFromStorage(bucket, storagePath) {
    const { data, error } = await supabase.storage
        .from(bucket)
        .download(storagePath);
    if (error) throw error;
    return Buffer.from(await data.arrayBuffer());
}

async function deleteFromStorage(bucket, storagePath) {
    const { error } = await supabase.storage.from(bucket).remove([storagePath]);
    if (error) throw error;
}

// ═══════════════════════════════════════════════════════════════
// 🗄️ РАБОТА С БД
// ═══════════════════════════════════════════════════════════════

async function upsertDocument({ title, source, mime, sha256, storagePath }) {
    const { data, error } = await supabase
        .from("documents")
        .insert({ title, source, mime, sha256, storage_path: storagePath })
        .select("id")
        .single();
    if (error) throw error;
    return data.id;
}

async function insertChunks(rows) {
    const { error } = await supabase.from("chunks").insert(rows);
    if (error) throw error;
}

async function getDocuments(page = 1, perPage = 5) {
    const from = (page - 1) * perPage;
    const to = from + perPage - 1;

    const { data, error, count } = await supabase
        .from("documents")
        .select("id, title, created_at, mime", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);

    if (error) throw error;

    const totalPages = Math.max(1, Math.ceil((count || 0) / perPage));
    return {
        documents: data || [],
        totalPages,
        currentPage: page,
        total: count || 0,
    };
}

async function getDocumentInfo(docId) {
    const { data: doc, error: docError } = await supabase
        .from("documents")
        .select("*")
        .eq("id", docId)
        .single();

    if (docError) throw docError;

    const { count } = await supabase
        .from("chunks")
        .select("*", { count: "exact", head: true })
        .eq("document_id", docId);

    return { ...doc, chunksCount: count || 0 };
}

async function deleteDocument(docId) {
    const doc = await getDocumentInfo(docId);

    await supabase.from("chunks").delete().eq("document_id", docId);
    await supabase.from("documents").delete().eq("id", docId);

    if (doc.storage_path) {
        try {
            await deleteFromStorage("documents", doc.storage_path);
        } catch (err) {
            console.error("Ошибка удаления из Storage:", err);
        }
    }
}

async function renameDocument(docId, newTitle) {
    const { error } = await supabase
        .from("documents")
        .update({ title: newTitle })
        .eq("id", docId);
    if (error) throw error;
}

// ═══════════════════════════════════════════════════════════════
// 🤖 ВЕКТОРИЗАЦИЯ С RETRY И BATCHING
// ═══════════════════════════════════════════════════════════════

async function withRetry(
    fn,
    { retries = 6, baseMs = 600, factor = 2, jitter = true } = {}
) {
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
                err?.code === "3505" ||
                /rate.*limit|too.*many.*requests/i.test(err?.message || "");

            if (!is429 || attempt > retries) throw err;

            const delay = Math.min(
                15000,
                baseMs *
                    factor ** (attempt - 1) *
                    (jitter ? 0.8 + Math.random() * 0.4 : 1)
            );

            await new Promise((r) => setTimeout(r, delay));
        }
    }
}

async function embedTextsWithBackoff(
    texts,
    { initialBatch = 16, minBatch = 8 } = {}
) {
    let batch = initialBatch;
    const vectors = [];

    for (let i = 0; i < texts.length; ) {
        const slice = texts.slice(i, i + batch);

        try {
            const res = await withRetry(() =>
                mistral.embeddings.create({
                    model: "mistral-embed",
                    inputs: slice,
                })
            );

            vectors.push(...res.data.map((d) => d.embedding));
            i += batch;

            await new Promise((r) => setTimeout(r, 200));

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

// ═══════════════════════════════════════════════════════════════
// ⏳ ОЧЕРЕДЬ ОБРАБОТКИ ДОКУМЕНТОВ
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 📊 ПРОГРЕСС-БАР ЗАГРУЗКИ
// ═══════════════════════════════════════════════════════════════

const steps = [
    { text: "Загрузка файла...", pct: 10 },
    { text: "Сохранение в хранилище...", pct: 25 },
    { text: "Регистрация документа...", pct: 35 },
    { text: "Извлечение текста...", pct: 45 },
    { text: "Разбиение на логические части...", pct: 55 },
    { text: "Генерация векторов (может занять много времени)...", pct: 75 },
    { text: "Сохранение в базу данных...", pct: 100 },
];

async function updateProgress(ctx, msgId, idx, extra = "") {
    const s = steps[idx];
    await safeEditMessageText(
        ctx,
        ctx.chat.id,
        msgId,
        `${s.pct}% — ${s.text}${extra ? `\n${extra}` : ""}`,
        { reply_markup: adminBackButton() }
    );
}

// ═══════════════════════════════════════════════════════════════
// 🔄 MIDDLEWARE ДЛЯ ПЕРЕИМЕНОВАНИЯ
// ═══════════════════════════════════════════════════════════════

adminComposer.use(async (ctx, next) => {
    if (
        ctx.session?.isAdmin &&
        ctx.session?.renamingDocId &&
        ctx.message?.text
    ) {
        await handleRenameText(ctx);
    } else {
        await next(); // важно вызвать, иначе блокируется дальнейшая обработка
    }
});

async function handleRenameText(ctx) {
    const docId = ctx.session.renamingDocId;
    const newTitle = ctx.message.text.trim();
    const renamePromptMsgId = ctx.session.renamePromptMsgId;

    await ctx.deleteMessage();

    if (!newTitle || newTitle.length < 1 || newTitle.length > 255) {
        if (renamePromptMsgId) {
            try {
                await ctx.api.deleteMessage(ctx.chat.id, renamePromptMsgId);
            } catch (err) {
                console.error("Не удалось удалить запрос переименования:", err);
            }
        }

        ctx.session.renamingDocId = null;
        ctx.session.renamePromptMsgId = null;

        await ctx.reply("❌ Название должно быть от 1 до 255 символов.", {
            reply_markup: adminMainMenu(),
        });
        return;
    }

    try {
        await renameDocument(docId, newTitle);

        if (renamePromptMsgId) {
            try {
                await ctx.api.deleteMessage(ctx.chat.id, renamePromptMsgId);
            } catch (err) {
                console.error("Не удалось удалить запрос переименования:", err);
            }
        }

        ctx.session.renamingDocId = null;
        ctx.session.renamePromptMsgId = null;

        const doc = await getDocumentInfo(docId);
        const date = new Date(doc.created_at).toLocaleString("ru-RU");

        const info = [
            `✅ *Переименовано\\!*`,
            "",
            `📄 *${escapeMarkdown(doc.title)}*`,
            "",
            `📅 Загружен: ${date}`,
            `📦 Тип: ${doc.mime}`,
            `🔢 Векторов: ${doc.chunksCount}`,
        ].join("\n");

        await ctx.reply(info, {
            parse_mode: "Markdown",
            reply_markup: adminDocumentActions(docId),
        });
    } catch (err) {
        if (renamePromptMsgId) {
            try {
                await ctx.api.deleteMessage(ctx.chat.id, renamePromptMsgId);
            } catch (err) {
                console.error("Не удалось удалить запрос переименования:", err);
            }
        }

        ctx.session.renamingDocId = null;
        ctx.session.renamePromptMsgId = null;

        await ctx.reply(`❌ Ошибка: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// 🎯 КОМАНДЫ АДМИНКИ (на adminComposer)
// ═══════════════════════════════════════════════════════════════

adminComposer.command("admin", async (ctx) => {
    if (!ctx.session.isAdmin) {
        return await ctx.reply(
            "🔐 Для доступа к админ-панели необходимо авторизоваться.\n\n" +
                'Используйте кнопку "Админка" в главном меню.'
        );
    }

    await ctx.reply("⚙️ *Админ\\-панель*\n\nВыберите действие:", {
        parse_mode: "MarkdownV2",
        reply_markup: adminMainMenu(),
    });
});

adminComposer.callbackQuery(["admin_back", "admin_main_menu"], async (ctx) => {
    await ctx.editMessageText("⚙️ *Админ панель*\n\nВыберите действие:", {
        parse_mode: "Markdown",
        reply_markup: adminMainMenu(),
    });
    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery("admin_noop", async (ctx) => {
    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery("admin_upload", async (ctx) => {
    await ctx.editMessageText(
        "📤 *Загрузка документа*\n\n" +
            "Отправьте PDF или RTF документ.\n\n" +
            "Поддерживаемые форматы: PDF, RTF",
        {
            parse_mode: "Markdown",
            reply_markup: adminMainMenu(),
        }
    );
    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery("admin_documents", async (ctx) => {
    try {
        const { documents, totalPages, currentPage, total } =
            await getDocuments(1);

        if (documents.length === 0) {
            await ctx.editMessageText(
                "📄 *Документы*\n\nУ вас пока нет загруженных документов.",
                {
                    parse_mode: "Markdown",
                    reply_markup: adminMainMenu(),
                }
            );
        } else {
            await ctx.editMessageText(
                `📄 *Документы* (всего: ${total})\n\nВыберите документ:`,
                {
                    parse_mode: "Markdown",
                    reply_markup: adminDocumentsList(
                        currentPage,
                        totalPages,
                        documents
                    ),
                }
            );
        }
    } catch (err) {
        await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }

    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery(/^admin_docs_page_(\d+)$/, async (ctx) => {
    const page = parseInt(ctx.match[1]);

    try {
        const { documents, totalPages, currentPage, total } =
            await getDocuments(page);

        await safeEditMessageText(
            ctx,
            ctx.chat.id,
            ctx.callbackQuery.message.message_id,
            `📄 *Документы* (всего: ${total})\n\nВыберите документ:`,
            {
                parse_mode: "Markdown",
                reply_markup: adminDocumentsList(
                    currentPage,
                    totalPages,
                    documents
                ),
            }
        );
    } catch (err) {
        await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }

    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery(/^admin_doc_view_(\d+)$/, async (ctx) => {
    const docId = parseInt(ctx.match[1]);

    try {
        const doc = await getDocumentInfo(docId);
        const date = new Date(doc.created_at).toLocaleString("ru-RU");

        const info = [
            `📄 *${escapeMarkdown(doc.title)}*`,
            "",
            `📅 Загружен: ${date}`,
            `📦 Тип: ${doc.mime}`,
            `🔢 Векторов: ${doc.chunksCount}`,
        ].join("\n");

        const msg = ctx.callbackQuery?.message;
        if (msg?.document) {
            await ctx.deleteMessage();
            await ctx.reply(info, {
                parse_mode: "Markdown",
                reply_markup: adminDocumentActions(docId),
            });
        } else {
            await ctx.editMessageText(info, {
                parse_mode: "Markdown",
                reply_markup: adminDocumentActions(docId),
            });
        }
    } catch (err) {
        await ctx.reply(`❌ Ошибка: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }

    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery(/^admin_doc_download_(\d+)$/, async (ctx) => {
    const docId = parseInt(ctx.match[1]);

    try {
        await ctx.answerCallbackQuery({ text: "📥 Загружаю документ..." });

        const doc = await getDocumentInfo(docId);
        if (!doc.storage_path) {
            throw new Error("Файл не найден в хранилище");
        }

        const buffer = await downloadFromStorage("documents", doc.storage_path);

        await ctx.deleteMessage();

        await ctx.replyWithDocument(new InputFile(buffer, doc.title), {
            caption: `📄 ${doc.title}\n📅 ${new Date(
                doc.created_at
            ).toLocaleString("ru-RU")}`,
            reply_markup: adminBackToDocument(docId),
        });
    } catch (err) {
        await ctx.reply(`❌ Ошибка загрузки: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }
});

adminComposer.callbackQuery(/^admin_doc_del_confirm_(\d+)$/, async (ctx) => {
    const docId = parseInt(ctx.match[1]);

    try {
        const doc = await getDocumentInfo(docId);

        await ctx.editMessageText(
            `⚠️ Подтверждение удаления\n\n` +
                `Вы уверены?\n\n` +
                `Документ: "${doc.title}"\n` +
                `Векторов: ${doc.chunksCount}\n\n` +
                `Действие необратимо!`,
            { reply_markup: adminDeleteConfirm(docId) }
        );
    } catch (err) {
        await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }

    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery(/^admin_doc_delete_(\d+)$/, async (ctx) => {
    const docId = parseInt(ctx.match[1]);

    try {
        await ctx.editMessageText("🗑️ Удаление...", {});
        await deleteDocument(docId);

        await ctx.editMessageText("✅ Документ удалён!", {
            reply_markup: adminMainMenu(),
        });
    } catch (err) {
        await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }

    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery(/^admin_doc_rename_(\d+)$/, async (ctx) => {
    const docId = parseInt(ctx.match[1]);

    try {
        const doc = await getDocumentInfo(docId);
        ctx.session.renamingDocId = docId;

        const msg = await ctx.editMessageText(
            `✏️ *Переименование*\n\n` +
                `Текущее название:\n"${escapeMarkdown(doc.title)}"\n\n` +
                `Отправьте новое название:`,
            {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text(
                    "❌ Отмена",
                    `admin_doc_view_${docId}`
                ),
            }
        );

        ctx.session.renamePromptMsgId = msg.message_id;
    } catch (err) {
        await ctx.editMessageText(`❌ Ошибка: ${err.message}`, {
            reply_markup: adminMainMenu(),
        });
    }

    await ctx.answerCallbackQuery();
});

adminComposer.callbackQuery("admin_stats", async (ctx) => {
    const { count: docsCount } = await supabase
        .from("documents")
        .select("*", { count: "exact", head: true });

    const { count: chunksCount } = await supabase
        .from("chunks")
        .select("*", { count: "exact", head: true });

    await ctx.editMessageText(
        `📊 *Статистика*\n\n` +
            `📄 Документов: ${docsCount ?? 0}\n` +
            `🔢 Векторов: ${chunksCount ?? 0}`,
        {
            parse_mode: "Markdown",
            reply_markup: adminMainMenu(),
        }
    );

    await ctx.answerCallbackQuery();
});

// ═══════════════════════════════════════════════════════════════
// ✍️ ОБРАБОТКА ЗАГРУЗКИ ДОКУМЕНТОВ
// ═══════════════════════════════════════════════════════════════

adminComposer.on("message:document", async (ctx) => {
    if (!ctx.session.isAdmin) return;

    const doc = ctx.message.document;
    const allowedMimeTypes = ["application/pdf", "application/rtf", "text/rtf"];

    if (!allowedMimeTypes.includes(doc.mime_type)) {
        await ctx.reply(
            "❌ Неподдерживаемый формат.\n\nПоддерживаются: PDF, RTF",
            { reply_markup: adminMainMenu() }
        );
        return;
    }

    const progress = await ctx.reply("0% — Ожидание...", {
        reply_markup: adminBackButton(),
    });

    enqueueJob(async () => {
        let savedPath = null;

        try {
            await updateProgress(ctx, progress.message_id, 0);
            const file = await ctx.getFile();
            const tmpDir = path.join(process.cwd(), "tmp");
            await fs.mkdir(tmpDir, { recursive: true });
            savedPath = path.join(
                tmpDir,
                `${crypto.randomUUID()}_${doc.file_name}`
            );
            await file.download(savedPath);

            await updateProgress(ctx, progress.message_id, 1);
            const buffer = await fs.readFile(savedPath);
            const sha256 = crypto
                .createHash("sha256")
                .update(buffer)
                .digest("hex");
            const storagePath = sanitizeStoragePath(doc.file_name);
            await uploadToStorage(
                "documents",
                storagePath,
                buffer,
                doc.mime_type
            );

            await updateProgress(ctx, progress.message_id, 2);
            const documentId = await upsertDocument({
                title: doc.file_name,
                source: `telegram:${ctx.chat.id}`,
                mime: doc.mime_type,
                sha256,
                storagePath,
            });

            await updateProgress(ctx, progress.message_id, 3);
            const text = await extractText(savedPath);

            await updateProgress(ctx, progress.message_id, 4);
            const chunks = chunkText(text, 2000, 200);

            await updateProgress(
                ctx,
                progress.message_id,
                5,
                `Векторов: ${chunks.length}`
            );
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
                `✅ Загружено!\n\n📄 "${doc.file_name}"\n🔢 Векторов: ${rows.length}`,
                { reply_markup: adminMainMenu() }
            );
        } catch (err) {
            await safeEditMessageText(
                ctx,
                ctx.chat.id,
                progress.message_id,
                `❌ Ошибка\n\n${err.message}`,
                { reply_markup: adminMainMenu() }
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
            { reply_markup: adminMainMenu() }
        );
    });
});
