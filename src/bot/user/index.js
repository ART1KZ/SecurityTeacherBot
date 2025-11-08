/**
 * 👤 ПОЛЬЗОВАТЕЛЬСКАЯ ЛОГИКА БОТА
 */

import fs from "fs";
import { InlineKeyboard } from "grammy";
import { bot, supabase, mistral } from "../bot.js";
import { userComposer } from "../handlers.js";

// ═══════════════════════════════════════════════════════════════
// 📋 КОНСТАНТЫ
// ═══════════════════════════════════════════════════════════════

const WELCOME_TEXT =
    "👋 *Добро пожаловать в бота по охране труда\\!*\n\n" +
    "🔍 *Поиск* — задайте вопрос по документам\n" +
    "📝 *Тестирование* — проверьте свои знания\n" +
    "⚙️ *Админка* — управление документами";

// ═══════════════════════════════════════════════════════════════
// 📋 КЛАВИАТУРЫ
// ═══════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════
// 🔧 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ═══════════════════════════════════════════════════════════════

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

async function performSearch(query) {
    try {
        const embeddingRes = await mistral.embeddings.create({
            model: "mistral-embed",
            inputs: [query],
        });
        const queryEmbedding = embeddingRes.data[0].embedding;

        const queryEmbeddingArray = Array.isArray(queryEmbedding)
            ? queryEmbedding
            : Array.from(queryEmbedding);


        // Use a slightly lower threshold by default to avoid missing matches; keep match_count small
        const { data: chunks, error } = await supabase.rpc("match_chunks", {
            query_embedding: queryEmbeddingArray,
            match_threshold: 0.2,
            match_count: 5,
        });

        if (error) throw error;
        if (!chunks || chunks.length === 0) {
            return "Извините, не нашёл информации по вашему запросу. Попробуйте переформулировать вопрос.";
        }

        const context = chunks.map((c) => c.text).join("\n\n");

        const chatRes = await mistral.chat.complete({
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

        return chatRes.choices[0].message.content;
    } catch (err) {
        console.error("Ошибка поиска:", err);
        return "Произошла ошибка при поиске. Попробуйте позже.";
    }
}

// ═══════════════════════════════════════════════════════════════
// 🎯 КОМАНДЫ И ОБРАБОТЧИКИ
// ═══════════════════════════════════════════════════════════════

userComposer.command("start", async (ctx) => {
    ctx.session.command = null;
    await ctx.reply(WELCOME_TEXT, {
        parse_mode: "MarkdownV2",
        reply_markup: userMainMenu(),
    });
});

userComposer.callbackQuery("user_main_menu", async (ctx) => {
    resetUserState(ctx.session);
    await ctx.editMessageText(WELCOME_TEXT, {
        parse_mode: "MarkdownV2",
        reply_markup: userMainMenu(),
    });
    await ctx.answerCallbackQuery();
});

userComposer.callbackQuery("user_search", async (ctx) => {
    ctx.session.command = "search";
    await ctx.editMessageText(
        "🔍 *Режим поиска*\n\n" +
            "Задайте ваш вопрос текстом, " +
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
    // Режим поиска
    if (ctx.session.command === "search") {
        const answer = await performSearch(ctx.message.text);
        await ctx.reply(`🔍 *Результат поиска:*\n\n${answer}`, {
            parse_mode: "Markdown",
            reply_markup: backToMainMenu(),
        });
        return;
    }

    // Ввод пароля админки
    if (ctx.session.command === "admin") {
        await ctx.deleteMessage();
        const isCorrectPassword =
            ctx.message.text === process.env.ADMIN_PASSWORD;
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

    console.log("Обработчик завершён");
});
