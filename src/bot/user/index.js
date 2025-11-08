/**
 * 👤 ПОЛЬЗОВАТЕЛЬСКАЯ ЛОГИКА БОТА
 */

import fs from "fs";
import { InlineKeyboard, InputFile } from "grammy";
import { bot, supabase, mistral } from "../bot.js";
import { userComposer } from "../handlers.js";
import { processVoiceMessage } from "../../api/voice/index.js";

/* =======================
   📋 КОНСТАНТЫ
   ======================= */

const WELCOME_TEXT =
  "👋 *Добро пожаловать в бота по охране труда\\!*\n\n" +
  "🔍 *Поиск* — задайте вопрос по документам\n" +
  "📝 *Тестирование* — проверьте свои знания\n" +
  "⚙️ *Админка* — управление документами";

/* =======================
   📋 КЛАВИАТУРЫ
   ======================= */

function userMainMenu() {
  return new InlineKeyboard()
    .text("🔍 Поиск", "user_search")
    .row()
    .text("📝 Тестирование", "user_test")
    .row()
    .text("⚙️ Админка", "user_admin");
}

function testAnswersKeyboard() {
  return new InlineKeyboard()
    .text("1️⃣", "user_answer_0")
    .row()
    .text("2️⃣", "user_answer_1")
    .row()
    .text("3️⃣", "user_answer_2")
    .row()
    .text("4️⃣", "user_answer_3");
}

function backToMainMenu() {
  return new InlineKeyboard().text("🏠 Главное меню", "user_main_menu");
}

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

/* =======================
   🔧 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
   ======================= */

function resetUserState(session) {
  session.command = null;
  session.isAdmin = false;
  session.adminPromptMsgId = null;
}

async function deleteAdminPrompt(ctx) {
  const promptMsgId = ctx.session.adminPromptMsgId;
  if (promptMsgId) {
    try {
      await ctx.api.deleteMessage(ctx.chat.id, promptMsgId);
    } catch (err) {
      console.error("Не удалось удалить запрос пароля:", err);
    }
    ctx.session.adminPromptMsgId = null;
  }
}

function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

function getScoreText(score) {
  if (score === 5) return "— отличный результат\\!";
  if (score >= 4) return "— хорошо\\!";
  if (score >= 3) return "— неплохо\\, но есть к чему стремиться\\.";
  return "— рекомендуем повторить материал\\.";
}

// Экранируем Markdown (включая распознанный текст и названия файлов)
function escapeMd(text = "") {
  return String(text).replace(/([_*\[\]()~`>#+=|{}.!-])/g, "\\$1");
}

/**
 * Задержка выполнения
 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry-логика с экспоненциальной задержкой для обработки 429 ошибок
 */
async function retryWithBackoff(fn, maxRetries = 5) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      const is429 =
        error?.status === 429 ||
        error?.response?.status === 429 ||
        error?.message?.includes("429") ||
        error?.message?.includes("rate limit");
      if (is429 && attempt < maxRetries - 1) {
        const waitTime = Math.pow(2, attempt) * 1000;
        console.log(
          `Rate limit hit. Retry ${attempt + 1}/${maxRetries}. Waiting ${waitTime}ms...`
        );
        await delay(waitTime);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Получить информацию о документе по ID
 */
async function getDocumentInfo(docId) {
  const { data: doc, error } = await supabase
    .from("documents")
    .select("*")
    .eq("id", docId)
    .single();
  if (error) throw error;
  return doc;
}

/**
 * Поиск с возвратом ответа, источника и вероятности
 */
async function performSearch(query) {
  try {
    const embeddingRes = await retryWithBackoff(async () => {
      return await mistral.embeddings.create({
        model: "mistral-embed",
        inputs: [query],
      });
    });

    const queryEmbedding = embeddingRes.data[0].embedding;
    const queryEmbeddingArray = Array.isArray(queryEmbedding)
      ? queryEmbedding
      : Array.from(queryEmbedding);

    await delay(400);

    const { data: chunks, error } = await supabase.rpc("match_chunks", {
      query_embedding: queryEmbeddingArray,
      match_threshold: 0.2,
      match_count: 5,
    });

    if (error) throw error;
    if (!chunks || chunks.length === 0) {
      return {
        answer:
          "Извините, не нашёл информации по вашему запросу. Попробуйте переформулировать вопрос.",
        source: null,
        probability: null,
      };
    }

    const topChunk = chunks[0];
    const context = chunks.map((c) => c.text).join("\n\n");

    await delay(400);

    const chatRes = await retryWithBackoff(async () => {
      return await mistral.chat.complete({
        model: "mistral-small-latest",
        messages: [
          {
            role: "system",
            content:
              "Ты эксперт по охране труда. Отвечай на вопросы только на основе информации из предоставленного контекста." +
              "Ответ должен быть кратким, точным и по делу, на русском языке." +
              'Если в контексте нет ответа на вопрос, скажи: "Извините, не нашёл информации по вашему запросу. Попробуйте переформулировать вопрос.".',
          },
          {
            role: "user",
            content: `Контекст:\n${context}\n\nВопрос: ${query}`,
          },
        ],
      });
    });

    return {
      answer: chatRes.choices[0].message.content,
      source: topChunk.document_id,
      probability: topChunk.similarity || topChunk.similarity_probability || null,
    };
  } catch (err) {
    console.error("Ошибка поиска:", err);
    if (
      err?.status === 429 ||
      err?.message?.includes("429") ||
      err?.message?.includes("rate limit")
    ) {
      return {
        answer:
          "⚠️ Превышен лимит запросов к API. Пожалуйста, подождите минуту и попробуйте снова.",
        source: null,
        probability: null,
      };
    }
    return {
      answer: "Произошла ошибка при поиске. Попробуйте позже.",
      source: null,
      probability: null,
    };
  }
}

/* =======================
   🎯 КОМАНДЫ И ОБРАБОТЧИКИ
   ======================= */

userComposer.command("start", async (ctx) => {
  ctx.session.command = null;
  await ctx.reply(WELCOME_TEXT, {
    parse_mode: "MarkdownV2",
    reply_markup: userMainMenu(),
  });
});

userComposer.callbackQuery("user_main_menu", async (ctx) => {
  // 1) Сразу убираем «крутилку»
  await ctx.answerCallbackQuery();

  // 2) Сбрасываем состояние
  resetUserState(ctx.session);

  try {
    const msg = ctx.callbackQuery?.message;
    // Если это документ/медиа/сообщение с caption — удаляем и шлём новое меню
    if (msg?.document || msg?.photo || typeof msg?.caption === "string") {
      try {
        await ctx.deleteMessage();
      } catch (_) {}
      await ctx.reply(WELCOME_TEXT, {
        parse_mode: "MarkdownV2",
        reply_markup: userMainMenu(),
      });
      return;
    }

    // Иначе пробуем отредактировать текст
    await ctx.editMessageText(WELCOME_TEXT, {
      parse_mode: "MarkdownV2",
      reply_markup: userMainMenu(),
    });
  } catch (err) {
    // Фолбэк: просто отправить новое меню
    await ctx.reply(WELCOME_TEXT, {
      parse_mode: "MarkdownV2",
      reply_markup: userMainMenu(),
    });
  }
});


userComposer.callbackQuery("user_search", async (ctx) => {
  ctx.session.command = "search";
  await ctx.editMessageText(
    "🔍 *Режим поиска*\n\n" +
      "Задайте ваш вопрос текстом или голосом, " +
      "и я найду ответ в базе документов по охране труда.",
    {
      parse_mode: "Markdown",
      reply_markup: backToMainMenu(),
    }
  );
  await ctx.answerCallbackQuery();
});

userComposer.callbackQuery("user_admin", async (ctx) => {
  ctx.session.command = "admin";
  const msg = await ctx.editMessageText(
    "🔐 *Вход в админ\\-панель*\n\n" + "Введите пароль администратора:",
    {
      parse_mode: "MarkdownV2",
      reply_markup: backToMainMenu(),
    }
  );
  ctx.session.adminPromptMsgId = msg.message_id;
  await ctx.answerCallbackQuery();
});

userComposer.callbackQuery("user_test", async (ctx) => {
  ctx.session.command = "test";
  const tests = JSON.parse(fs.readFileSync("./data/test.json", "utf-8"));
  const firstQuestion = getRandomElement(tests);

  ctx.session.questions = [firstQuestion.id];
  ctx.session.correctAnswers = [];

  await ctx.editMessageText(
    `📝 *Вопрос №1 из 5*\n\n${firstQuestion.title}\n\n` +
      firstQuestion.answers.map((a, i) => `${i + 1}️⃣ ${a}`).join("\n\n"),
    {
      parse_mode: "Markdown",
      reply_markup: testAnswersKeyboard(),
    }
  );
  await ctx.answerCallbackQuery();
});

userComposer.callbackQuery(/^user_answer_(\d)$/, async (ctx) => {
  const userAnswer = parseInt(ctx.match[1]);
  const tests = JSON.parse(fs.readFileSync("./data/test.json", "utf-8"));
  const currentQuestion = tests.find(
    (q) => q.id === ctx.session.questions[ctx.session.questions.length - 1]
  );

  const isCorrect = currentQuestion.answers[userAnswer]?.includes(
    currentQuestion.correctAnswer
  );

  if (isCorrect) {
    ctx.session.correctAnswers.push(currentQuestion.id);
  }

  if (ctx.session.questions.length === 5) {
    ctx.session.command = null;
    const score = ctx.session.correctAnswers.length;
    const emoji = score >= 4 ? "🎉" : score >= 3 ? "👍" : "📚";

    await ctx.editMessageText(
      `${emoji} *Тест завершён\\!*\n\n` +
        `Ваш результат: *${score}/5* ${getScoreText(score)}`,
      {
        parse_mode: "MarkdownV2",
        reply_markup: userMainMenu(),
      }
    );
    return await ctx.answerCallbackQuery();
  }

  const nextQuestion = getRandomElement(tests);
  ctx.session.questions.push(nextQuestion.id);
  const questionNum = ctx.session.questions.length;

  await ctx.editMessageText(
    `📝 *Вопрос №${questionNum} из 5*\n\n${nextQuestion.title}\n\n` +
      nextQuestion.answers.map((a, i) => `${i + 1}️⃣ ${a}`).join("\n\n"),
    {
      parse_mode: "Markdown",
      reply_markup: testAnswersKeyboard(),
    }
  );
  await ctx.answerCallbackQuery();
});

userComposer.on("message:text", async (ctx) => {
  if (ctx.session.command === "search") {
    await ctx.replyWithChatAction("typing");

    const { answer, source, probability } = await performSearch(
      ctx.message.text
    );

    let answerText = `🤖 *Результат поиска:*\n\n${escapeMd(answer)}`;

    const keyboard = new InlineKeyboard();

    if (source) {
      const { data: doc, error } = await supabase
        .from("documents")
        .select("title")
        .eq("id", source)
        .single();

      const probPerc = probability ? (probability * 100).toFixed(1) : "нет данных";

      if (!error && doc?.title) {
        answerText += `\n\n📄 Источник: *${escapeMd(doc.title)}*\n🔎 Совпадение: ${probPerc}%`;
      } else {
        answerText += `\n\n📄 Источник: *неизвестен*\n🔎 Совпадение: ${probPerc}%`;
      }

      keyboard.text("📥 Скачать документ-источник", `user_download_doc_${String(source)}`).row();
    }

    keyboard.text("🏠 Главное меню", "user_main_menu");

    await ctx.reply(answerText, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });

    return;
  }

  if (ctx.session.command === "admin") {
    await ctx.deleteMessage();
    const isCorrectPassword = ctx.message.text === process.env.ADMIN_PASSWORD;
    await deleteAdminPrompt(ctx);

    if (isCorrectPassword) {
      ctx.session.isAdmin = true;
      ctx.session.command = null;

      await ctx.reply("⚙️ *Админ\\-панель*\n\nВыберите действие:", {
        parse_mode: "MarkdownV2",
        reply_markup: adminMainMenu(),
      });
    } else {
      await ctx.reply("❌ Неправильный пароль\\.", {
        parse_mode: "MarkdownV2",
        reply_markup: backToMainMenu(),
      });
    }
  }
});

userComposer.on("message:voice", async (ctx) => {
  if (ctx.session.command !== "search") {
    await ctx.reply(
      "Сначала активируйте режим поиска через команду /start",
      { reply_markup: backToMainMenu() }
    );
    return;
  }

  try {
    await ctx.replyWithChatAction("typing");

    // 1) Распознаём голос
    const voiceFile = ctx.message.voice;
    const transcribedText = await processVoiceMessage(voiceFile, bot);

    // 2) Поиск
    const { answer, source, probability } = await performSearch(transcribedText);

    // 3) Текст ответа
    let answerText =
      `🎙 *Ваш вопрос:*\n${escapeMd(transcribedText)}\n\n` +
      `🤖 *Результат поиска:*\n${escapeMd(answer)}`;

    // 4) Кнопки
    const keyboard = new InlineKeyboard();

    if (source) {
      // Подтягиваем название файла источника
      const { data: doc, error } = await supabase
        .from("documents")
        .select("title")
        .eq("id", source)
        .single();

      const probPerc = probability ? (probability * 100).toFixed(1) : "нет данных";

      if (!error && doc?.title) {
        answerText += `\n\n📄 Источник: *${escapeMd(doc.title)}*\n🔎 Совпадение: ${probPerc}%`;
      } else {
        answerText += `\n\n📄 Источник: *неизвестен*\n🔎 Совпадение: ${probPerc}%`;
      }

      // Единый callback, как и в текстовом режиме
      keyboard.text("📥 Скачать документ-источник", `user_download_doc_${String(source)}`).row();
    }

    keyboard.text("🏠 Главное меню", "user_main_menu");

    // 5) Итоговый ответ
    await ctx.reply(answerText, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (err) {
    console.error("Ошибка обработки голосового сообщения:", err);
    await ctx.reply(
      "Произошла ошибка при обработке голосового сообщения. Попробуйте ещё раз или введите /start для возврата в меню.",
      { reply_markup: backToMainMenu() }
    );
  }
});

// ЕДИНЫЙ обработчик скачивания для обоих режимов
userComposer.callbackQuery(/^user_download_doc_(\d+)$/, async (ctx) => {
  const docId = parseInt(ctx.match[1], 10);

  // Сразу подтвердим коллбэк, чтобы убрать «крутилку»
  await ctx.answerCallbackQuery({ text: "📥 Загружаю документ..." });

  try {
    // 1) Удаляем исходное сообщение с ответом ИИ (лаконично)
    try {
      await ctx.deleteMessage();
    } catch (_) {}

    // 2) Достаём файл
    const { data: doc, error } = await supabase
      .from("documents")
      .select("title, storage_path, created_at")
      .eq("id", docId)
      .single();
    if (error || !doc || !doc.storage_path) {
      throw new Error("Документ не найден");
    }

    // 3) Пытаемся отправить через Buffer (как у тебя работало)
    try {
      const { data: fileData, error: downloadErr } = await supabase.storage
        .from("documents")
        .download(doc.storage_path);
      if (downloadErr) throw downloadErr;

      const buffer = Buffer.from(await fileData.arrayBuffer());

      await ctx.replyWithDocument(
        new InputFile(buffer, doc.title || "document"),
        {
          caption: `📄 ${escapeMd(doc.title || "Документ")}\n📅 ${new Date(
            doc.created_at
          ).toLocaleString("ru-RU")}`,
          parse_mode: "Markdown",
          reply_markup: backToMainMenu(),
        }
      );
      return;
    } catch (sendErr) {
      // 4) Fallback на подписанную ссылку — Telegram сам скачает и пришлёт файл
      const is413 =
        sendErr?.error_code === 413 ||
        /entity too large|request entity too large|413/i.test(
          sendErr?.description || ""
        );
      if (!is413) throw sendErr;

      const { data: signed, error: signErr } = await supabase.storage
        .from("documents")
        .createSignedUrl(doc.storage_path, 60 * 60, { download: true });
      if (signErr) throw signErr;

      await ctx.replyWithDocument(
        { url: signed.signedUrl, filename: doc.title || "document" },
        {
          caption: `📄 ${escapeMd(doc.title || "Документ")}\n⏳ Ссылка действует 1 час`,
          parse_mode: "Markdown",
          reply_markup: backToMainMenu(),
        }
      );
      return;
    }
  } catch (err) {
    console.error("Ошибка скачивания документа:", err);
    await ctx.reply("❌ Ошибка при скачивании документа", {
      reply_markup: backToMainMenu(),
    });
  }
});
