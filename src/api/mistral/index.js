import { Mistral } from '@mistralai/mistralai';
import dotenv from 'dotenv';

// Загружаем переменные окружения
dotenv.config();

// Проверяем что все переменные загрузились
const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY;
const AGENT_ID = process.env.MISTRAL_AGENT_ID;

if (!MISTRAL_API_KEY || !AGENT_ID) {
  throw new Error('Отсутствуют необходимые переменные окружения в .env файле');
}

const client = new Mistral({ apiKey: MISTRAL_API_KEY });

export async function answerQuestion(userQuestion, parsedText) {
  try {
    const prompt = `Документ:\n${parsedText}\n\nВопрос: ${userQuestion}`;
    
    const result = await client.agents.complete({
      agentId: AGENT_ID,  // Теперь точно будет определён
      messages: [{ role: 'user', content: prompt }]
    });
    
    return result.choices[0].message.content;
    
  } catch (error) {
    console.error('Mistral API error:', error);
    throw error;
  }
}
