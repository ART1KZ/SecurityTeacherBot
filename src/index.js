import './bot/handlers.js';    
import './bot/admin/index.js';  
import './bot/user/index.js';  
import { bot } from './bot/bot.js';

bot.start();
console.log('🤖 Бот запущен');
