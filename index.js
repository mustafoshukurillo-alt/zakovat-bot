const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// -------------------- KONFIGURATSIYA --------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) throw new Error('BOT_TOKEN topilmadi');
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim()));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// -------------------- MA'LUMOTLAR YOLLARI --------------------
const DB_PATH = path.join(__dirname, 'db.json');
const EMPLOYEES_PATH = path.join(__dirname, 'employees.json');

// -------------------- GLOBAL O'ZGARUVCHILAR --------------------
let db = { teams: [], individuals: [], registrationOpen: true };
let employees = { employees: [] };

// Foydalanuvchi suhbat holati (step, teamCreationData va boshqalar)
const userSessions = new Map();

// -------------------- YORDAMCHI FUNKSIYALAR --------------------
async function loadData() {
  try {
    const dbRaw = await fs.readFile(DB_PATH, 'utf8');
    db = JSON.parse(dbRaw);
  } catch (err) {
    console.log('Yangi db.json yaratiladi');
    await saveDB();
  }
  try {
    const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
    employees = JSON.parse(empRaw);
  } catch (err) {
    console.error('employees.json topilmadi');
    process.exit(1);
  }
}

async function saveDB() {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}

// Xodim mavjudmi? (hech qanday jamoada yoki yakka ro'yxatda yo'q)
function isEmployeeAvailable(employeeId) {
  // jamoa a'zolarida borligini tekshiramiz
  const inTeam = db.teams.some(team => team.members.includes(employeeId));
  const inIndividual = db.individuals.some(ind => ind.employeeId === employeeId);
  return !inTeam && !inIndividual;
}

// Bo'limdagi mavjud xodimlar ro'yxati (istisnolar bilan)
function getAvailableEmployeesByDepartment(department, excludeIds = []) {
  return employees.employees.filter(emp =>
    emp.department === department &&
    isEmployeeAvailable(emp.id) &&
    !excludeIds.includes(emp.id)
  );
}

// Barcha bo'limlar (unique)
function getDepartments() {
  const deps = new Set(employees.employees.map(e => e.department));
  return Array.from(deps);
}

// Xodim nomini olish
function getEmployeeName(id) {
  const emp = employees.employees.find(e => e.id === id);
  return emp ? emp.name : `ID:${id}`;
}

// Jamoani matn sifatida chiqarish
function formatTeam(team, idx) {
  const captainName = getEmployeeName(team.captainId);
  const memberNames = team.members.map(m => getEmployeeName(m)).join(', ');
  return `${idx+1}. ${team.teamName}\n   Sardor: ${captainName}\n   A'zolar: ${memberNames}`;
}

// Yakka ro'yxatni formatlash
function formatIndividuals() {
  if (db.individuals.length === 0) return "Yakka ro'yxat bo'sh.";
  return db.individuals.map((ind, i) => {
    const emp = employees.employees.find(e => e.id === ind.employeeId);
    return `${i+1}. ${emp ? emp.name : 'Noma\'lum'} (${emp ? emp.department : ''})`;
  }).join('\n');
}

// CSV generatsiya (jamoalar va yakkalar)
function generateTeamsCSV() {
  let csv = "Jamoa nomi,Sardor,A'zolar\n";
  for (const team of db.teams) {
    const captain = getEmployeeName(team.captainId);
    const members = team.members.map(m => getEmployeeName(m)).join(';');
    csv += `"${team.teamName}","${captain}","${members}"\n`;
  }
  return csv;
}

function generateIndividualsCSV() {
  let csv = "Xodim ismi,Bo'lim\n";
  for (const ind of db.individuals) {
    const emp = employees.employees.find(e => e.id === ind.employeeId);
    if (emp) csv += `"${emp.name}","${emp.department}"\n`;
  }
  return csv;
}

// Admin ruxsatini tekshirish
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

// Asosiy menyu (reply keyboard)
function getMainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "👥 Jamoa yaratish" }],
        [{ text: "👤 Yakka tartibda ro'yxatdan o'tish" }],
        [{ text: "ℹ️ Yordam" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// -------------------- BOT HANDLERLARI --------------------

// /start buyrug'i
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Assalomu alaykum! Zakovat o'yiniga xush kelibsiz.\nQuyidagi tugmalar orqali ro'yxatdan o'tishingiz mumkin:", getMainMenuKeyboard());
});

// /admin buyrug'i (faqat adminlar)
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isAdmin(msg.from.id)) {
    return bot.sendMessage(chatId, "⛔ Bu buyruq faqat adminlar uchun.");
  }
  const adminButtons = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Jamoalarni ko'rish", callback_data: "admin_view_teams" }],
        [{ text: "👤 Yakka ro'yxatni ko'rish", callback_data: "admin_view_individuals" }],
        [{ text: "🎲 Tasodifiy jamoalar yaratish", callback_data: "admin_random_teams" }],
        [{ text: "📁 Ma'lumotlarni CSV yuklab olish", callback_data: "admin_export_csv" }],
        [{ text: db.registrationOpen ? "🔒 Ro'yxatni yopish" : "🔓 Ro'yxatni ochish", callback_data: "admin_toggle_registration" }]
      ]
    }
  };
  bot.sendMessage(chatId, "🔧 Admin paneli:", adminButtons);
});

// Jamoani yakunlash (5 a'zo to'liq bo'lganda)
async function finalizeTeam(chatId, userId, teamData) {
  const { teamName, captainId, members } = teamData;
  // Takroriy tekshiruv
  for (const empId of members) {
    if (!isEmployeeAvailable(empId)) {
      bot.sendMessage(chatId, `❌ Xodim ${getEmployeeName(empId)} endi mavjud emas (boshqa jamoa yoki yakka ro'yxatda). Iltimos, qaytadan urinib ko'ring.`);
      userSessions.delete(chatId);
      return false;
    }
  }
  const newTeam = {
    teamName,
    captainId,
    members,
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  db.teams.push(newTeam);
  await saveDB();
  bot.sendMessage(chatId, `✅ "${teamName}" jamoasi muvaffaqiyatli ro'yxatdan o'tdi! Jamoa a'zolari: ${members.map(m => getEmployeeName(m)).join(', ')}`);
  userSessions.delete(chatId);
  return true;
}

// Inline tugmalar orqali bo'lim va xodim tanlash (umumiy)
async function askDepartment(chatId, action, context = {}) {
  const departments = getDepartments();
  const buttons = departments.map(dept => ([{ text: dept, callback_data: `dept_${action}_${dept}` }]));
  buttons.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
  bot.sendMessage(chatId, `Iltimos, ${action === 'captain' ? 'sardor' : 'a\'zo'} bo\'limini tanlang:`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

// A'zo qo'shish jarayoni (takrorlanuvchi)
async function askNextMember(chatId, session) {
  const { teamCreationData } = session;
  const currentMembers = teamCreationData.members;
  const need = 5 - currentMembers.length;
  if (need === 0) {
    await finalizeTeam(chatId, session.userId, teamCreationData);
    return;
  }
  bot.sendMessage(chatId, `🔄 Hozircha ${currentMembers.length} ta a'zo kiritildi. Yana ${need} ta a'zo kerak. A'zo qo'shish uchun bo'limni tanlang:`);
  await askDepartment(chatId, 'member', { teamCreationData });
}

// -------------------- CALLBACK QUERY --------------------
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  // Bekor qilish
  if (data === 'cancel') {
    userSessions.delete(chatId);
    bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Admin panel callbacklari
  if (data === 'admin_view_teams') {
    if (!isAdmin(userId)) return;
    if (db.teams.length === 0) bot.sendMessage(chatId, "Hozircha hech qanday jamoa yo'q.");
    else {
      let msg = "📋 **Jamoalar ro'yxati:**\n\n";
      db.teams.forEach((team, idx) => { msg += formatTeam(team, idx) + "\n\n"; });
      bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_view_individuals') {
    if (!isAdmin(userId)) return;
    bot.sendMessage(chatId, `👤 **Yakka ro'yxat:**\n${formatIndividuals()}`, { parse_mode: 'Markdown' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_random_teams') {
    if (!isAdmin(userId)) return;
    if (db.individuals.length < 5) {
      bot.sendMessage(chatId, "❌ Tasodifiy jamoa yaratish uchun kamida 5 nafar yakka ishtirokchi kerak.");
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    // shuffle individuals
    let individualsCopy = [...db.individuals];
    for (let i = individualsCopy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [individualsCopy[i], individualsCopy[j]] = [individualsCopy[j], individualsCopy[i]];
    }
    const employeeIds = individualsCopy.map(ind => ind.employeeId);
    const newTeams = [];
    const usedEmployees = new Set();
    for (let i = 0; i + 5 <= employeeIds.length; i += 5) {
      const group = employeeIds.slice(i, i+5);
      const captainId = group[0];
      const teamName = `Random guruh ${Math.floor(i/5)+1}`;
      newTeams.push({
        teamName,
        captainId,
        members: group,
        createdBy: userId,
        createdAt: new Date().toISOString()
      });
      group.forEach(id => usedEmployees.add(id));
    }
    // Qolgan yakkalarni saqlab qolamiz (to'liq jamoa bo'lmaganlar)
    const remainingIndividuals = employeeIds.filter(id => !usedEmployees.has(id));
    db.teams.push(...newTeams);
    db.individuals = db.individuals.filter(ind => remainingIndividuals.includes(ind.employeeId));
    await saveDB();
    bot.sendMessage(chatId, `🎉 ${newTeams.length} ta tasodifiy jamoa yaratildi! Qolgan yakkaliklar: ${remainingIndividuals.length}`);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_export_csv') {
    if (!isAdmin(userId)) return;
    const teamsCsv = generateTeamsCSV();
    const individualsCsv = generateIndividualsCSV();
    const teamsBuffer = Buffer.from(teamsCsv, 'utf8');
    const indBuffer = Buffer.from(individualsCsv, 'utf8');
    await bot.sendDocument(chatId, teamsBuffer, { filename: 'jamoalar.csv', contentType: 'text/csv' });
    await bot.sendDocument(chatId, indBuffer, { filename: 'yakkalar.csv', contentType: 'text/csv' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_toggle_registration') {
    if (!isAdmin(userId)) return;
    db.registrationOpen = !db.registrationOpen;
    await saveDB();
    const status = db.registrationOpen ? "ochiq" : "yopiq";
    bot.sendMessage(chatId, `📌 Ro'yxatga olish ${status}.`);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Bo'lim tanlash (sardor yoki a'zo uchun)
  if (data.startsWith('dept_')) {
    const parts = data.split('_');
    const action = parts[1]; // 'captain' yoki 'member'
    const department = parts.slice(2).join('_');
    const session = userSessions.get(chatId);
    if (!session || session.step !== action) {
      bot.sendMessage(chatId, "Iltimos, avval 'Jamoa yaratish' tugmasini bosing.");
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    let excludeIds = [];
    if (action === 'captain') {
      // hech narsa chiqarilmaydi
    } else if (action === 'member') {
      excludeIds = session.teamCreationData.members;
    }

    const availableEmps = getAvailableEmployeesByDepartment(department, excludeIds);
    if (availableEmps.length === 0) {
      bot.sendMessage(chatId, "Bu bo'limda mavjud xodimlar yo'q yoki ular allaqachon band.");
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    const employeeButtons = availableEmps.map(emp => ([{
      text: emp.name,
      callback_data: `emp_${action}_${emp.id}`
    }]));
    employeeButtons.push([{ text: "⬅️ Orqaga", callback_data: "back_departments" }]);
    bot.sendMessage(chatId, `"${department}" bo'limidagi xodimlardan birini tanlang:`, {
      reply_markup: { inline_keyboard: employeeButtons }
    });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Xodim tanlash (sardor yoki a'zo)
  if (data.startsWith('emp_')) {
    const parts = data.split('_');
    const action = parts[1];
    const employeeId = parseInt(parts[2]);
    const session = userSessions.get(chatId);
    if (!session || session.step !== action) {
      bot.sendMessage(chatId, "Vaqt tugadi yoki jarayon to‘xtatilgan. Qaytadan urinib ko‘ring.");
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    // mavjudlik tekshiruvi
    if (!isEmployeeAvailable(employeeId)) {
      bot.sendMessage(chatId, `❌ ${getEmployeeName(employeeId)} allaqachon band.`);
      userSessions.delete(chatId);
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    if (action === 'captain') {
      session.teamCreationData.captainId = employeeId;
      session.teamCreationData.members.push(employeeId);
      session.step = 'member';
      await askNextMember(chatId, session);
    } else if (action === 'member') {
      const teamData = session.teamCreationData;
      if (teamData.members.includes(employeeId)) {
        bot.sendMessage(chatId, "Bu xodim allaqachon tanlangan.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      teamData.members.push(employeeId);
      if (teamData.members.length === 5) {
        await finalizeTeam(chatId, session.userId, teamData);
      } else {
        await askNextMember(chatId, session);
      }
    }
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Orqaga (bo'limlarga qaytish)
  if (data === 'back_departments') {
    const session = userSessions.get(chatId);
    if (session && (session.step === 'captain' || session.step === 'member')) {
      await askDepartment(chatId, session.step, {});
    } else {
      bot.sendMessage(chatId, "Noma'lum holat.");
    }
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  bot.answerCallbackQuery(callbackQuery.id);
});

// -------------------- MATNLI XABARLAR --------------------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;

  if (!text) return;
  // Asosiy menyu tugmalari
  if (text === "👥 Jamoa yaratish") {
    if (!db.registrationOpen) {
      return bot.sendMessage(chatId, "❌ Hozirda ro'yxatga olish yopilgan. Admin bilan bog‘laning.");
    }
    if (userSessions.has(chatId)) {
      return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel buyrug‘i bilan bekor qiling.");
    }
    userSessions.set(chatId, {
      step: 'awaiting_team_name',
      teamCreationData: { teamName: '', captainId: null, members: [] },
      userId
    });
    return bot.sendMessage(chatId, "Jamoa nomini kiriting:");
  }

  if (text === "👤 Yakka tartibda ro'yxatdan o'tish") {
    if (!db.registrationOpen) {
      return bot.sendMessage(chatId, "Ro'yxatga olish yopilgan.");
    }
    // Yakka ro'yxatga olish: foydalanuvchi o'zini tanlashi kerak (xodimlar bazasidan)
    // Buning uchun bo'lim => xodim tanlash ketma-ketligi
    userSessions.set(chatId, {
      step: 'individual',
      userId
    });
    return askDepartment(chatId, 'individual');
  }

  if (text === "ℹ️ Yordam") {
    return bot.sendMessage(chatId, "📌 **Yordam**\n\nJamoa yaratish: 5 kishidan iborat jamoa tuzasiz (sardor + 4 a'zo).\nYakka ro'yxat: faqat o'zingizni ro'yxatdan o'tkazasiz, keyin admin sizni guruhga joylaydi.\n\nAdmin: /admin buyrug‘i.", { parse_mode: 'Markdown' });
  }

  // JAMOA NOMINI QABUL QILISH
  const session = userSessions.get(chatId);
  if (session && session.step === 'awaiting_team_name') {
    if (text.length > 50) return bot.sendMessage(chatId, "Jamoa nomi 50 belgidan oshmasligi kerak.");
    session.teamCreationData.teamName = text;
    session.step = 'captain';
    bot.sendMessage(chatId, "Endi jamoa sardorini tanlang (bo'lim orqali):");
    await askDepartment(chatId, 'captain', {});
    return;
  }

  // YAKKA RO'YXAT UCHUN BO'LIM TANLASH (inline orqali) – yuqorida callback qismida ishlanadi.
  // Agar foydalanuvchi boshqa holatda matn yozsa, e'tiborsiz
});

// /cancel buyrug'i
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (userSessions.has(chatId)) {
    userSessions.delete(chatId);
    bot.sendMessage(chatId, "Jarayon bekor qilindi.", getMainMenuKeyboard());
  } else {
    bot.sendMessage(chatId, "Hech qanday faol jarayon yo'q.");
  }
});

// Yakka ro'yxat uchun maxsus callback (individual)
bot.on('callback_query', async (callbackQuery) => {
  // ... oldingi kodlarga qo'shimcha
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  const session = userSessions.get(chatId);
  if (session && session.step === 'individual' && data.startsWith('dept_individual_')) {
    const department = data.split('_')[2];
    const availableEmps = getAvailableEmployeesByDepartment(department, []);
    if (availableEmps.length === 0) {
      bot.sendMessage(chatId, "Bu bo'limda mavjud xodim yo'q.");
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    const empButtons = availableEmps.map(emp => ([{ text: emp.name, callback_data: `ind_emp_${emp.id}` }]));
    empButtons.push([{ text: "⬅️ Orqaga", callback_data: "back_departments_ind" }]);
    bot.sendMessage(chatId, "O‘zingizni tanlang:", { reply_markup: { inline_keyboard: empButtons } });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (session && session.step === 'individual' && data.startsWith('ind_emp_')) {
    const employeeId = parseInt(data.split('_')[2]);
    if (!isEmployeeAvailable(employeeId)) {
      bot.sendMessage(chatId, "Bu xodim allaqachon ro'yxatdan o'tgan.");
      userSessions.delete(chatId);
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    db.individuals.push({ employeeId, registeredAt: new Date().toISOString(), telegramUserId: session.userId });
    await saveDB();
    bot.sendMessage(chatId, "✅ Siz yakka tartibda ro'yxatdan o'tdingiz. Admin sizni jamoada guruhlaydi.", getMainMenuKeyboard());
    userSessions.delete(chatId);
    return bot.answerCallbackQuery(callbackQuery.id);
  }
  if (data === 'back_departments_ind' && session && session.step === 'individual') {
    await askDepartment(chatId, 'individual');
    return bot.answerCallbackQuery(callbackQuery.id);
  }
  // Agar boshqa callback qayta ishlansa, yuqoridagi asosiy qism allaqachon ishlaydi.
  // Ammo funksiyani qayta yuklamaslik uchun yuqoridagi asosiy callback qismiga 'individual' uchun qo'shimcha qo'shildi.
  // To'liq ishlashi uchun 'askDepartment' funksiyasini kengaytirish kerak: individual uchun bo'lim tanlash.
  // Ammo 'askDepartment' hozirda faqat captain/member qabul qiladi. Qo'shimcha: agar action === 'individual' bo'lsa ishlaydi.
});

// Express serverni ishga tushirish (Railway uchun)
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda`));

// Boshlash
async function init() {
  await loadData();
  console.log('Bot ishga tushdi...');
}
init();
