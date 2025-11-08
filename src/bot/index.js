import {bot} from './index.js'
import { createClient } from '@supabase/supabase-js'

// Create a single supabase client for interacting with your database
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

function initialSessionData() {
  return { command: null };
}

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

async function search(ctx) {
    let data = ''
    if (ctx.message.text || ctx.update.message.text) {
        const message = ctx.message.text || ctx.update.message.text;
        const response = await asd // mistral method
        data = response.text
    }
    return data;
}

async function admin(ctx) {
    
}

export { search, admin }