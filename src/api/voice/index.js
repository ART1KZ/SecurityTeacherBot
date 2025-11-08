import { AssemblyAI } from 'assemblyai';
import dotenv from 'dotenv';

// Загружаем переменные окружения
dotenv.config();

// Проверка API ключа
if (!process.env.ASSEMBLYAI_API_KEY) {
  throw new Error('❌ ASSEMBLYAI_API_KEY не найден в .env файле!');
}

// Инициализация клиента
const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY
});

/**
 * Конвертирует голосовое сообщение (OGG) в текст
 * @param {string} audioFilePath - Путь к OGG файлу
 * @returns {Promise<string>} Распознанный текст
 */
export async function voiceToText(audioFilePath) {
  try {
    // Отправляем файл на транскрипцию
    const transcript = await client.transcripts.transcribe({
      audio: audioFilePath,
      language_code: 'ru',
      punctuate: true,
      format_text: true
    });
    
    // Проверяем статус
    if (transcript.status === 'error') {
      throw new Error(`Транскрипция ошибка: ${transcript.error}`);
    }
    
    // Проверка что текст не пустой
    if (!transcript.text || transcript.text.trim() === '') {
      throw new Error('Не удалось распознать речь в аудио');
    }
    
    return transcript.text;
    
  } catch (error) {
    console.error('AssemblyAI error:', error);
    throw new Error(`Ошибка распознавания речи: ${error.message}`);
  }
}

/**
 * Конвертирует голосовое сообщение с дополнительными опциями
 * @param {string} audioFilePath - Путь к OGG файлу
 * @param {Object} options - Дополнительные настройки
 * @returns {Promise<Object>} Объект с текстом и метаданными
 */
export async function voiceToTextAdvanced(audioFilePath, options = {}) {
  try {
    const transcript = await client.transcripts.transcribe({
      audio: audioFilePath,
      language_code: options.language || 'ru',
      punctuate: true,
      format_text: true,
      speaker_labels: options.speakerLabels || false,
      filter_profanity: options.filterProfanity || false
    });
    
    return {
      text: transcript.text,
      confidence: transcript.confidence,
      duration: transcript.audio_duration,
      words: transcript.words
    };
    
  } catch (error) {
    console.error('AssemblyAI error:', error);
    throw error;
  }
}