const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');

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
let nextEmployeeId = 1; // yangi xodim qo'shish uchun

// Foydalanuvchi suhbat holati
const userSessions = new Map();

// -------------------- YORDAMCHI FUNKSIYALAR --------------------
async function loadData() {
  try {
    const dbRaw = await fs.readFile(DB_PATH, 'utf8');
    db = JSON.parse(dbRaw);
  } catch (err) {
    db = { teams: [], individuals: [], registrationOpen: true };
    await saveDB();
  }
  try {
    const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
    employees = JSON.parse(empRaw);
    if (employees.employees.length > 0) {
      nextEmployeeId = Math.max(...employees.employees.map(e => e.id)) + 1;
    } else {
      nextEmployeeId = 1;
    }
  } catch (err) {
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

// CSV generatsiya (jamoalar va yakkalar)
function generateTeamsCSV() {
  let csv = "Jamoa nomi,Sardor,Sardor telefon,A'zolar\n";
  for (const team of db.teams) {
    const captain = getEmployeeName(team.captainId);
    const members = team.members.map(m => getEmployeeName(m)).join(';');
    csv += `"${team.teamName}","${captain}","${team.phoneNumber || ''}","${members}"\n`;
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

// -------------------- PDF ARIZA YARATISH --------------------
async function generateApplicationPDF(team, phoneNumber) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));

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
    const startY = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('№', 50, startY);
    doc.text('F.I.SH.', 80, startY);
    doc.text('Lavozim', 250, startY);
    doc.text('Bo‘lim/Tsex', 350, startY);
    doc.text('Imzo', 450, startY);
    doc.moveDown(0.5);
    doc.strokeColor('#000').lineWidth(0.5).moveTo(50, doc.y).lineTo(550, doc.y).stroke();

    let currentY = doc.y;
    doc.font('Helvetica');
    for (let i = 0; i < team.members.length; i++) {
      const empId = team.members[i];
      const name = getEmployeeName(empId);
      const position = getEmployeePosition(empId);
      const dept = getEmployeeDepartment(empId);
      doc.text(`${i+1}`, 50, currentY + 5);
      doc.text(name, 80, currentY + 5, { width: 160 });
      doc.text(position, 250, currentY + 5, { width: 90 });
      doc.text(dept, 350, currentY + 5, { width: 90 });
      doc.text('__________', 450, currentY + 5);
      currentY += 25;
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
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

// -------------------- ADMIN FUNKSIYALARI --------------------
async function updateEmployeesFromCSV(fileBuffer) {
  const content = fileBuffer.toString('utf8');
  const lines = content.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSVda kamida 2 qator bo‘lishi kerak (sarlavha + ma’lumotlar)');
  
  // Sarlavha qatorini o‘tkazib yuboramiz (agar mavjud bo‘lsa)
  let startIdx = 0;
  const firstLine = lines[0].toLowerCase();
  if (firstLine.includes('ism') || firstLine.includes('name') || firstLine.includes('f.i.sh')) {
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
    newEmployees.push({
      id: newId++,
      name,
      position: position || '',
      department
    });
  }
  if (newEmployees.length === 0) throw new Error('Hech qanday xodim topilmadi');
  employees.employees = newEmployees;
  nextEmployeeId = newId;
  await saveEmployees();

  // Eski jamoalar va yakka ro‘yxatlarni tozalash (xodimlar ID si o‘zgargani uchun)
  db.teams = [];
  db.individuals = [];
  await saveDB();
  return newEmployees.length;
}

// -------------------- BOT HANDLERLARI --------------------
function isAdmin(userId) {
  return ADMIN_IDS.includes(userId);
}

function getMainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: "👥 Jamoa yaratish" }],
        [{ text: "👤 Yakka tartibda ro'yxatdan o'tish" }],
        [{ text: "ℹ️ Yordam" }],
        [{ text: "📄 Mening jamoam" }]
      ],
      resize_keyboard: true,
      one_time_keyboard: false
    }
  };
}

// -------------------- JAMOA YARATISH FLOW (telefon raqam bilan) --------------------
async function askDepartment(chatId, action, context = {}) {
  const departments = getDepartments();
  if (departments.length === 0) {
    await bot.sendMessage(chatId, "❌ Hech qanday bo‘lim mavjud emas. Admin bilan bog‘laning.");
    return;
  }
  const buttons = departments.map(dept => ([{ text: dept, callback_data: `dept_${action}_${dept}` }]));
  buttons.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
  await bot.sendMessage(chatId, `Iltimos, ${action === 'captain' ? 'sardor' : 'a\'zo'} bo‘limini tanlang:`, {
    reply_markup: { inline_keyboard: buttons }
  });
}

async function askNextMember(chatId, session) {
  const { teamCreationData } = session;
  const currentMembers = teamCreationData.members;
  const need = 5 - currentMembers.length;
  if (need === 0) {
    // Endi telefon raqam so‘raymiz
    session.step = 'awaiting_phone';
    await bot.sendMessage(chatId, "✅ Barcha 5 a'zo tanlandi. Endi jamoa sardorining telefon raqamini kiriting:\nMasalan: +998901234567");
    return;
  }
  await bot.sendMessage(chatId, `🔄 Hozircha ${currentMembers.length} ta a'zo kiritildi. Yana ${need} ta a'zo kerak. A'zo qo'shish uchun bo'limni tanlang:`);
  await askDepartment(chatId, 'member', { teamCreationData });
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

  // PDF yaratish
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

// -------------------- CALLBACK QUERY --------------------
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;

  if (data === 'cancel') {
    userSessions.delete(chatId);
    await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Admin paneli callbacklari
  if (data === 'admin_view_teams') {
    if (!isAdmin(userId)) return;
    if (db.teams.length === 0) await bot.sendMessage(chatId, "Hozircha hech qanday jamoa yo'q.");
    else {
      let msg = "📋 **Jamoalar ro'yxati:**\n\n";
      db.teams.forEach((team, idx) => { msg += formatTeam(team, idx) + "\n\n"; });
      await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    }
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_view_individuals') {
    if (!isAdmin(userId)) return;
    await bot.sendMessage(chatId, `👤 **Yakka ro'yxat:**\n${formatIndividuals()}`, { parse_mode: 'Markdown' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_random_teams') {
    if (!isAdmin(userId)) return;
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
      const group = employeeIds.slice(i, i+5);
      const teamId = Date.now() + i + Math.random()*1000;
      newTeams.push({
        teamId,
        teamName: `Random guruh ${Math.floor(i/5)+1}`,
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
    if (!isAdmin(userId)) return;
    const teamsCsv = generateTeamsCSV();
    const individualsCsv = generateIndividualsCSV();
    await bot.sendDocument(chatId, Buffer.from(teamsCsv, 'utf8'), { filename: 'jamoalar.csv', contentType: 'text/csv' });
    await bot.sendDocument(chatId, Buffer.from(individualsCsv, 'utf8'), { filename: 'yakkalar.csv', contentType: 'text/csv' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_toggle_registration') {
    if (!isAdmin(userId)) return;
    db.registrationOpen = !db.registrationOpen;
    await saveDB();
    const status = db.registrationOpen ? "ochiq" : "yopiq";
    await bot.sendMessage(chatId, `📌 Ro'yxatga olish ${status}.`);
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'admin_upload_employees') {
    if (!isAdmin(userId)) return;
    userSessions.set(chatId, { step: 'awaiting_csv' });
    await bot.sendMessage(chatId, "📂 Iltimos, quyidagi formatdagi CSV faylni yuboring:\n\n`t/r, Ism, Lavozim, Bo'lim`\nMisol:\n1, Alijon Valiyev, Muhandis, Mexanika\n2, Bahrom Karimov, Texnik, Mexanika", { parse_mode: 'Markdown' });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Bo‘lim tanlash (sardor yoki a'zo)
  if (data.startsWith('dept_')) {
    const parts = data.split('_');
    const action = parts[1];
    const department = parts.slice(2).join('_');
    const session = userSessions.get(chatId);
    if (!session || session.step !== action) {
      await bot.sendMessage(chatId, "Iltimos, avval 'Jamoa yaratish' tugmasini bosing.");
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
      await bot.sendMessage(chatId, "Bu bo'limda mavjud xodimlar yo'q yoki ular allaqachon band.");
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    const employeeButtons = availableEmps.map(emp => ([{
      text: `${emp.name} (${emp.position || 'lavozimsiz'})`,
      callback_data: `emp_${action}_${emp.id}`
    }]));
    employeeButtons.push([{ text: "⬅️ Orqaga", callback_data: "back_departments" }]);
    await bot.sendMessage(chatId, `"${department}" bo'limidagi xodimlardan birini tanlang:`, {
      reply_markup: { inline_keyboard: employeeButtons }
    });
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Xodim tanlash
  if (data.startsWith('emp_')) {
    const parts = data.split('_');
    const action = parts[1];
    const employeeId = parseInt(parts[2]);
    const session = userSessions.get(chatId);
    if (!session || session.step !== action) {
      await bot.sendMessage(chatId, "Vaqt tugadi yoki jarayon to‘xtatilgan. Qaytadan urinib ko‘ring.");
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
      const teamData = session.teamCreationData;
      if (teamData.members.includes(employeeId)) {
        await bot.sendMessage(chatId, "Bu xodim allaqachon tanlangan.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      teamData.members.push(employeeId);
      if (teamData.members.length === 5) {
        session.step = 'awaiting_phone';
        await bot.sendMessage(chatId, "✅ Barcha 5 a'zo tanlandi. Endi jamoa sardorining telefon raqamini kiriting:\nMasalan: +998901234567");
      } else {
        await askNextMember(chatId, session);
      }
    }
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  if (data === 'back_departments') {
    const session = userSessions.get(chatId);
    if (session && (session.step === 'captain' || session.step === 'member')) {
      await askDepartment(chatId, session.step, {});
    } else {
      await bot.sendMessage(chatId, "Noma'lum holat.");
    }
    return bot.answerCallbackQuery(callbackQuery.id);
  }

  // Yakka ro‘yxat uchun callback (bo‘lim tanlash)
  if (data.startsWith('dept_individual_')) {
    const department = data.split('_')[2];
    const availableEmps = getAvailableEmployeesByDepartment(department, []);
    if (availableEmps.length === 0) {
      await bot.sendMessage(chatId, "Bu bo'limda mavjud xodim yo'q.");
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    const empButtons = availableEmps.map(emp => ([{ text: emp.name, callback_data: `ind_emp_${emp.id}` }]));
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
    const session = userSessions.get(chatId);
    if (session && session.step === 'individual') {
      await askDepartment(chatId, 'individual');
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

  // Admin CSV yuklash jarayoni
  const session = userSessions.get(chatId);
  if (session && session.step === 'awaiting_csv' && msg.document) {
    if (!isAdmin(userId)) return;
    try {
      const fileId = msg.document.file_id;
      const fileLink = await bot.getFile(fileId);
      const fileBuffer = await downloadFile(fileLink.file_path);
      const count = await updateEmployeesFromCSV(fileBuffer);
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
    userSessions.set(chatId, { step: 'individual', userId });
    return askDepartment(chatId, 'individual');
  }

  if (text === "ℹ️ Yordam") {
    return bot.sendMessage(chatId, "📌 **Yordam**\n\nJamoa yaratish: 5 kishidan iborat jamoa tuzasiz (sardor + 4 a'zo).\nYakka ro'yxat: faqat o'zingizni ro'yxatdan o'tkazasiz, keyin admin sizni guruhga joylaydi.\n\nAdmin: /admin buyrug‘i.\nMening jamoam: o‘z jamoangizning arizasini yuklab olish.", { parse_mode: 'Markdown' });
  }

  if (text === "📄 Mening jamoam") {
    const userTeam = db.teams.find(team => team.createdBy === userId);
    if (!userTeam) {
      return bot.sendMessage(chatId, "Siz hali hech qanday jamoa yaratmagansiz yoki jamoangiz topilmadi.");
    }
    const pdfBuffer = await generateApplicationPDF(userTeam, userTeam.phoneNumber);
    return bot.sendDocument(chatId, pdfBuffer, {
      filename: `Zakovat_Ariza_${userTeam.teamName.replace(/\s/g, '_')}.pdf`,
      contentType: 'application/pdf',
      caption: `📄 Sizning jamoangiz arizasi: ${userTeam.teamName}`
    });
  }

  // JAMOA NOMINI QABUL QILISH
  if (session && session.step === 'awaiting_team_name') {
    if (text.length > 50) return bot.sendMessage(chatId, "Jamoa nomi 50 belgidan oshmasligi kerak.");
    session.teamCreationData.teamName = text;
    session.step = 'captain';
    await bot.sendMessage(chatId, "Endi jamoa sardorini tanlang (bo'lim orqali):");
    await askDepartment(chatId, 'captain', {});
    return;
  }

  // TELEFON RAQAMNI QABUL QILISH
  if (session && session.step === 'awaiting_phone') {
    const phoneRegex = /^\+998[0-9]{9}$|^[0-9]{9}$/;
    if (!phoneRegex.test(text)) {
      return bot.sendMessage(chatId, "❌ Noto‘g‘ri format. Iltimos, telefon raqamni +998901234567 yoki 901234567 ko‘rinishida kiriting.");
    }
    let phone = text;
    if (!phone.startsWith('+')) phone = '+998' + phone.slice(-9);
    await finalizeTeam(chatId, userId, session.teamCreationData, phone);
    return;
  }

  // /cancel
  if (text === '/cancel') {
    if (userSessions.has(chatId)) {
      userSessions.delete(chatId);
      await bot.sendMessage(chatId, "Jarayon bekor qilindi.", getMainMenuKeyboard());
    } else {
      await bot.sendMessage(chatId, "Hech qanday faol jarayon yo'q.");
    }
    return;
  }
});

// /admin buyrug'i
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
        [{ text: db.registrationOpen ? "🔒 Ro'yxatni yopish" : "🔓 Ro'yxatni ochish", callback_data: "admin_toggle_registration" }],
        [{ text: "📂 Xodimlarni CSV dan yuklash", callback_data: "admin_upload_employees" }]
      ]
    }
  };
  await bot.sendMessage(chatId, "🔧 Admin paneli:", adminButtons);
});

// -------------------- YORDAMCHI FUNKSIYA: faylni yuklab olish --------------------
async function downloadFile(filePath) {
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const response = await fetch(url);
  return Buffer.from(await response.arrayBuffer());
}

// -------------------- EXPRESS SERVER (Railway uchun) --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda`));

// -------------------- BOTNI ISHGA TUSHIRISH --------------------
async function init() {
  await loadData();
  console.log('Bot ishga tushdi...');
}
init();
