const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');

// -------------------- KONFIGURATSIYA --------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('❌ BOT_TOKEN topilmadi!');
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
const userSessions = new Map();

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
  } catch {
    employees = { employees: [] };
    await saveEmployees();
  }
}

async function saveDB() {
  await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

async function saveEmployees() {
  await fs.writeFile(EMPLOYEES_PATH, JSON.stringify(employees, null, 2), 'utf8');
}

function isEmployeeAvailable(employeeId) {
  const inTeam = db.teams.some(team => team.members.includes(employeeId));
  const inIndividual = db.individuals.some(ind => ind.employeeId === employeeId);
  return !inTeam && !inIndividual;
}

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
  return `${idx+1}. ${team.teamName}\n   Sardor: ${captainName}\n   A'zolar: ${memberNames}`;
}

function formatIndividuals() {
  if (db.individuals.length === 0) return "Yakka ro'yxat bo'sh.";
  return db.individuals.map((ind, i) => {
    const emp = employees.employees.find(e => e.id === ind.employeeId);
    return `${i+1}. ${emp ? emp.name : 'Noma\'lum'} (${emp ? emp.department : ''})`;
  }).join('\n');
}

// -------------------- CSV GENERATSIYA (to'g'ri formatda) --------------------
function generateTeamsCSV() {
  let csv = "Jamoa nomi,Sardor,A'zolar (5 kishi)\n";
  if (db.teams.length > 0) {
    csv += db.teams.map(team => {
      const captainName = getEmployeeName(team.captainId);
      const members = team.members.map(m => getEmployeeName(m)).join(';');
      return `"${team.teamName}","${captainName}","${members}"`;
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

// -------------------- PDF ARIZA --------------------
async function generateApplicationPDF(team) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(18).font('Helvetica-Bold').text('SAM AUTO ZAKOVAT TURNIRI', { align: 'center' });
    doc.moveDown(0.5);
    doc.fontSize(16).text('QATNASHISH UCHUN ARIZA', { align: 'center' });
    doc.moveDown(1.5);

    doc.fontSize(12).font('Helvetica-Bold');
    doc.text(`Jamoa nomi: ${team.teamName}`, { underline: true });
    doc.moveDown(0.5);
    doc.text(`Sardor: ${getEmployeeName(team.captainId)}`);
    doc.text(`A'zolar soni: ${team.members.length} nafar`);
    doc.moveDown(1);

    const startY = doc.y;
    doc.font('Helvetica-Bold');
    doc.text('№', 50, startY);
    doc.text('F.I.SH.', 80, startY);
    doc.text('Lavozim', 250, startY);
    doc.text('Bo‘lim/Tsex', 350, startY);
    doc.text('Imzo', 450, startY);
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    
    let currentY = doc.y;
    doc.font('Helvetica');
    
    for (let i = 0; i < team.members.length; i++) {
      const empId = team.members[i];
      doc.text(`${i+1}`, 50, currentY + 5);
      doc.text(getEmployeeName(empId), 80, currentY + 5, { width: 160 });
      doc.text(getEmployeePosition(empId) || '—', 250, currentY + 5, { width: 90 });
      doc.text(getEmployeeDepartment(empId) || '—', 350, currentY + 5, { width: 90 });
      doc.text('__________', 450, currentY + 5);
      currentY += 25;
      if (currentY > 700) {
        doc.addPage();
        currentY = 50;
        doc.font('Helvetica-Bold');
        doc.text('№', 50, currentY);
        doc.text('F.I.SH.', 80, currentY);
        doc.text('Lavozim', 250, currentY);
        doc.text('Bo‘lim/Tsex', 350, currentY);
        doc.text('Imzo', 450, currentY);
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        currentY = doc.y;
        doc.font('Helvetica');
      }
    }
    
    doc.moveDown(2);
    doc.font('Helvetica-Bold');
    doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ', { day: '2-digit', month: '2-digit', year: 'numeric' })}`, { align: 'right' });
    doc.moveDown(0.5);
    doc.text('Sardor imzosi: _______________', { align: 'right' });
   
    
    doc.end();
  });
}

// -------------------- XODIMLARNI CSV DAN YUKLASH --------------------
async function updateEmployeesFromCSV(fileBuffer) {
  let content = fileBuffer.toString('utf8');
  // BOM ni olib tashlash
  if (content.charCodeAt(0) === 0xFEFF) {
    content = content.slice(1);
  }
  
  const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length < 2) throw new Error('CSVda kamida 2 qator bo‘lishi kerak');

  let startIdx = 0;
  const firstLine = lines[0].toLowerCase();
  if (firstLine.includes('ism') || firstLine.includes('name') || firstLine.includes('t/r')) {
    startIdx = 1;
  }

  const newEmployees = [];
  let newId = 1;
  
  for (let i = startIdx; i < lines.length; i++) {
    const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
    if (parts.length < 4) continue;
    
    const name = parts[1];
    const position = parts[2];
    const department = parts[3];
    if (!name || !department) continue;
    
    newEmployees.push({ 
      id: newId++, 
      name: name, 
      position: position || '', 
      department: department 
    });
  }
  
  if (newEmployees.length === 0) throw new Error('Hech qanday xodim topilmadi');
  
  // Eski xodimlar ID larini yangilari bilan almashtirish
  const oldToNewId = new Map();
  for (let i = 0; i < employees.employees.length && i < newEmployees.length; i++) {
    if (employees.employees[i] && newEmployees[i]) {
      oldToNewId.set(employees.employees[i].id, newEmployees[i].id);
    }
  }
  
  for (const team of db.teams) {
    if (oldToNewId.has(team.captainId)) {
      team.captainId = oldToNewId.get(team.captainId);
    }
    team.members = team.members.map(mid => oldToNewId.has(mid) ? oldToNewId.get(mid) : mid);
  }
  
  for (const ind of db.individuals) {
    if (oldToNewId.has(ind.employeeId)) {
      ind.employeeId = oldToNewId.get(ind.employeeId);
    }
  }
  
  employees.employees = newEmployees;
  await saveEmployees();
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
      resize_keyboard: true
    }
  };
}

// -------------------- JAMOA YARATISH --------------------
async function askDepartment(chatId, action) {
  const departments = getDepartments();
  if (departments.length === 0) {
    await bot.sendMessage(chatId, "❌ Hech qanday bo‘lim mavjud emas. Admin xodimlarni yuklamagan.");
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
  const need = 5 - teamCreationData.members.length;
  if (need === 0) {
    await finalizeTeam(chatId, session.userId, teamCreationData);
    return;
  }
  await bot.sendMessage(chatId, `🔄 Hozircha ${teamCreationData.members.length} ta a'zo. Yana ${need} ta kerak. A'zo qo'shish uchun bo'limni tanlang:`);
  await askDepartment(chatId, 'member');
}

async function finalizeTeam(chatId, userId, teamData) {
  const { teamName, captainId, members } = teamData;
  
  for (const empId of members) {
    if (!isEmployeeAvailable(empId)) {
      await bot.sendMessage(chatId, `❌ Xodim ${getEmployeeName(empId)} endi band. Qaytadan boshlang.`);
      userSessions.delete(chatId);
      return false;
    }
  }
  
  const newTeam = {
    teamId: Date.now(),
    teamName,
    captainId,
    members,
    createdBy: userId,
    createdAt: new Date().toISOString()
  };
  
  db.teams.push(newTeam);
  await saveDB();
  
  const pdfBuffer = await generateApplicationPDF(newTeam);
  await bot.sendDocument(chatId, pdfBuffer, {
    filename: `ariya_${Date.now()}.pdf`,
    contentType: 'application/pdf',
    caption: `✅ "${teamName}" jamoasi ro‘yxatdan o‘tdi!`
  });
  
  await bot.sendMessage(chatId, "Arizani yuklab oldingiz. Omad!", getMainMenuKeyboard());
  userSessions.delete(chatId);
  return true;
}

// -------------------- BOT HANDLERLARI --------------------
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, "Assalomu alaykum! Zakovat o'yinida ro'yxatdan o'tishga xush kelibsiz.", getMainMenuKeyboard());
});

bot.onText(/\/admin/, async (msg) => {
  const chatId = msg.chat.id;
  if (!ADMIN_IDS.includes(msg.from.id)) {
    return bot.sendMessage(chatId, "⛔ Faqat adminlar.");
  }
  
  const adminButtons = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 Jamoalar", callback_data: "admin_view_teams" }],
        [{ text: "👤 Yakkalar", callback_data: "admin_view_individuals" }],
        [{ text: "📁 Jamoalar CSV", callback_data: "admin_export_teams" }],
        [{ text: "📁 Yakkalar CSV", callback_data: "admin_export_individuals" }],
        [{ text: "📁 JSON", callback_data: "admin_export_json" }],
        [{ text: "🎲 Tasodifiy", callback_data: "admin_random_teams" }],
        [{ text: db.registrationOpen ? "🔒 Yopish" : "🔓 Ochish", callback_data: "admin_toggle_registration" }],
        [{ text: "📂 Xodimlar CSV", callback_data: "admin_upload_employees" }]
      ]
    }
  };
  await bot.sendMessage(chatId, "🔧 Admin paneli:", adminButtons);
});

bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  if (userSessions.has(chatId)) {
    userSessions.delete(chatId);
    bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
  }
});

// -------------------- CALLBACK QUERY --------------------
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id;
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  const session = userSessions.get(chatId);

  try {
    if (data === 'cancel') {
      userSessions.delete(chatId);
      await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
      return bot.answerCallbackQuery(callbackQuery.id);
    }

    // ADMIN
    if (ADMIN_IDS.includes(userId)) {
      if (data === 'admin_view_teams') {
        let msg = db.teams.length ? "📋 Jamoalar:\n\n" + db.teams.map((t, i) => formatTeam(t, i)).join('\n\n') : "Hech qanday jamoa yo'q.";
        await bot.sendMessage(chatId, msg);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (data === 'admin_view_individuals') {
        await bot.sendMessage(chatId, `👤 Yakkalar:\n${formatIndividuals()}`);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (data === 'admin_export_teams') {
        try {
          await bot.sendMessage(chatId, "⏳ CSV tayyor...");
          const csv = generateTeamsCSV();
          // To'g'ri buffer yaratish
          const buffer = Buffer.from(csv, 'utf-8');
          await bot.sendDocument(chatId, buffer, { 
            filename: 'jamoalar.csv', 
            contentType: 'text/csv; charset=utf-8' 
          });
          await bot.sendMessage(chatId, `✅ ${db.teams.length} ta jamoa eksport qilindi.`);
        } catch (err) {
          console.error('CSV xatosi:', err);
          await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
        }
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (data === 'admin_export_individuals') {
        try {
          const csv = generateIndividualsCSV();
          const buffer = Buffer.from(csv, 'utf-8');
          await bot.sendDocument(chatId, buffer, { 
            filename: 'yakkalar.csv', 
            contentType: 'text/csv; charset=utf-8' 
          });
          await bot.sendMessage(chatId, `✅ ${db.individuals.length} ta yakka eksport qilindi.`);
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
        }
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (data === 'admin_export_json') {
        try {
          const jsonData = JSON.stringify(db.teams, null, 2);
          const buffer = Buffer.from(jsonData, 'utf-8');
          await bot.sendDocument(chatId, buffer, { 
            filename: 'jamoalar.json', 
            contentType: 'application/json' 
          });
          await bot.sendMessage(chatId, "✅ JSON yuklab olindi.");
        } catch (err) {
          await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
        }
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (data === 'admin_random_teams') {
        if (db.individuals.length < 5) {
          await bot.sendMessage(chatId, "❌ Kamida 5 yakka kerak.");
          return bot.answerCallbackQuery(callbackQuery.id);
        }
        
        const shuffled = [...db.individuals].sort(() => Math.random() - 0.5);
        const newTeams = [];
        const used = new Set();
        
        for (let i = 0; i + 5 <= shuffled.length; i += 5) {
          const group = shuffled.slice(i, i + 5).map(x => x.employeeId);
          newTeams.push({
            teamId: Date.now() + i,
            teamName: `Random ${Math.floor(i / 5) + 1}`,
            captainId: group[0],
            members: group,
            createdBy: userId,
            createdAt: new Date().toISOString()
          });
          group.forEach(id => used.add(id));
        }
        
        db.teams.push(...newTeams);
        db.individuals = db.individuals.filter(ind => !used.has(ind.employeeId));
        await saveDB();
        await bot.sendMessage(chatId, `🎉 ${newTeams.length} ta jamoa yaratildi. Qolgan: ${db.individuals.length}`);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (data === 'admin_toggle_registration') {
        db.registrationOpen = !db.registrationOpen;
        await saveDB();
        await bot.sendMessage(chatId, `Ro'yxat ${db.registrationOpen ? "ochiq" : "yopiq"}.`);
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (data === 'admin_upload_employees') {
        userSessions.set(chatId, { step: 'awaiting_csv' });
        await bot.sendMessage(chatId, "📂 CSV faylni yuboring.\n\nFormat: t/r, Ism, Lavozim, Bo'lim");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
    }

    // JAMOA YARATISH
    if (data.startsWith('dept_')) {
      const parts = data.split('_');
      const action = parts[1];
      const department = parts.slice(2).join('_');
      
      if (!session || session.step !== action) {
        await bot.sendMessage(chatId, "Avval 'Jamoa yaratish' tugmasini bosing.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      const excludeIds = (action === 'member') ? session.teamCreationData.members : [];
      const available = getAvailableEmployeesByDepartment(department, excludeIds);
      
      if (available.length === 0) {
        await bot.sendMessage(chatId, "Bu bo'limda mavjud xodim yo'q.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      const empButtons = available.map(emp => ([{
        text: `${emp.name} (${emp.position || '-'})`,
        callback_data: `emp_${action}_${emp.id}`
      }]));
      empButtons.push([{ text: "⬅️ Orqaga", callback_data: "back_departments" }]);
      
      await bot.sendMessage(chatId, `"${department}" bo'limidan tanlang:`, {
        reply_markup: { inline_keyboard: empButtons }
      });
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    
    if (data.startsWith('emp_')) {
      const parts = data.split('_');
      const action = parts[1];
      const employeeId = parseInt(parts[2]);
      
      if (!session || session.step !== action) {
        await bot.sendMessage(chatId, "Vaqt tugadi. Qaytadan boshlang.");
        return bot.answerCallbackQuery(callbackQuery.id);
      }
      
      if (!isEmployeeAvailable(employeeId)) {
        await bot.sendMessage(chatId, `❌ ${getEmployeeName(employeeId)} band.`);
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
          await bot.sendMessage(chatId, "Bu xodim oldin tanlangan.");
          return bot.answerCallbackQuery(callbackQuery.id);
        }
        session.teamCreationData.members.push(employeeId);
        await askNextMember(chatId, session);
      }
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    
    if (data === 'back_departments') {
      if (session && (session.step === 'captain' || session.step === 'member')) {
        await askDepartment(chatId, session.step);
      }
      return bot.answerCallbackQuery(callbackQuery.id);
    }
    
    // YAKKA RO'YXAT
    if (data.startsWith('dept_individual_')) {
      const department = data.split('_')[2];
      
      if (!session || session.step !== 'individual') {
        await bot.sendMessage(chatId, "Avval 'Yakka ro'yxat' tugmasini bosing.");
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
      await bot.sendMessage(chatId, "✅ Yakka ro'yxatga olindingiz.", getMainMenuKeyboard());
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
    console.error('Xatolik:', err);
    await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
  }
  bot.answerCallbackQuery(callbackQuery.id);
});

// -------------------- MATNLI XABARLAR --------------------
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;
  const userId = msg.from.id;
  const session = userSessions.get(chatId);

  // Admin CSV yuklash
  if (session && session.step === 'awaiting_csv' && msg.document) {
    if (!ADMIN_IDS.includes(userId)) return;
    try {
      await bot.sendMessage(chatId, "⏳ Xodimlar yuklanmoqda...");
      const file = await bot.getFile(msg.document.file_id);
      const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const response = await fetch(url);
      const buffer = Buffer.from(await response.arrayBuffer());
      const count = await updateEmployeesFromCSV(buffer);
      await bot.sendMessage(chatId, `✅ ${count} ta xodim yangilandi. Jamoalar saqlanib qoldi.`);
    } catch (err) {
      await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
    }
    userSessions.delete(chatId);
    return;
  }

  if (text === "👥 Jamoa yaratish") {
    if (!db.registrationOpen) return bot.sendMessage(chatId, "❌ Ro'yxat yopilgan.");
    if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
    userSessions.set(chatId, {
      step: 'awaiting_team_name',
      teamCreationData: { teamName: '', captainId: null, members: [] },
      userId
    });
    return bot.sendMessage(chatId, "Jamoa nomini kiriting:");
  }
  
  if (text === "👤 Yakka ro'yxat") {
    if (!db.registrationOpen) return bot.sendMessage(chatId, "Ro'yxat yopilgan.");
    if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
    userSessions.set(chatId, { step: 'individual', userId });
    return askDepartment(chatId, 'individual');
  }
  
  if (text === "📄 Mening jamoam") {
    const userTeam = db.teams.find(team => team.createdBy === userId);
    if (!userTeam) return bot.sendMessage(chatId, "Siz jamoa yaratmagansiz.");
    try {
      const pdfBuffer = await generateApplicationPDF(userTeam);
      await bot.sendDocument(chatId, pdfBuffer, {
        filename: `ariya_${userTeam.teamId}.pdf`,
        contentType: 'application/pdf',
        caption: `📄 "${userTeam.teamName}" jamoasi arizasi`
      });
    } catch (err) {
      await bot.sendMessage(chatId, `❌ PDF xatolik: ${err.message}`);
    }
    return;
  }
  
  if (text === "ℹ️ Yordam") {
    return bot.sendMessage(chatId, "📌 Jamoa: 5 a'zo | Yakka: admin guruhlaydi | Mening jamoam: PDF");
  }
  
  if (session && session.step === 'awaiting_team_name') {
    if (text.length > 50) return bot.sendMessage(chatId, "Nomi 50 belgidan oshmasin.");
    session.teamCreationData.teamName = text;
    session.step = 'captain';
    await bot.sendMessage(chatId, "Endi sardorni tanlang:");
    await askDepartment(chatId, 'captain');
  }
});

// -------------------- SERVER --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP ${PORT}`));

// -------------------- BOSHLASH --------------------
loadData().then(() => console.log('✅ Bot ishga tushdi!')).catch(console.error);
