const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');

const token = process.env.BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// ===== LOAD DB =====
let db = JSON.parse(fs.readFileSync('db.json'));

function saveDB() {
  fs.writeFileSync('db.json', JSON.stringify(db, null, 2));
}

// ===== ADMIN =====
const ADMINS = [123456789]; // o'zingizni ID qo'shing

// ===== TEMP STATE =====
let userState = {};

// ===== START =====
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Zakovat o‘yiniga xush kelibsiz!", {
    reply_markup: {
      keyboard: [
        ["👥 Jamoa yaratish"],
        ["🧍 Individual"]
      ],
      resize_keyboard: true
    }
  });
});

// ===== MESSAGE =====
bot.on("message", (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!db.settings.registrationOpen) {
    return bot.sendMessage(chatId, "❌ Ro‘yxat yopilgan");
  }

  // INDIVIDUAL
  if (text === "🧍 Individual") {
    if (!db.individuals.includes(chatId)) {
      db.individuals.push(chatId);
      saveDB();
    }
    return bot.sendMessage(chatId, "✅ Random jamoaga qo‘shildingiz");
  }

  // TEAM CREATE
  if (text === "👥 Jamoa yaratish") {
    userState[chatId] = { step: "team_name" };
    return bot.sendMessage(chatId, "Jamoa nomini kiriting:");
  }

  // TEAM NAME
  if (userState[chatId]?.step === "team_name") {
    userState[chatId] = {
      step: "select_department",
      teamName: text,
      members: []
    };

    return sendDepartments(chatId);
  }
});

// ===== DEPARTMENTS =====
function sendDepartments(chatId) {
  const deps = [...new Set(db.employees.map(e => e.department))];

  bot.sendMessage(chatId, "Bo‘limni tanlang:", {
    reply_markup: {
      inline_keyboard: deps.map(d => [
        { text: d, callback_data: "dep_" + d }
      ])
    }
  });
}

// ===== CALLBACK =====
bot.on("callback_query", (q) => {
  const chatId = q.message.chat.id;
  const data = q.data;

  // SELECT DEPARTMENT
  if (data.startsWith("dep_")) {
    const dep = data.split("_")[1];

    const emps = db.employees.filter(e => e.department === dep);

    return bot.sendMessage(chatId, "Ism tanlang:", {
      reply_markup: {
        inline_keyboard: emps.map(e => [
          { text: e.name, callback_data: "emp_" + e.id }
        ])
      }
    });
  }

  // SELECT EMPLOYEE
  if (data.startsWith("emp_")) {
    const empId = parseInt(data.split("_")[1]);
    const emp = db.employees.find(e => e.id === empId);

    let state = userState[chatId];

    if (!state.members.find(m => m.id === empId)) {
      state.members.push(emp);
    }

    if (state.members.length === 5) {
      db.teams.push({
        name: state.teamName,
        members: state.members
      });

      saveDB();
      delete userState[chatId];

      return bot.sendMessage(chatId, "✅ Jamoa ro‘yxatdan o‘tdi!");
    }

    bot.sendMessage(chatId, `Qo‘shildi: ${emp.name}\n(${state.members.length}/5)`);

    sendDepartments(chatId);
  }
});

// ===== ADMIN =====
bot.onText(/\/admin/, (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;

  bot.sendMessage(msg.chat.id, "Admin panel:", {
    reply_markup: {
      keyboard: [
        ["📊 Jamoalar"],
        ["👤 Individuals"],
        ["🔁 Random"],
        ["📥 Export"],
        ["🔒 Close"]
      ],
      resize_keyboard: true
    }
  });
});

// ===== ADMIN ACTION =====
bot.on("message", (msg) => {
  if (!ADMINS.includes(msg.from.id)) return;

  const chatId = msg.chat.id;
  const text = msg.text;

  if (text === "📊 Jamoalar") {
    let out = db.teams.map(t => t.name).join("\n");
    bot.sendMessage(chatId, out || "Yo‘q");
  }

  if (text === "👤 Individuals") {
    bot.sendMessage(chatId, db.individuals.length + " ta");
  }

  if (text === "🔁 Random") {
    let temp = [];
    let result = [];

    db.individuals.forEach(u => {
      temp.push(u);
      if (temp.length === 5) {
        result.push(temp);
        temp = [];
      }
    });

    bot.sendMessage(chatId, JSON.stringify(result));
  }

  if (text === "📥 Export") {
    let csv = "Team,Member\n";

    db.teams.forEach(t => {
      t.members.forEach(m => {
        csv += `${t.name},${m.name}\n`;
      });
    });

    fs.writeFileSync("export.csv", csv);
    bot.sendDocument(chatId, "export.csv");
  }

  if (text === "🔒 Close") {
    db.settings.registrationOpen = false;
    saveDB();
    bot.sendMessage(chatId, "Yopildi");
  }
});
