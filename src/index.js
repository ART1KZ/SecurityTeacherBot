import {Bot, session} from 'grammy';
require('dotenv').config()
const { search } = require('./bot.index.js');

const bot = new Bot(process.env.BOT_TOKEN);

function initialSessionData() {
  return { command: null };
}

// Подключаем middleware сессии
bot.use(session({ initial: initialSessionData }));

bot.command("start", async ctx => {
    await ctx.reply('Добро пожаловать в бота по охране труда!', {
        reply_markup: {
            inline_keyboard: [
                [{text: 'Поиск', callback_data: 'search'}],
                [{text: 'Админка', callback_data: 'admin'}]
            ]
        }
    })
})

bot.callbackQuery('search', async (ctx) => {
    ctx.session.command = 'search';
    await ctx.reply('Введите запрос или запишите голосовое сообщение');
});

bot.callbackQuery('admin', async (ctx) => {
    ctx.session.command = 'admin';
    await ctx.reply('Введите пароль');
});

bot.on('message:text', async ctx => {
    if (ctx.session.command === 'search') {
        const data = await search(ctx);
        await ctx.reply(data)
    } else if (ctx.session.command === 'admin') {
        await admin(ctx);
    }
})
    if (ctx.message.text === '1234') {
        await ctx.reply('Вы авторизовались как администратор', {
            reply_markup: {
                inline_keyboard: [
                    [{text: 'Загрузить файл', callback_data: 'upload'}]
                ]
            }
        });
    } else {
        await ctx.reply('Неверный пароль');
    }
})

bot.start()
console.log("Bot started")