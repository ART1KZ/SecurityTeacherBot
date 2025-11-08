import {Bot, session} from 'grammy';
require('dotenv').config()

const bot = new Bot(process.env.BOT_TOKEN);

bot.start()
console.log("Bot started")

export {bot}