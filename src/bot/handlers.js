/**
 * 🎯 ЦЕНТРАЛЬНЫЙ РЕГИСТРАТОР ОБРАБОТЧИКОВ
 *
 * Правильная архитектура: используем Composer для создания
 * изолированных деревьев middleware с явным next() для передачи
 * управления между обработчиками.
 */

import { Composer } from "grammy";
import { bot } from "./bot.js";

// Создаём отдельные Composer'ы для каждой логики
const adminComposer = new Composer();
const userComposer = new Composer();

// ═══════════════════════════════════════════════════════════════
// РЕГИСТРАЦИЯ MIDDLEWARE В ПРАВИЛЬНОМ ПОРЯДКЕ
// ═══════════════════════════════════════════════════════════════

// 1. Сначала админ-логика (с явным next() если не обработана)
bot.use(adminComposer);

// 2. Затем пользовательская логика
bot.use(userComposer);

export { adminComposer, userComposer };
