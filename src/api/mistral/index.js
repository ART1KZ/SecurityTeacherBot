import { Mistral } from '@mistralai/mistralai';

// Инициализация клиента Mistral AI
const client = new Mistral({
  apiKey: process.env.MISTRAL_API_KEY
});

//serQuestion - Вопрос пользователя (текст или распознанная речь)
//parsedText - Текст документа для поиска ответа
export async function answerQuestion(userQuestion, parsedText) {
  // Формируем промпт для агента
  const prompt = `Документ:\n${parsedText}\n\nВопрос: ${userQuestion}`;
  
  // Отправляем запрос в Mistral AI Agent
  const result = await client.agents.complete({
    agentId: process.env.MISTRAL_AGENT_ID,
    messages: [{ role: 'user', content: prompt }]
  });
  
  // Возвращаем ответ агента
  return result.choices[0].message.content;
}