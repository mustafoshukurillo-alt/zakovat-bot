const TelegramBot = require('node-telegram-bot-api');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

let individuals = [];

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Zakovat ro‘yxatdan o‘tish", {
    reply_markup: {
      keyboard: [
        ["👥 Jamoa"],
        ["🧍 Individual"]
      ],
      resize_keyboard: true
    }
  });
});

bot.on('message', (msg) => {
  if (msg.text === "🧍 Individual") {
    individuals.push(msg.from.id);
    bot.sendMessage(msg.chat.id, "Random jamoaga qo‘shildingiz");
  }
});

bot.onText(/\/random/, (msg) => {
  let team = [];
  let result = [];

  individuals.forEach(u => {
    team.push(u);
    if (team.length === 5) {
      result.push(team);
      team = [];
    }
  });

  bot.sendMessage(msg.chat.id, JSON.stringify(result));
});
