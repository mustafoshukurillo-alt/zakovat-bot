const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');
const { createWriteStream } = require('fs');
const { unlink } = require('fs').promises;

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

// -------------------- YUKLASH VA SAQLASH --------------------
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
        if (!employees.employees) employees.employees = [];
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

// -------------------- XODIMLAR BILAN ISHLASH --------------------
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

// -------------------- FORMATLASH (Admin uchun HTML) --------------------
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
    return str.replace(/[&<>]/g, function(m) {
        if (m === '&') return '&amp;';
        if (m === '<') return '&lt;';
        if (m === '>') return '&gt;';
        return m;
    });
}

// -------------------- CSV GENERATSIYA (string) --------------------
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

// -------------------- VAQTINCHALIK FAYL ORQALI YUBORISH (Buffer xatosini bartaraf qiladi) --------------------
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
        doc.text('Sardor imzosi: ____________________', { align: 'right' });
        doc.text('Tashkilot muhri: ____________________', { align: 'right' });

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
        const name = parts[1];
        const position = parts[2];
        const department = parts[3];
        if (!name || !department) continue;
        newEmployees.push({ id: newId++, name, position: position || '', department });
    }
    if (newEmployees.length === 0) throw new Error('Hech qanday xodim topilmadi');

    const oldToNewId = new Map();
    for (let i = 0; i < employees.employees.length && i < newEmployees.length; i++) {
        if (employees.employees[i] && newEmployees[i]) {
            oldToNewId.set(employees.employees[i].id, newEmployees[i].id);
        }
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
                [{ text: "👥 Jamoa yaratish" }, { text: "👤 Yakka ro'yxat" }],
                [{ text: "📄 Mening jamoam" }, { text: "ℹ️ Yordam" }]
            ],
            resize_keyboard: true
        }
    };
}

// -------------------- JAMOA YARATISH FLOW --------------------
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
    if (!Buffer.isBuffer(pdfBuffer)) throw new Error('PDF buffer emas');
    await bot.sendDocument(chatId, pdfBuffer, {
        filename: `ariya_${newTeam.teamId}.pdf`,
        contentType: 'application/pdf',
        caption: `✅ "${teamName}" jamoasi muvaffaqiyatli ro‘yxatdan o‘tdi!\n📄 Quyida rasmiy ariza.`
    });
    await bot.sendMessage(chatId, "Arizani yuklab oldingiz. Turnirda omad!", getMainMenuKeyboard());
    userSessions.delete(chatId);
    return true;
}

// -------------------- BOT HANDLERLARI --------------------
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Assalomu alaykum! Zakovat o'yiniga xush kelibsiz.\nQuyidagi tugmalar orqali ro'yxatdan o'ting:", getMainMenuKeyboard());
});

bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(chatId, "⛔ Bu buyruq faqat adminlar uchun.");

    const adminButtons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 Jamoalarni ko'rish", callback_data: "admin_view_teams" }],
                [{ text: "👤 Yakkalarni ko'rish", callback_data: "admin_view_individuals" }],
                [{ text: "📁 Jamoalar CSV", callback_data: "admin_export_teams" }],
                [{ text: "📁 Yakkalar CSV", callback_data: "admin_export_individuals" }],
                [{ text: "📁 JSON (jamoalar)", callback_data: "admin_export_json" }],
                [{ text: "🎲 Tasodifiy jamoalar", callback_data: "admin_random_teams" }],
                [{ text: db.registrationOpen ? "🔒 Ro'yxatni yopish" : "🔓 Ro'yxatni ochish", callback_data: "admin_toggle_registration" }],
                [{ text: "📂 Xodimlarni CSV dan yuklash", callback_data: "admin_upload_employees" }]
            ]
        }
    };
    await bot.sendMessage(chatId, "🔧 Admin paneli:", adminButtons);
});

bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    if (userSessions.has(chatId)) {
        userSessions.delete(chatId);
        bot.sendMessage(chatId, "Jarayon bekor qilindi.", getMainMenuKeyboard());
    } else {
        bot.sendMessage(chatId, "Hech qanday faol jarayon yo'q.");
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

        // ---------- ADMIN ----------
        if (ADMIN_IDS.includes(userId)) {
            if (data === 'admin_view_teams') {
                await bot.sendMessage(chatId, formatTeamsHTML(), { parse_mode: 'HTML' });
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            if (data === 'admin_view_individuals') {
                await bot.sendMessage(chatId, formatIndividualsHTML(), { parse_mode: 'HTML' });
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            if (data === 'admin_export_teams') {
                try {
                    await bot.sendMessage(chatId, "⏳ CSV tayyorlanmoqda...");
                    const csv = generateTeamsCSV();
                    await sendFileFromString(chatId, csv, 'jamoalar.csv', 'text/csv; charset=utf-8');
                    await bot.sendMessage(chatId, `✅ ${db.teams.length} ta jamoa eksport qilindi.`);
                } catch (err) {
                    console.error(err);
                    await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
                }
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            if (data === 'admin_export_individuals') {
                try {
                    const csv = generateIndividualsCSV();
                    await sendFileFromString(chatId, csv, 'yakkalar.csv', 'text/csv; charset=utf-8');
                    await bot.sendMessage(chatId, `✅ ${db.individuals.length} ta yakka eksport qilindi.`);
                } catch (err) {
                    await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
                }
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            if (data === 'admin_export_json') {
                try {
                    const jsonData = JSON.stringify(db.teams, null, 2);
                    await sendFileFromString(chatId, jsonData, 'jamoalar.json', 'application/json');
                    await bot.sendMessage(chatId, "✅ JSON yuklab olindi.");
                } catch (err) {
                    await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
                }
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            if (data === 'admin_random_teams') {
                if (db.individuals.length < 5) {
                    await bot.sendMessage(chatId, "❌ Tasodifiy jamoa yaratish uchun kamida 5 yakka ishtirokchi kerak.");
                    return bot.answerCallbackQuery(callbackQuery.id);
                }
                const shuffled = [...db.individuals].sort(() => Math.random() - 0.5);
                const newTeams = [];
                const used = new Set();
                for (let i = 0; i + 5 <= shuffled.length; i += 5) {
                    const group = shuffled.slice(i, i + 5).map(x => x.employeeId);
                    newTeams.push({
                        teamId: Date.now() + i,
                        teamName: `Random guruh ${Math.floor(i / 5) + 1}`,
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
                await bot.sendMessage(chatId, `🎉 ${newTeams.length} ta tasodifiy jamoa yaratildi. Qolgan yakkaliklar: ${db.individuals.length}`);
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            if (data === 'admin_toggle_registration') {
                db.registrationOpen = !db.registrationOpen;
                await saveDB();
                await bot.sendMessage(chatId, `📌 Ro'yxatga olish ${db.registrationOpen ? "ochiq" : "yopiq"}.`);
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            if (data === 'admin_upload_employees') {
                userSessions.set(chatId, { step: 'awaiting_csv' });
                await bot.sendMessage(chatId, "📂 Iltimos, quyidagi formatdagi CSV faylni yuboring:\n\n`t/r, Ism, Lavozim, Bo'lim`\nMisol:\n1, Alijon Valiyev, Muhandis, Mexanika", { parse_mode: 'Markdown' });
                return bot.answerCallbackQuery(callbackQuery.id);
            }
        }

        // ---------- JAMOA YARATISH (bo'lim tanlash) ----------
        if (data.startsWith('dept_')) {
            const parts = data.split('_');
            const action = parts[1];
            const department = parts.slice(2).join('_');
            if (!session || session.step !== action) {
                await bot.sendMessage(chatId, "Iltimos, avval 'Jamoa yaratish' tugmasini bosing.");
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            const excludeIds = (action === 'member') ? session.teamCreationData.members : [];
            const available = getAvailableEmployeesByDepartment(department, excludeIds);
            if (available.length === 0) {
                await bot.sendMessage(chatId, "Bu bo'limda mavjud xodimlar yo'q.");
                return bot.answerCallbackQuery(callbackQuery.id);
            }
            const empButtons = available.map(emp => ([{
                text: `${emp.name} (${emp.position || '-'})`,
                callback_data: `emp_${action}_${emp.id}`
            }]));
            empButtons.push([{ text: "⬅️ Orqaga", callback_data: "back_departments" }]);
            await bot.sendMessage(chatId, `"${department}" bo'limidan xodim tanlang:`, {
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

        // ---------- YAKKA RO'YXAT ----------
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
        await bot.sendMessage(chatId, `❌ Xatolik yuz berdi: ${err.message}`);
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
            await bot.sendMessage(chatId, `✅ ${count} ta xodim yangilandi. Jamoalar va yakkalar saqlanib qoldi.`);
        } catch (err) {
            await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
        }
        userSessions.delete(chatId);
        return;
    }

    // Asosiy menyu
    if (text === "👥 Jamoa yaratish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "❌ Hozirda ro'yxatga olish yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel bilan bekor qiling.");
        userSessions.set(chatId, {
            step: 'awaiting_team_name',
            teamCreationData: { teamName: '', captainId: null, members: [] },
            userId
        });
        return bot.sendMessage(chatId, "Jamoa nomini kiriting:");
    }
    if (text === "👤 Yakka ro'yxat") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "Ro'yxatga olish yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'individual', userId });
        return askDepartment(chatId, 'individual');
    }
    if (text === "📄 Mening jamoam") {
        const userTeam = db.teams.find(team => team.createdBy === userId);
        if (!userTeam) return bot.sendMessage(chatId, "Siz hali jamoa yaratmagansiz.");
        try {
            const pdfBuffer = await generateApplicationPDF(userTeam);
            await bot.sendDocument(chatId, pdfBuffer, {
                filename: `ariya_${userTeam.teamId}.pdf`,
                contentType: 'application/pdf',
                caption: `📄 "${userTeam.teamName}" jamoasi arizasi`
            });
        } catch (err) {
            await bot.sendMessage(chatId, `❌ PDF yaratishda xatolik: ${err.message}`);
        }
        return;
    }
    if (text === "ℹ️ Yordam") {
        return bot.sendMessage(chatId, "📌 **Yordam**\n\n• Jamoa yaratish: 5 a'zo (sardor + 4)\n• Yakka ro'yxat: admin guruhlaydi\n• Mening jamoam: PDF ariza yuklab olish\n• Admin: /admin\n• Bekor qilish: /cancel", { parse_mode: 'Markdown' });
    }

    // Jamoa nomini qabul qilish
    if (session && session.step === 'awaiting_team_name') {
        if (text.length > 50) return bot.sendMessage(chatId, "Jamoa nomi 50 belgidan oshmasligi kerak.");
        session.teamCreationData.teamName = text;
        session.step = 'captain';
        await bot.sendMessage(chatId, "Endi jamoa sardorini tanlang (bo'lim orqali):");
        await askDepartment(chatId, 'captain');
    }
});

// -------------------- EXPRESS SERVER (Railway) --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda`));

// -------------------- BOSHLASH --------------------
loadData().then(() => console.log('✅ Bot muvaffaqiyatli ishga tushdi!')).catch(console.error);
