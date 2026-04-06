const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');

// -------------------- KONFIGURATSIYA --------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi! Railway environmentga qo‘shing.');
  process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// -------------------- MA'LUMOTLAR YO'LLARI --------------------
const DB_PATH = path.join(__dirname, 'db.json');
const EMPLOYEES_PATH = path.join(__dirname, 'employees.json');

// -------------------- GLOBAL O'ZGARUVCHILAR --------------------
let db = { teams: [], individuals: [], registrationOpen: true };
let employees = { employees: [] };
let nextEmployeeId = 1;
const userSessions = new Map(); // { chatId: { step, teamCreationData, userId } }

// -------------------- YORDAMCHI FUNKSIYALAR --------------------
async function loadData() {
  try {
    const dbRaw = await fs.readFile(DB_PATH, 'utf8');
    db = JSON.parse(dbRaw);
  } catch {
    db = { teams: [], individuals: [], registrationOpen: true };
    await saveDB();
  }
  try {
    const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
    employees = JSON.parse(empRaw);
    if (employees.employees.length) {
      nextEmployeeId = Math.max(...employees.employees.map(e => e.id)) + 1;
    } else {
      nextEmployeeId = 1;
    }
  } catch {
    employees = { employees: [] };
    nextEmployeeId = 1;
    await saveEmployees();
  }
}
async function saveDB() {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2));
}
async function saveEmployees() {
  await fs.writeFile(EMPLOYEES_PATH, JSON.stringify(employees, null, 2));
}

// Xodim mavjudmi? (hech qanday jamoada yoki yakka ro'yxatda yo'q)
function isEmployeeAvailable(employeeId) {
  const inTeam = db.teams.some(team => team.members.includes(employeeId));
  const inIndividual = db.individuals.some(ind => ind.employeeId === employeeId);
  return !inTeam && !inIndividual;
}

// Bo'limdagi mavjud xodimlar (excludeIds dan tashqari)
function getAvailableEmployeesByDepartment(department, excludeIds = []) {
  return employees.employees.filter(emp =>
    emp.department === department &&
    isEmployeeAvailable(emp.id) &&
    !excludeIds.includes(emp.id)
  );
}

function getDepartments() {
  const deps = new Set(employees.employees.map(e => e.department));
  return Array.from(deps);
}

function getEmployeeName(id) {
  const emp = employees.employees.find(e => e.id === id);
  return emp ? emp.name : `ID:${id}`;
}
function getEmployeePosition(id) {
  const emp = employees.employees.find(e => e.id === id);
  return emp ? emp.position : '';
}
function getEmployeeDepartment(id) {
  const emp = employees.employees.find(e => e.id === id);
  return emp ? emp.department : '';
}

// Formatlash
function formatTeam(team, idx) {
  const captainName = getEmployeeName(team.captainId);
  const memberNames = team.members.map(m => getEmployeeName(m)).join(', ');
  return `${idx+1}. ${team.teamName}\n   Sardor: ${captainName}\n   A'zolar: ${memberNames}\n   Tel: ${team.phoneNumber || '—'}`;
}
function formatIndividuals() {
  if (db.individuals.length === 0) return "Yakka ro'yxat bo'sh.";
  return db.individuals.map((ind, i) => {
    const emp = employees.employees.find(e => e.id === ind.employeeId);
    return `${i+1}. ${emp ? emp.name : 'Noma\'lum'} (${emp ? emp.department : ''})`;
  }).join('\n');
}

// CSV generatsiya (har doim sarlavha bilan)
function generateTeamsCSV() {
  let csv = "Jamoa nomi,Sardor,Sardor telefon,A'zolar\n";
  if (db.teams.length > 0) {
    csv += db.teams.map(team => {
      const captainName = getEmployeeName(team.captainId);
      const members = team.members.map(m => getEmployeeName(m)).join(';');
      return `"${team.teamName}","${captainName}","${team.phoneNumber || ''}","${members}"`;
    }).join('\n');
  }
  return csv;
}
function generateIndividualsCSV() {
  let csv = "Xodim ismi,Bo'lim\n";
  if (db.individuals.length > 0) {
    csv += db.individuals.map(ind => {
      const emp = employees.employees.find(e => e.id === ind.employeeId);
      return `"${emp ? emp.name : 'Noma\'lum'}","${emp ? emp.department : ''}"`;
    }).join('\n');
  }
  return csv;
}

// -------------------- PDF ARIZA YARATISH --------------------
async function generateApplicationPDF(team, phoneNumber) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Sarlavha
    doc.fontSize(18).font('Helvetica-Bold').text('SamAuto Zakovat turniri', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(16).text('QATNASHISH UCHUN ARIZA', { align: 'center' });
    doc.moveDown(1);

    // Jamoa ma'lumotlari
    doc.fontSize(12).font('Helvetica-Bold').text(`Jamoa nomi: ${team.teamName}`);
    doc.text(`Sardor: ${getEmployeeName(team.captainId)} (Telefon: ${phoneNumber})`);
    doc.text(`A'zolar soni: ${team.members.length}`);
    doc.moveDown(0.5);

    // Jadval sarlavhasi
    let y = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('№', 50, y);
    doc.text('F.I.SH.', 80, y);
    doc.text('Lavozim', 250, y);
    doc.text('Bo‘lim/Tsex', 350, y);
    doc.text('Imzo', 450, y);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    y = doc.y;
    doc.font('Helvetica');
    for (let i = 0; i < team.members.length; i++) {
      const empId = team.members[i];
      doc.text(`${i+1}`, 50, y + 5);
      doc.text(getEmployeeName(empId), 80, y + 5, { width: 160 });
      doc.text(getEmployeePosition(empId), 250, y + 5, { width: 90 });
      doc.text(getEmployeeDepartment(empId), 350, y + 5, { width: 90 });
      doc.text('__________', 450, y + 5);
      y += 25;
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
    }
    doc.moveDown(1);
    doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, { align: 'right' });
    doc.moveDown(0.5);
    doc.text(`Sardor imzosi: __________`, { align: 'right' });
    doc.text(`Tashkilot muhri (agar mavjud bo'lsa): __________`, { align: 'right' });

    doc.end();
  });
}

// -------------------- ADMIN FUNKSIYASI: CSV dan xodimlarni yangilash --------------------
async function updateEmployeesFromCSV(fileBuffer) {
  const content = fileBuffer.toString('utf8');
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSVda kamida 2 qator bo‘lishi kerak (sarlavha + ma’lumotlar)');

  let startIdx = 0;
  const firstLine = lines[0].toLowerCase();
  if (firstLine.includes('ism') || firstLine.includes('name') || firstLine.includes('f.i.sh') || firstLine.includes('t/r')) {
    startIdx = 1;
  }

  const newEmployees = [];
  let newId = 1;
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
    if (parts.length < 4) continue;
    // format: tartib_raqam (ixtiyoriy), ism, lavozim, bo'lim
    const name = parts[1];
    const position = parts[2];
    const department = parts[3];
    if (!name || !department) continue;
    newEmployees.push({ id: newId++, name, position: position || '', department });
  }
  if (newEmployees.length === 0) throw new Error('Hech qanday xodim topilmadi');
  employees.employees = newEmployees;
  nextEmployeeId = newId;
  await saveEmployees();

  // Eski jamoalar va yakka ro'yxatlarni tozalash (xodimlar ID si o'zgargan)
  db.teams = [];
  db.individuals = [];
  await saveDB();
  return newEmployees.length;
}

// -------------------- BOT UI --------------------
function getMainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "👥 Jamoa yaratish" }, { text: "👤 Yakka ro'yxat" }],
        [{ text: "📄 Mening jamoam" }, { text: "ℹ️ Yordam" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// -------------------- JAMOA YARATISH FLOW (yordamchi funksiyalar) --------------------
async function askDepartment(chatId, action, context = {}) {
  const departments = getDepartments();
  if (departments.length === 0) {
    await bot.sendMessage(chatId, "❌ Hech qanday bo‘lim mavjud emas. Admin xodimlarni yuklamagan.");
    return;
  }
  const buttons = departments.map(dept => ([{ text: dept, callback_data: `dept_${action}_${dept}` }]));
  buttons.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
  await bot.sendMessage(chatId, `Iltimos, ${action === 'captain' ? 'sardor' : action === 'member' ? "a'zo" : "o'zingiz"} bo‘limini tanlang:`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function askNextMember(chatId, session) {
  const { teamCreationData } = session;
  const need = 5 - teamCreationData.members.length;
  if (need === 0) {
    session.step = 'awaiting_phone';
    await bot.sendMessage(chatId, "✅ Barcha 5 a'zo tanlandi. Endi jamoa sardorining telefon raqamini kiriting:\nMasalan: +998901234567");
    return;
  }
  await bot.sendMessage(chatId, `🔄 Hozircha ${teamCreationData.members.length} ta a'zo kiritildi. Yana ${need} ta a'zo kerak. A'zo qo'shish uchun bo'limni tanlang:`);
  await askDepartment(chatId, 'member');
}

async function finalizeTeam(chatId, userId, teamData, phoneNumber) {
  const { teamName, captainId, members } = teamData;
  // Takroriy tekshiruv
  for (const empId of members) {
    if (!isEmployeeAvailable(empId)) {
      await bot.sendMessage(chatId, `❌ Xodim ${getEmployeeName(empId)} endi mavjud emas (boshqa jamoa yoki yakka ro'yxatda). Iltimos, qaytadan urinib ko'ring.`);
      userSessions.delete(chatId);
      return false;
    }
  }
  const teamId = Date.now() + Math.floor(Math.random() * 10000);
  const newTeam = {
    teamId,
    teamName,
    captainId,
    members,
    phoneNumber,
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  db.teams.push(newTeam);
  await saveDB();

  // PDF yaratish va yuborish
  const pdfBuffer = await generateApplicationPDF(newTeam, phoneNumber);
  await bot.sendDocument(chatId, pdfBuffer, {
    filename: `Zakovat_Ariza_${teamName.replace(/\s/g, '_')}.pdf`,
    contentType: 'application/pdf',
    caption: `✅ "${teamName}" jamoasi muvaffaqiyatli ro‘yxatdan o‘tdi!\n\n📄 Quyida rasmiy ariza shakli.`
  });
  await bot.sendMessage(chatId, "Arizani yuklab oldingiz. Turnirda omad tilaymiz!", getMainMenuKeyboard());
  userSessions.delete(chatId);
  return true;
}

// -------------------- BOT HANDLERLARI --------------------
// /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, "Assalomu alaykum! Zakovat o'yiniga xush kelibsiz.\nQuyidagi tugmalar orqali ro'yxatdan o'tishingiz mumkin:", getMainMenuKeyboard());
});

// /admin
bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "⛔ Bu buyruq faqat adminlar uchun.");
  }
  const adminButtons = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Jamoalarni ko'rish", callback_data: "admin_view_teams" }],
        [{ text: "👤 Yakka ro'yxatni ko'rish", callback_data: "admin_view_individuals" }],
        [{ text: "🎲 Tasodifiy jamoalar yaratish", callback_data: "admin_random_teams" }],
        [{ text: "📁 Ma'lumotlarni CSV yuklab olish", callback_data: "admin_export_csv" }],
        [{ text: db.registrationOpen ? "🔒 Ro'yxatni yopish" : "🔓 Ro'yxatni ochish", callback_data: "admin_toggle_registration" }],
        [{ text: "📂 Xodimlarni CSV dan yuklash", callback_data: "admin_upload_employees" }]
      ]
    }
  };
  await bot.sendMessage(chatId, "🔧 Admin paneli:", adminButtons);
});

// /cancel
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (userSessions.has(chatId)) {
    userSessions.delete(chatId);
    bot.sendMessage(chatId, "Jarayon bekor qilindi.", getMainMenuKeyboard());
  } else {
    bot.sendMessage(chatId, "Hech qanday faol jarayon yo'q.");
  }
});

// -------------------- YAGONA CALLBACK_QUERY HANDLER --------------------
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const session = userSessions.get(chatId);

  try {
    // Bekor qilish
    if (data === 'cancel') {
      userSessions.delete(chatId);
      await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    // ========== ADMIN PANELI ==========
    if (ADMIN_IDS.includes(userId)) {
      if (data === 'admin_view_teams') {
        let msg = "📋 **Jamoalar ro'yxati:**\n\n";
        if (db.teams.length === 0) msg = "Hozircha hech qanday jamoa yo'q.";
        else db.teams.forEach((team, idx) => { msg += formatTeam(team, idx) + "\n\n"; });
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      if (data === 'admin_view_individuals') {
        const msg = `👤 **Yakka ro'yxat:**\n${formatIndividuals()}`;
        await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      if (data === 'admin_random_teams') {
        if (db.individuals.length < 5) {
          await bot.sendMessage(chatId, "❌ Tasodifiy jamoa yaratish uchun kamida 5 nafar yakka ishtirokchi kerak.");
          return bot.answerCallbackQuery(callbackQuery.id);
        }
        let individualsCopy = [...db.individuals];
        for (let i = individualsCopy.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [individualsCopy[i], individualsCopy[j]] = [individualsCopy[j], individualsCopy[i]];
        }
        const employeeIds = individualsCopy.map(ind => ind.employeeId);
        const newTeams = [];
        const usedEmployees = new Set();
        for (let i = 0; i + 5 <= employeeIds.length; i += 5) {
          const group = employeeIds.slice(i, i + 5);
          newTeams.push({
            teamId: Date.now() + i,
            teamName: `Random guruh ${Math.floor(i / 5) + 1}`,
            captainId: group[0],
            members: group,
            phoneNumber: '',
            createdBy: userId,
            createdAt: new Date().toISOString()
          });
          group.forEach(id => usedEmployees.add(id));
        }
        const remainingIndividuals = employeeIds.filter(id => !usedEmployees.has(id));
        db.teams.push(...newTeams);
        db.individuals = db.individuals.filter(ind => remainingIndividuals.includes(ind.employeeId));
        await saveDB();
        await bot.sendMessage(chatId, `🎉 ${newTeams.length} ta tasodifiy jamoa yaratildi! Qolgan yakkaliklar: ${remainingIndividuals.length}`);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      if (data === 'admin_export_csv') {
        try {
          const teamsCsv = generateTeamsCSV();
          const indCsv = generateIndividualsCSV();
          await bot.sendDocument(chatId, Buffer.from(teamsCsv, 'utf8'), { filename: 'jamoalar.csv', contentType: 'text/csv' });
          await bot.sendDocument(chatId, Buffer.from(indCsv, 'utf8'), { filename: 'yakkalar.csv', contentType: 'text/csv' });
          await bot.sendMessage(chatId, "✅ CSV fayllar yuklab olindi.");
        } catch (err) {
          console.error('CSV eksport xatosi:', err);
          await bot.sendMessage(chatId, "❌ CSV yaratishda xatolik yuz berdi.");
        }
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      if (data === 'admin_toggle_registration') {
        db.registrationOpen = !db.registrationOpen;
        await saveDB();
        const status = db.registrationOpen ? "ochiq" : "yopiq";
        await bot.sendMessage(chatId, `📌 Ro'yxatga olish ${status}.`);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      if (data === 'admin_upload_employees') {
        userSessions.set(chatId, { step: 'awaiting_csv' });
        await bot.sendMessage(chatId, "📂 Iltimos, quyidagi formatdagi CSV faylni yuboring:\n\n`t/r, Ism, Lavozim, Bo'lim`\nMisol:\n1, Alijon Valiyev, Muhandis, Mexanika\n2, Bahrom Karimov, Texnik, Mexanika", { parse_mode: 'Markdown' });
        return bot.answerCallbackQuery(callbackQuery.id);
      }
    }

    // ========== JAMOA YARATISH: BO'LIM TANLASH ==========
    if (data.startsWith('dept_')) {
      const parts = data.split('_');
      const action = parts[1]; // 'captain', 'member', yoki 'individual'
      const department = parts.slice(2).join('_');
      if (!session || session.step !== action) {
        await bot.sendMessage(chatId, "Iltimos, avval 'Jamoa yaratish' yoki 'Yakka ro'yxat' tugmasini bosing.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      let excludeIds = [];
      if (action === 'member') excludeIds = session.teamCreationData.members;
      const available = getAvailableEmployeesByDepartment(department, excludeIds);
      if (available.length === 0) {
        await bot.sendMessage(chatId, "Bu bo'limda mavjud xodimlar yo'q yoki ular allaqachon band.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      const empButtons = available.map(emp => ([{
        text: `${emp.name} (${emp.position || 'lavozimsiz'})`,
        callback_data: `emp_${action}_${emp.id}`
      }]));
      empButtons.push([{ text: "⬅️ Orqaga", callback_data: "back_departments" }]);
      await bot.sendMessage(chatId, `"${department}" bo'limidagi xodimlardan birini tanlang:`, {
        reply_markup: { inline_keyboard: empButtons }
      });
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    // ========== XODIM TANLASH (sardor yoki a'zo) ==========
    if (data.startsWith('emp_')) {
      const parts = data.split('_');
      const action = parts[1];
      const employeeId = parseInt(parts[2]);
      if (!session || session.step !== action) {
        await bot.sendMessage(chatId, "Vaqt tugadi yoki jarayon to‘xtatilgan. Qaytadan /start bosing.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      if (!isEmployeeAvailable(employeeId)) {
        await bot.sendMessage(chatId, `❌ ${getEmployeeName(employeeId)} allaqachon band.`);
        userSessions.delete(chatId);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      if (action === 'captain') {
        session.teamCreationData.captainId = employeeId;
        session.teamCreationData.members.push(employeeId);
        session.step = 'member';
        await askNextMember(chatId, session);
      } else if (action === 'member') {
        if (session.teamCreationData.members.includes(employeeId)) {
          await bot.sendMessage(chatId, "Bu xodim allaqachon tanlangan.");
          return bot.answerCallbackQuery(callbackQuery.id);
        }
        session.teamCreationData.members.push(employeeId);
        if (session.teamCreationData.members.length === 5) {
          session.step = 'awaiting_phone';
          await bot.sendMessage(chatId, "✅ Barcha 5 a'zo tanlandi. Endi jamoa sardorining telefon raqamini kiriting:\nMasalan: +998901234567");
        } else {
          await askNextMember(chatId, session);
        }
      }
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    if (data === 'back_departments') {
      if (session && (session.step === 'captain' || session.step === 'member')) {
        await askDepartment(chatId, session.step);
      } else {
        await bot.sendMessage(chatId, "Noma'lum holat.");
      }
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    // ========== YAKKA RO'YXAT (individual) ==========
    if (data.startsWith('dept_individual_')) {
      const department = data.split('_')[2];
      if (!session || session.step !== 'individual') {
        await bot.sendMessage(chatId, "Iltimos, avval 'Yakka ro'yxat' tugmasini bosing.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      const available = getAvailableEmployeesByDepartment(department, []);
      if (available.length === 0) {
        await bot.sendMessage(chatId, "Bu bo'limda mavjud xodim yo'q.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      const empButtons = available.map(emp => ([{ text: emp.name, callback_data: `ind_emp_${emp.id}` }]));
      empButtons.push([{ text: "⬅️ Orqaga", callback_data: "back_departments_ind" }]);
      await bot.sendMessage(chatId, "O‘zingizni tanlang:", { reply_markup: { inline_keyboard: empButtons } });
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    if (data.startsWith('ind_emp_')) {
      const employeeId = parseInt(data.split('_')[2]);
      if (!isEmployeeAvailable(employeeId)) {
        await bot.sendMessage(chatId, "Bu xodim allaqachon ro'yxatdan o'tgan.");
        userSessions.delete(chatId);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      db.individuals.push({ employeeId, registeredAt: new Date().toISOString(), telegramUserId: userId });
      await saveDB();
      await bot.sendMessage(chatId, "✅ Siz yakka tartibda ro'yxatdan o'tdingiz. Admin sizni jamoada guruhlaydi.", getMainMenuKeyboard());
      userSessions.delete(chatId);
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    if (data === 'back_departments_ind') {
      if (session && session.step === 'individual') {
        await askDepartment(chatId, 'individual');
      }
      return bot.answerCallbackQuery(callbackQuery.id);
    }

  } catch (err) {
    console.error('Callback xatosi:', err);
    await bot.sendMessage(chatId, "❌ Xatolik yuz berdi. Iltimos, qaytadan urinib ko'ring.");
  }
  bot.answerCallbackQuery(callbackQuery.id);
});

// -------------------- MATNLI XABARLAR --------------------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;
  const session = userSessions.get(chatId);

  // Admin CSV yuklash (fayl qabul qilish)
  if (session && session.step === 'awaiting_csv' && msg.document) {
    if (!ADMIN_IDS.includes(userId)) return;
    try {
      const file = await bot.getFile(msg.document.file_id);
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const count = await updateEmployeesFromCSV(buffer);
      await bot.sendMessage(chatId, `✅ ${count} ta xodim muvaffaqiyatli yuklandi. Eski barcha jamoalar va yakka ro‘yxatlar tozalandi.`);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
    }
    userSessions.delete(chatId);
    return;
  }

  // Asosiy menyu tugmalari
  if (text === "👥 Jamoa yaratish") {
    if (!db.registrationOpen) {
      return bot.sendMessage(chatId, "❌ Hozirda ro'yxatga olish yopilgan. Admin bilan bog‘laning.");
    }
    if (userSessions.has(chatId)) {
      return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel bilan bekor qiling.");
    }
    userSessions.set(chatId, {
      step: 'awaiting_team_name',
      teamCreationData: { teamName: '', captainId: null, members: [] },
      userId
    });
    return bot.sendMessage(chatId, "Jamoa nomini kiriting:");
  }

  if (text === "👤 Yakka ro'yxat") {
    if (!db.registrationOpen) {
      return bot.sendMessage(chatId, "Ro'yxatga olish yopilgan.");
    }
    if (userSessions.has(chatId)) {
      return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel bilan bekor qiling.");
    }
    userSessions.set(chatId, { step: 'individual', userId });
    return askDepartment(chatId, 'individual');
  }

  if (text === "📄 Mening jamoam") {
    const userTeam = db.teams.find(team => team.createdBy === userId);
    if (!userTeam) {
      return bot.sendMessage(chatId, "Siz hali hech qanday jamoa yaratmagansiz yoki jamoangiz topilmadi.");
    }
    try {
      const pdfBuffer = await generateApplicationPDF(userTeam, userTeam.phoneNumber);
      await bot.sendDocument(chatId, pdfBuffer, {
        filename: `Zakovat_Ariza_${userTeam.teamName.replace(/\s/g, '_')}.pdf`,
        contentType: 'application/pdf',
        caption: `📄 Sizning jamoangiz arizasi: ${userTeam.teamName}`
      });
    } catch (err) {
      await bot.sendMessage(chatId, "❌ PDF yaratishda xatolik yuz berdi.");
    }
    return;
  }

  if (text === "ℹ️ Yordam") {
    return bot.sendMessage(chatId, "📌 **Yordam**\n\n• Jamoa yaratish: 5 kishidan iborat jamoa tuzasiz (sardor + 4 a'zo).\n• Yakka ro'yxat: faqat o'zingizni ro'yxatdan o'tkazasiz, keyin admin sizni guruhga joylaydi.\n• Mening jamoam: o‘z jamoangizning arizasini yuklab olish.\n• Admin: /admin buyrug‘i.\n• Bekor qilish: /cancel", { parse_mode: 'Markdown' });
  }

  // Jamoa nomini qabul qilish
  if (session && session.step === 'awaiting_team_name') {
    if (text.length > 50) return bot.sendMessage(chatId, "Jamoa nomi 50 belgidan oshmasligi kerak.");
    session.teamCreationData.teamName = text;
    session.step = 'captain';
    await bot.sendMessage(chatId, "Endi jamoa sardorini tanlang (bo'lim orqali):");
    await askDepartment(chatId, 'captain');
    return;
  }

  // Telefon raqamni qabul qilish
  if (session && session.step === 'awaiting_phone') {
    let phone = text.replace(/\D/g, '');
    if (phone.length === 9) phone = '+998' + phone;
    else if (phone.length === 12 && phone.startsWith('998')) phone = '+' + phone;
    else if (!phone.startsWith('+998')) phone = '+998' + phone.slice(-9);
    if (!/^\+998[0-9]{9}$/.test(phone)) {
      return bot.sendMessage(chatId, "❌ Noto‘g‘ri format. Iltimos, telefon raqamni +998901234567 yoki 901234567 ko‘rinishida kiriting.");
    }
    await finalizeTeam(chatId, userId, session.teamCreationData, phone);
  }
});

// -------------------- EXPRESS SERVER (Railway uchun) --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda`));

// -------------------- BOTNI ISHGA TUSHIRISH --------------------
async function init() {
  await loadData();
  console.log('Bot ishga tushdi va tayyor!');
}
init();
