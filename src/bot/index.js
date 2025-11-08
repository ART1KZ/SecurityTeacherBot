import {Bot, session} from 'grammy'
import { createClient } from '@supabase/supabase-js'
import fs from 'fs'
import 'dotenv/config'

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)
const bot = new Bot(process.env.BOT_TOKEN);

function initialSessionData() {
  return { command: null, questions: [], correctAnswers: [] };
}

bot.use(session({ initial: initialSessionData }));

bot.command("start", async ctx => {

    ctx.session.command = null

    await ctx.reply('Добро пожаловать в бота по охране труда!', {
        reply_markup: {
            inline_keyboard: [
                [{text: 'Поиск', callback_data: 'search'}],
                [{text: 'Тестирование', callback_data: 'test'}],
                [{text: 'Админка', callback_data: 'admin'}]
            ]
        }
    })
})

bot.callbackQuery('test', async (ctx) => {
    ctx.session.command = 'test';
    const test = JSON.parse(fs.readFileSync('./data/test.json'))
    const question = getRandomElement(test)

    ctx.session.questions = []
    ctx.session.correctAnswers = []
    ctx.session.questions.push(question.id)

    await ctx.editMessageText('Вопрос №1: ' + question.title + '\n\n\n' + question.answers.join(`\n\n`), {
        reply_markup: {
            inline_keyboard: [
                [{text: '1️⃣', callback_data: 'answer0'}],
                [{text: '2️⃣', callback_data: 'answer1'}],
                [{text: '3️⃣', callback_data: 'answer2'}],
                [{text: '4️⃣', callback_data: 'answer3'}],
            ], 
        },
        parse_mode: 'HTML'
    });
})

bot.callbackQuery(/answer[0-9]/gi, async ctx => {
    const userAnswer = Number(ctx.callbackQuery.data.replace('answer', ''));
    const test = JSON.parse(fs.readFileSync('./data/test.json'));
    const question = test.find(q => q.id === ctx.session.questions[ctx.session.questions.length - 1]);

    const newQuestion = getRandomElement(test)
    ctx.session.questions.push(newQuestion.id)

    console.log(question.correctAnswer, question.answers[userAnswer])

    if (question.answers[userAnswer].includes(question.correctAnswer)) {

        ctx.session.correctAnswers.push(question.id)

        if (ctx.session.questions.length === 5) {
            ctx.session.command = null
            
            return await ctx.editMessageText('Тест завершен!\n\nВаш результат: ' + ctx.session.correctAnswers.length + '/5 решено правильно', {
                reply_markup: {
                    inline_keyboard: [
                        [{text: 'Поиск', callback_data: 'search'}],
                        [{text: 'Тестирование', callback_data: 'test'}],
                        [{text: 'Админка', callback_data: 'admin'}]
                    ]
                }
            });

        }

        await ctx.editMessageText('Правильно!\nВопрос №' + ctx.session.questions.length + ': ' + newQuestion.title + '\n\n\n' + newQuestion.answers.join(`\n\n`), {
            reply_markup: {
                inline_keyboard: [
                    [{text: "1️⃣", callback_data: 'answer0'}],
                    [{text: "2️⃣", callback_data: 'answer1'}],
                    [{text: "3️⃣", callback_data: 'answer2'}],
                    [{text: "4️⃣", callback_data: 'answer3'}],
                ]
            }
        });
    } else {

        if (ctx.session.questions.length === 5) {
            ctx.session.command = null
            
            return await ctx.editMessageText('Тест завершен!\n\nВаш результат: ' + ctx.session.correctAnswers.length + '/5 решено правильно', {
                reply_markup: {
                    inline_keyboard: [
                        [{text: 'Поиск', callback_data: 'search'}],
                        [{text: 'Тестирование', callback_data: 'test'}],
                        [{text: 'Админка', callback_data: 'admin'}]
                    ]
                }
            });
        }

        await ctx.editMessageText('Неправильно!\nВопрос №' + ctx.session.questions.length + ': ' + newQuestion.title + '\n\n\n' + newQuestion.answers.join(`\n\n`), {
            reply_markup: {
                inline_keyboard: [
                    [{text: "1️⃣", callback_data: 'answer0'}],
                    [{text: "2️⃣", callback_data: 'answer1'}],
                    [{text: "3️⃣", callback_data: 'answer2'}],
                    [{text: "4️⃣", callback_data: 'answer3'}],
                ]
            },
            parse_mode: 'HTML'
        });
    }

})

bot.callbackQuery('search', async (ctx) => {
    ctx.session.command = 'search';
    await ctx.editMessageText('Введите запрос или запишите голосовое сообщение');
});

bot.callbackQuery('admin', async (ctx) => {
    ctx.session.command = 'admin';
    await ctx.editMessageText('Введите пароль');
});

bot.on('message:text', async ctx => {
    if (ctx.session.command === 'search') {
        const data = await search(ctx);
        await ctx.reply(data)
    } else if (ctx.session.command === 'admin') {
        ctx.deleteMessage();
        if (ctx.message.text === process.env.PASSWORD) {
            await ctx.reply('Вы авторизовались как администратор.', {
                reply_markup: {
                    inline_keyboard: [
                        [{text: 'Загрузить документ', callback_data: 'upload'}],
                    ]
                }
            })
        } else {
            await ctx.reply('Неправильный пароль.')
        }
    }
})

async function search(ctx) {
    let data = ''
    if (ctx.message.text || ctx.update.message.text) {
        const message = ctx.message.text || ctx.update.message.text;
        const response = await asd // mistral method
        data = response.text
    }
    return data;
}

function getRandomElement(array) {
  return array[Math.floor(Math.random() * array.length)];
}

export {bot}