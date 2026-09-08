export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/telegram-webhook') {
      const update = await request.json();
      const chatId = update.message?.chat?.id || update.callback_query?.message?.chat?.id || update.callback_query?.from?.id;
      
      const token = env.TELEGRAM_BOT_TOKEN;
      console.log("🔥 TEST RUNNING! Token exists:", !!token, "Chat ID:", chatId);
      
      if (!token) {
        console.error("❌ TELEGRAM_BOT_TOKEN IS MISSING IN SETTINGS!");
        return new Response("OK");
      }
      
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: '🔥 TEST SUCCESS! Bot is alive and token is working.' })
      });
      
      console.log("Telegram API Status:", res.status, await res.text());
      return new Response('OK');
    }
    return new Response('Not found', { status: 404 });
  }
};
