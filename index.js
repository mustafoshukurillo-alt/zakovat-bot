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
const userSessions = new Map(); // { chatId: { step, ... } }

// -------------------- YUKLASH VA SAQLASH --------------------
async function loadData() {
    try {
        const dbRaw = await fs.readFile(DB_PATH, 'utf8');
        db = JSON.parse(dbRaw);
        console.log('✅ db.json yuklandi, jamoalar:', db.teams.length);
    } catch {
        db = { teams: [], individuals: [], registrationOpen: true };
        await saveDB();
    }
    try {
        const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
        employees = JSON.parse(empRaw);
        if (!employees.employees) employees.employees = [];
        console.log('✅ employees.json yuklandi, xodimlar soni:', employees.employees.length);
    } catch (err) {
        console.error('employees.json yuklashda xatolik:', err.message);
        employees = { employees: [] };
        await saveEmployees();
    }
}
async function saveDB() { await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }
async function saveEmployees() { await fs.writeFile(EMPLOYEES_PATH, JSON.stringify(employees, null, 2), 'utf8'); }

// -------------------- XODIMLAR BILAN ISHLASH --------------------
function isEmployeeAvailable(employeeId) {
    const inTeam = db.teams.some(team => team.members.includes(employeeId));
    const inIndividual = db.individuals.some(ind => ind.employeeId === employeeId);
    return !inTeam && !inIndividual;
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
function getDepartments() {
    const deps = new Set(employees.employees.map(e => e.department));
    return Array.from(deps);
}

// -------------------- QIDIRUV FUNKSIYASI --------------------
function searchEmployees(department, query, excludeIds = []) {
    const lowerQuery = query.toLowerCase();
    return employees.employees.filter(emp =>
        emp.department === department &&
        emp.name.toLowerCase().includes(lowerQuery) &&
        isEmployeeAvailable(emp.id) &&
        !excludeIds.includes(emp.id)
    );
}

// -------------------- FORMATLASH (Admin HTML) --------------------
function formatTeamsHTML() {
    if (db.teams.length === 0) return "<i>Hech qanday jamoa yo‘q</i>";
    let html = "<b>📋 Jamoalar ro‘yxati</b>\n\n";
    db.teams.forEach((team, idx) => {
        html += `<b>${idx+1}. ${escapeHtml(team.teamName)}</b>\n`;
        html += `   🧑‍💼 Sardor: <b>${escapeHtml(getEmployeeName(team.captainId))}</b>\n`;
        html += `   👥 A'zolar: ${team.members.map(m => escapeHtml(getEmployeeName(m))).join(', ')}\n`;
        html += `   🆔 ID: ${team.teamId}\n`;
        html += `   📅 Yaratilgan: ${new Date(team.createdAt).toLocaleString('uz-UZ')}\n\n`;
    });
    return html;
}
function formatIndividualsHTML() {
    if (db.individuals.length === 0) return "<i>Yakka ro‘yxat bo‘sh</i>";
    let html = "<b>👤 Yakka ro‘yxat</b>\n\n";
    db.individuals.forEach((ind, i) => {
        const emp = employees.employees.find(e => e.id === ind.employeeId);
        html += `${i+1}. ${emp ? escapeHtml(emp.name) : 'Noma\'lum'} (${emp ? escapeHtml(emp.department) : ''})\n`;
    });
    return html;
}
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>]/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[m]));
}

// -------------------- CSV GENERATSIYA --------------------
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
function generateAllApplicationsCSV() {
    let csv = "Jamoa nomi,Sardor,A'zo nomi,A'zo lavozimi,A'zo bo'limi,Rol,Sana\n";
    for (const team of db.teams) {
        const captainName = getEmployeeName(team.captainId);
        const createdDate = new Date(team.createdAt).toLocaleDateString('uz-UZ');
        csv += `"${team.teamName}","${captainName}","${captainName}","${getEmployeePosition(team.captainId)}","${getEmployeeDepartment(team.captainId)}","Sardor","${createdDate}"\n`;
        for (const memberId of team.members) {
            if (memberId === team.captainId) continue;
            csv += `"${team.teamName}","${captainName}","${getEmployeeName(memberId)}","${getEmployeePosition(memberId)}","${getEmployeeDepartment(memberId)}","A'zo","${createdDate}"\n`;
        }
    }
    return csv;
}

// -------------------- VAQTINCHALIK FAYL ORQALI YUBORISH --------------------
async function sendFileFromString(chatId, content, filename, mimeType) {
    const tempFilePath = path.join(__dirname, `temp_${Date.now()}_${filename}`);
    try {
        await fs.writeFile(tempFilePath, content, 'utf8');
        const fileStream = require('fs').createReadStream(tempFilePath);
        await bot.sendDocument(chatId, fileStream, { filename, contentType: mimeType });
    } finally {
        try { await fs.unlink(tempFilePath); } catch(e) {}
    }
}

// -------------------- PDF ARIZA --------------------
async function generateApplicationPDF(team) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.fontSize(18).text('SAM AUTO ZAKOVAT TURNIRI', { align: 'center' });
        doc.moveDown(0.5).fontSize(16).text('QATNASHISH UCHUN ARIZA', { align: 'center' });
        doc.moveDown(1.5);
        doc.fontSize(12).text(`Jamoa nomi: ${team.teamName}`, { underline: true });
        doc.text(`Sardor: ${getEmployeeName(team.captainId)}`);
        doc.text(`A'zolar soni: ${team.members.length} nafar`);
        doc.moveDown(1);
        let y = doc.y;
        doc.font('Helvetica-Bold');
        doc.text('№', 50, y); doc.text('F.I.SH.', 80, y); doc.text('Lavozim', 250, y); doc.text('Bo‘lim/Tsex', 350, y); doc.text('Imzo', 450, y);
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        let currentY = doc.y;
        doc.font('Helvetica');
        for (let i = 0; i < team.members.length; i++) {
            const empId = team.members[i];
            doc.text(`${i+1}`, 50, currentY+5);
            doc.text(getEmployeeName(empId), 80, currentY+5, { width: 160 });
            doc.text(getEmployeePosition(empId) || '—', 250, currentY+5, { width: 90 });
            doc.text(getEmployeeDepartment(empId) || '—', 350, currentY+5, { width: 90 });
            doc.text('__________', 450, currentY+5);
            currentY += 25;
            if (currentY > 700) { doc.addPage(); currentY = 50; /* ... */ }
        }
        doc.moveDown(2);
        doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, { align: 'right' });
        doc.text('Sardor imzosi:       ____________________', { align: 'right' });
        
        doc.end();
    });
}

// -------------------- XODIMLARNI CSV DAN YANGILASH --------------------
async function updateEmployeesFromCSV(fileBuffer) {
    let content = fileBuffer.toString('utf8');
    if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1);
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length < 2) throw new Error('CSVda kamida 2 qator bo‘lishi kerak');
    let startIdx = 0;
    const firstLine = lines[0].toLowerCase();
    if (firstLine.includes('ism') || firstLine.includes('name') || firstLine.includes('t/r')) startIdx = 1;
    const newEmployees = [];
    let newId = 1;
    for (let i = startIdx; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim().replace(/^"|"$/g, ''));
        if (parts.length < 4) continue;
        const name = parts[1], position = parts[2], department = parts[3];
        if (!name || !department) continue;
        newEmployees.push({ id: newId++, name, position: position || '', department });
    }
    if (newEmployees.length === 0) throw new Error('Hech qanday xodim topilmadi');
    // ID larni qayta moslash (eski jamoalarni yangilash)
    const oldToNewId = new Map();
    for (let i = 0; i < employees.employees.length && i < newEmployees.length; i++) {
        if (employees.employees[i] && newEmployees[i]) oldToNewId.set(employees.employees[i].id, newEmployees[i].id);
    }
    for (const team of db.teams) {
        if (oldToNewId.has(team.captainId)) team.captainId = oldToNewId.get(team.captainId);
        team.members = team.members.map(mid => oldToNewId.has(mid) ? oldToNewId.get(mid) : mid);
    }
    for (const ind of db.individuals) {
        if (oldToNewId.has(ind.employeeId)) ind.employeeId = oldToNewId.get(ind.employeeId);
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
                [{ text: "👥 Jamoani ro'yxatga olish" }], 
                [{ text: "👤 Individual ro'yxatga olish" }],
                [{ text: "📄 Mening jamoam" }, { text: "ℹ️ Yordam" }]
            ],
            resize_keyboard: true
        }
    };
}

// -------------------- JAMOA YARATISH (QIDIRUV BILAN) --------------------
async function askDepartment(chatId, action, context = {}) {
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

async function askSearchName(chatId, action, department, excludeIds) {
    userSessions.set(chatId, {
        step: 'awaiting_search',
        action: action,
        department: department,
        excludeIds: excludeIds,
        searchPage: 0,
        lastQuery: ''
    });
    await bot.sendMessage(chatId, "🔍 Xodim ismining kamida 3 harfini kiriting (masalan: 'Abdu'):");
}

async function performSearch(chatId, session, query, page = 0) {
    const { action, department, excludeIds } = session;
    if (query.length < 3) {
        await bot.sendMessage(chatId, "❌ Iltimos, kamida 3 harf kiriting.");
        return;
    }
    const results = searchEmployees(department, query, excludeIds);
    if (results.length === 0) {
        await bot.sendMessage(chatId, "❌ Hech qanday xodim topilmadi. Qaytadan kiriting yoki /cancel.");
        return;
    }
    const pageSize = 20;
    const totalPages = Math.ceil(results.length / pageSize);
    if (page >= totalPages) page = totalPages - 1;
    if (page < 0) page = 0;
    const start = page * pageSize;
    const end = start + pageSize;
    const pageResults = results.slice(start, end);
    const buttons = pageResults.map(emp => ([{ text: emp.name, callback_data: `emp_${action}_${emp.id}` }]));
    if (totalPages > 1) {
        const navButtons = [];
        if (page > 0) navButtons.push({ text: "⬅️ Oldingi", callback_data: `search_page_${page-1}_${query}` });
        if (page < totalPages-1) navButtons.push({ text: "Keyingi ➡️", callback_data: `search_page_${page+1}_${query}` });
        if (navButtons.length) buttons.push(navButtons);
    }
    buttons.push([{ text: "🔄 Qayta qidirish", callback_data: "search_again" }, { text: "❌ Bekor qilish", callback_data: "cancel" }]);
    await bot.sendMessage(chatId, `🔎 "${query}" bo‘yicha ${results.length} ta xodim topildi (${page+1}/${totalPages}):`, {
        reply_markup: { inline_keyboard: buttons }
    });
    session.searchPage = page;
    session.lastQuery = query;
}

// -------------------- JAMOANI YAKUNLASH --------------------
async function finalizeTeam(chatId, userId, teamData) {
    const { teamName, captainId, members } = teamData;
    for (const empId of members) {
        if (!isEmployeeAvailable(empId)) {
            await bot.sendMessage(chatId, `❌ Xodim ${getEmployeeName(empId)} endi band. Qaytadan boshlang.`);
            userSessions.delete(chatId);
            return false;
        }
    }
    const newTeam = { teamId: Date.now(), teamName, captainId, members, createdBy: userId, createdAt: new Date().toISOString() };
    db.teams.push(newTeam);
    await saveDB();
    const pdfBuffer = await generateApplicationPDF(newTeam);
    await bot.sendDocument(chatId, pdfBuffer, { filename: `ariya_${newTeam.teamId}.pdf`, contentType: 'application/pdf', caption: `✅ "${teamName}" jamoasi ro‘yxatdan o‘tdi!` });
    await bot.sendMessage(chatId, "Arizani yuklab oldingiz. Turnirda omad!", getMainMenuKeyboard());
    userSessions.delete(chatId);
    return true;
}

// -------------------- BOT HANDLERLARI --------------------
bot.onText(/\/start/, (msg) => bot.sendMessage(msg.chat.id, "Assalomu alaykum! Zakovat o'yiniga xush kelibsiz.", getMainMenuKeyboard()));
bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(chatId, "⛔ Faqat adminlar.");
    const adminButtons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 Jamoalar", callback_data: "admin_view_teams" }, { text: "👤 Yakkalar", callback_data: "admin_view_individuals" }],
                [{ text: "📁 Jamoalar CSV", callback_data: "admin_export_teams" }, { text: "📁 Yakkalar CSV", callback_data: "admin_export_individuals" }],
                [{ text: "📁 Arizalar CSV", callback_data: "admin_export_applications" }, { text: "📁 JSON", callback_data: "admin_export_json" }],
                [{ text: "🎲 Tasodifiy jamoalar", callback_data: "admin_random_teams" }, { text: db.registrationOpen ? "🔒 Yopish" : "🔓 Ochish", callback_data: "admin_toggle_registration" }],
                [{ text: "📂 Xodimlarni CSV dan yuklash", callback_data: "admin_upload_employees" }]
            ]
        }
    };
    await bot.sendMessage(chatId, "🔧 Admin paneli:", adminButtons);
});
bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    if (userSessions.has(chatId)) userSessions.delete(chatId);
    bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
});

// -------------------- CALLBACK QUERY --------------------
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const session = userSessions.get(chatId);
    try {
        if (data === 'cancel') {
            userSessions.delete(chatId);
            await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
            return bot.answerCallbackQuery(query.id);
        }
        // Admin
        if (ADMIN_IDS.includes(userId)) {
            if (data === 'admin_view_teams') return bot.sendMessage(chatId, formatTeamsHTML(), { parse_mode: 'HTML' }) && bot.answerCallbackQuery(query.id);
            if (data === 'admin_view_individuals') return bot.sendMessage(chatId, formatIndividualsHTML(), { parse_mode: 'HTML' }) && bot.answerCallbackQuery(query.id);
            if (data === 'admin_export_teams') {
                await sendFileFromString(chatId, generateTeamsCSV(), 'jamoalar.csv', 'text/csv');
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_export_individuals') {
                await sendFileFromString(chatId, generateIndividualsCSV(), 'yakkalar.csv', 'text/csv');
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_export_applications') {
                await sendFileFromString(chatId, generateAllApplicationsCSV(), 'barcha_arizalar.csv', 'text/csv');
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_export_json') {
                await sendFileFromString(chatId, JSON.stringify(db.teams, null, 2), 'jamoalar.json', 'application/json');
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_random_teams') {
                if (db.individuals.length < 5) return bot.sendMessage(chatId, "❌ Kamida 5 yakka kerak.") && bot.answerCallbackQuery(query.id);
                const shuffled = [...db.individuals].sort(() => Math.random() - 0.5);
                const newTeams = []; const used = new Set();
                for (let i = 0; i+5 <= shuffled.length; i+=5) {
                    const group = shuffled.slice(i,i+5).map(x=>x.employeeId);
                    newTeams.push({ teamId: Date.now()+i, teamName: `Random guruh ${Math.floor(i/5)+1}`, captainId: group[0], members: group, createdBy: userId, createdAt: new Date().toISOString() });
                    group.forEach(id=>used.add(id));
                }
                db.teams.push(...newTeams);
                db.individuals = db.individuals.filter(ind=>!used.has(ind.employeeId));
                await saveDB();
                await bot.sendMessage(chatId, `🎉 ${newTeams.length} ta jamoa yaratildi. Qolgan yakkaliklar: ${db.individuals.length}`);
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_toggle_registration') {
                db.registrationOpen = !db.registrationOpen;
                await saveDB();
                await bot.sendMessage(chatId, `Ro'yxat ${db.registrationOpen ? "ochiq" : "yopiq"}.`);
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_upload_employees') {
                userSessions.set(chatId, { step: 'awaiting_csv' });
                await bot.sendMessage(chatId, "📂 CSV faylni yuboring (format: id,Ism,Lavozim,Bo'lim)");
                return bot.answerCallbackQuery(query.id);
            }
        }
        // Bo'lim tanlash (qidiruvga o'tish)
        if (data.startsWith('dept_')) {
            const parts = data.split('_');
            const action = parts[1];
            const department = parts.slice(2).join('_');
            if (!session || session.step !== action) {
                await bot.sendMessage(chatId, "Iltimos, avval 'Jamoa yaratish' tugmasini bosing.");
                return bot.answerCallbackQuery(query.id);
            }
            const excludeIds = (action === 'member') ? session.teamCreationData.members : [];
            await askSearchName(chatId, action, department, excludeIds);
            return bot.answerCallbackQuery(query.id);
        }
        // Qidiruv natijalaridan tanlash
        if (data.startsWith('emp_')) {
            const parts = data.split('_');
            const action = parts[1];
            const employeeId = parseInt(parts[2]);
            if (!session || session.step !== 'awaiting_search') {
                await bot.sendMessage(chatId, "Vaqt tugadi. Qaytadan boshlang.");
                return bot.answerCallbackQuery(query.id);
            }
            if (!isEmployeeAvailable(employeeId)) {
                await bot.sendMessage(chatId, `❌ ${getEmployeeName(employeeId)} band.`);
                userSessions.delete(chatId);
                return bot.answerCallbackQuery(query.id);
            }
            const teamData = session.teamCreationData;
            if (action === 'captain') {
                teamData.captainId = employeeId;
                teamData.members.push(employeeId);
                session.step = 'member';
                await askDepartment(chatId, 'member');
            } else if (action === 'member') {
                if (teamData.members.includes(employeeId)) {
                    await bot.sendMessage(chatId, "Bu xodim oldin tanlangan.");
                    return bot.answerCallbackQuery(query.id);
                }
                teamData.members.push(employeeId);
                if (teamData.members.length === 5) {
                    await finalizeTeam(chatId, session.userId, teamData);
                } else {
                    await askDepartment(chatId, 'member');
                }
            }
            return bot.answerCallbackQuery(query.id);
        }
        // Qidiruv sahifalash
        if (data.startsWith('search_page_')) {
            const parts = data.split('_');
            const page = parseInt(parts[2]);
            const query = parts.slice(3).join('_');
            if (!session || session.step !== 'awaiting_search') {
                await bot.sendMessage(chatId, "Vaqt tugadi. Qaytadan boshlang.");
                return bot.answerCallbackQuery(query.id);
            }
            await performSearch(chatId, session, query, page);
            return bot.answerCallbackQuery(query.id);
        }
        if (data === 'search_again') {
            if (!session || session.step !== 'awaiting_search') return bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, "🔍 Iltimos, qidiruv so‘zini kiriting (kamida 3 harf):");
            return bot.answerCallbackQuery(query.id);
        }
        // Yakka ro'yxat uchun qidiruv (xuddi shunday)
        if (data.startsWith('dept_individual_')) {
            const department = data.split('_')[2];
            if (!session || session.step !== 'individual') {
                await bot.sendMessage(chatId, "Avval 'Yakka ro'yxat' tugmasini bosing.");
                return bot.answerCallbackQuery(query.id);
            }
            userSessions.set(chatId, { step: 'individual_search', department, userId });
            await bot.sendMessage(chatId, "🔍 O‘zingizni qidirish uchun ismingizning kamida 3 harfini kiriting:");
            return bot.answerCallbackQuery(query.id);
        }
        if (data.startsWith('ind_emp_')) {
            const employeeId = parseInt(data.split('_')[2]);
            if (!session || session.step !== 'individual_search') {
                await bot.sendMessage(chatId, "Vaqt tugadi. Qaytadan boshlang.");
                return bot.answerCallbackQuery(query.id);
            }
            if (!isEmployeeAvailable(employeeId)) {
                await bot.sendMessage(chatId, "Bu xodim allaqachon ro'yxatdan o'tgan.");
                userSessions.delete(chatId);
                return bot.answerCallbackQuery(query.id);
            }
            db.individuals.push({ employeeId, registeredAt: new Date().toISOString(), telegramUserId: userId });
            await saveDB();
            await bot.sendMessage(chatId, "✅ Siz random usulida jamoa tanlashga qabul qilindingiz!", getMainMenuKeyboard());
            userSessions.delete(chatId);
            return bot.answerCallbackQuery(query.id);
        }
    } catch (err) {
        console.error(err);
        await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
    }
    bot.answerCallbackQuery(query.id);
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
        } catch (err) { await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`); }
        userSessions.delete(chatId);
        return;
    }
    // Qidiruv so'rovi (jamoa yaratish)
    if (session && session.step === 'awaiting_search') {
        if (text.length < 3) return bot.sendMessage(chatId, "❌ Kamida 3 harf kiriting.");
        await performSearch(chatId, session, text, 0);
        return;
    }
    // Yakka ro'yxat qidiruvi
    if (session && session.step === 'individual_search') {
        if (text.length < 3) return bot.sendMessage(chatId, "❌ Kamida 3 harf kiriting.");
        const { department } = session;
        const results = searchEmployees(department, text, []);
        if (results.length === 0) return bot.sendMessage(chatId, "❌ Hech qanday xodim topilmadi.");
        const buttons = results.slice(0, 20).map(emp => ([{ text: emp.name, callback_data: `ind_emp_${emp.id}` }]));
        buttons.push([{ text: "🔄 Qayta qidirish", callback_data: "search_again" }, { text: "❌ Bekor qilish", callback_data: "cancel" }]);
        await bot.sendMessage(chatId, `🔎 "${text}" bo‘yicha topilganlar:`, { reply_markup: { inline_keyboard: buttons } });
        return;
    }
    // Asosiy menyu
    if (text === "👥 Jamoa yaratish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "❌ Ro'yxat yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'awaiting_team_name', teamCreationData: { teamName: '', captainId: null, members: [] }, userId });
        return bot.sendMessage(chatId, "Jamoa nomini kiriting:");
    }
    if (text === "👤 Yakka ro'yxat") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "Ro'yxat yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'individual', userId });
        return askDepartment(chatId, 'individual');
    }
    if (text === "📄 Mening jamoam") {
        const userTeam = db.teams.find(t => t.createdBy === userId);
        if (!userTeam) return bot.sendMessage(chatId, "Siz jamoa yaratmagansiz.");
        const pdf = await generateApplicationPDF(userTeam);
        return bot.sendDocument(chatId, pdf, { filename: `ariya_${userTeam.teamId}.pdf`, contentType: 'application/pdf' });
    }
    if (text === "ℹ️ Yordam") return bot.sendMessage(chatId, "📌 **Yordam**\n• Jamoani ro'yxatga olish: 5 a'zo (sardor + 4)\n• Yakka tartibda ro'yxatga: Jamoasi yo'qlarni tizim jamolarga guruhlaydi\n• Mening jamoam: PDF ariza\n• Admin: /admin\n• Bekor qilish: /cancel", { parse_mode: 'Markdown' });
    // Jamoa nomi
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
loadData().then(() => console.log('✅ Bot ishga tushdi')).catch(console.error);
