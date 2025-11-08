import { AssemblyAI } from 'assemblyai';
import fs from 'fs'; // fs - предоставляет API для взаимодействия с файловой системой
import path from 'path'; // path - предоставляет утилиты для работы с путями к файлам и каталогам
import { fileURLToPath } from 'url'; // декодирует URL-адрес файла в строку пути

// Настройка путей
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const TEMP_DIR = path.join(PROJECT_ROOT, 'temp');

// Автоматическое создание папки temp/ при первом запуске
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

// Инициализация клиента AssemblyAI
const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY
});

/**
 * Скачивает голосовое сообщение из Telegram во временную папку
 */
async function downloadVoiceToTemp(voiceFile, bot) {
  // Получаем информацию о файле через Telegram Bot API
  const file = await bot.api.getFile(voiceFile.file_id);
  
  // Формируем уникальное имя файла с временной меткой
  const fileName = `voice_${Date.now()}_${voiceFile.file_id}.ogg`;
  const filePath = path.join(TEMP_DIR, fileName);
  
  // Скачиваем файл с серверов Telegram
  const fileUrl = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const response = await fetch(fileUrl);
  const buffer = await response.arrayBuffer();
  
  // Сохраняем в temp/
  fs.writeFileSync(filePath, Buffer.from(buffer));
  
  return filePath;
}

/**
 * Распознаёт речь из аудио файла через AssemblyAI
 */
async function voiceToText(audioFilePath) {
  // Отправляем файл в AssemblyAI для транскрипции
  const transcript = await client.transcripts.transcribe({
    audio: audioFilePath,
    language_code: 'ru',
    punctuate: true,
    format_text: true
  });
  
  // Проверяем статус транскрипции
  if (transcript.status === 'error') {
    throw new Error(`Ошибка AssemblyAI: ${transcript.error}`);
  }
  
  return transcript.text;
}

/**
 * Удаляет временный файл после обработки
 */
function deleteFile(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Обработка голосового сообщения
 */
export async function processVoiceMessage(voiceFile, bot) {
  let tempFilePath;
  
  try {
    // Скачиваем голосовое сообщение
    tempFilePath = await downloadVoiceToTemp(voiceFile, bot);
    
    // Распознаём речь
    const transcribedText = await voiceToText(tempFilePath);
    
    return transcribedText;
    
  } finally {
    // Всегда удаляем временный файл (даже если была ошибка)
    if (tempFilePath) {
      deleteFile(tempFilePath);
    }
  }
}