import './bot/handlers.js';    
import './bot/admin/index.js';  
import './bot/user/index.js';  
import { bot } from './bot/bot.js';

bot.start();
bot.catch(error => console.error(error))

console.log('🤖 Бот запущен');
