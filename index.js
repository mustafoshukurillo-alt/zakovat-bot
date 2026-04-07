const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const PDFDocument = require('pdfkit');
const archiver = require('archiver');

// -------------------- KONFIGURATSIYA --------------------
const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN topilmadi!');
    process.exit(1);
}
const ADMIN_IDS = (process.env.ADMIN_IDS || '').split(',').map(id => parseInt(id.trim())).filter(id => !isNaN(id));

const bot = new TelegramBot(BOT_TOKEN, { 
    polling: { interval: 500, timeout: 60, limit: 50, retryTimeout: 10000 }
});
(async () => { try { await bot.deleteWebHook(); } catch(e) {} })();

// -------------------- MA'LUMOTLAR YO'LLARI --------------------
const DB_PATH = path.join(__dirname, 'db.json');
const DEPARTMENTS_PATH = path.join(__dirname, 'departments.json');
const EMPLOYEES_PATH = path.join(__dirname, 'employees.json');

// -------------------- GLOBAL O'ZGARUVCHILAR --------------------
let db = { teams: [], individuals: [], registrationOpen: true };
let departments = { departments: [] };
let employees = { employees: [] };
const userSessions = new Map(); // { chatId: { step, teamName, members, currentDeptId, currentRole, ... } }

// -------------------- YUKLASH --------------------
async function loadData() {
    try {
        const dbRaw = await fs.readFile(DB_PATH, 'utf8');
        db = JSON.parse(dbRaw);
        console.log('✅ db.json yuklandi, jamoalar:', db.teams.length, 'yakkalar:', db.individuals.length);
    } catch {
        db = { teams: [], individuals: [], registrationOpen: true };
        await saveDB();
    }
    try {
        const deptRaw = await fs.readFile(DEPARTMENTS_PATH, 'utf8');
        departments = JSON.parse(deptRaw);
        console.log('✅ departments.json yuklandi, bo\'limlar:', departments.departments.length);
    } catch (err) {
        console.error('departments.json xatosi:', err.message);
        process.exit(1);
    }
    try {
        const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
        employees = JSON.parse(empRaw);
        console.log('✅ employees.json yuklandi, xodimlar:', employees.employees.length);
    } catch (err) {
        console.error('employees.json xatosi:', err.message);
        employees = { employees: [] };
    }
}
async function saveDB() { await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }

// -------------------- YORDAMCHI FUNKSIYALAR --------------------
function getDepartmentName(id) {
    const dept = departments.departments.find(d => d.id === id);
    return dept ? dept.name : 'Noma\'lum';
}
function getEmployee(id) {
    return employees.employees.find(e => e.id === id);
}
function getEmployeeName(id) {
    const e = getEmployee(id);
    return e ? e.name : `ID:${id}`;
}
function getEmployeePosition(id) {
    const e = getEmployee(id);
    return e ? e.position : '';
}
function getEmployeeDepartment(id) {
    const e = getEmployee(id);
    return e ? getDepartmentName(e.departmentId) : '';
}
function isEmployeeAvailable(employeeId) {
    const inTeam = db.teams.some(t => t.members.some(m => m.id === employeeId));
    const inIndividual = db.individuals.some(ind => ind.employeeId === employeeId);
    return !inTeam && !inIndividual;
}
function getEmployeesByDepartment(deptId, excludeIds = [], page = 0, pageSize = 10) {
    const all = employees.employees.filter(e => e.departmentId === deptId && isEmployeeAvailable(e.id) && !excludeIds.includes(e.id))
        .sort((a,b) => a.name.localeCompare(b.name));
    const start = page * pageSize;
    return {
        items: all.slice(start, start + pageSize),
        total: all.length,
        page: page,
        totalPages: Math.ceil(all.length / pageSize)
    };
}

// -------------------- PDF ARIZA --------------------
async function generateApplicationPDF(teamData, isIndividual = false) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);
        doc.fontSize(18).text('SAM AUTO ZAKOVAT TURNIRI', { align: 'center' });
        doc.moveDown(0.5).fontSize(16).text('QATNASHISH UCHUN ARIZA', { align: 'center' });
        doc.moveDown(1.5);
        if (isIndividual) {
            doc.fontSize(12).text(`Ishtirokchi: ${teamData.name}`, { underline: true });
            doc.text(`Bo'lim: ${teamData.department}`);
            doc.text(`Lavozim: ${teamData.position || '—'}`);
            doc.text(`Ro'yxatga olingan: ${new Date(teamData.registeredAt).toLocaleString('uz-UZ')}`);
        } else {
            doc.fontSize(12).text(`Jamoa nomi: ${teamData.teamName}`, { underline: true });
            doc.text(`Sardor: ${teamData.captainName} (${teamData.captainDepartment})`);
            doc.text(`A'zolar soni: ${teamData.members.length} nafar`);
            doc.moveDown(1);
            const startY = doc.y;
            doc.font('Helvetica-Bold');
            doc.text('№', 50, startY);
            doc.text('F.I.SH.', 80, startY);
            doc.text('Lavozim', 250, startY);
            doc.text('Bo‘lim', 350, startY);
            doc.text('Imzo', 450, startY);
            doc.moveDown(0.5);
            doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
            let currentY = doc.y;
            doc.font('Helvetica');
            for (let i = 0; i < teamData.members.length; i++) {
                const m = teamData.members[i];
                doc.text(`${i+1}`, 50, currentY+5);
                doc.text(m.name, 80, currentY+5, { width: 160 });
                doc.text(m.position || '—', 250, currentY+5, { width: 90 });
                doc.text(m.department, 350, currentY+5, { width: 90 });
                doc.text('__________', 450, currentY+5);
                currentY += 25;
                if (currentY > 700) { doc.addPage(); currentY = 50; /* sarlavha qayta */ }
            }
        }
        doc.moveDown(2);
        doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, { align: 'right' });
        doc.text(isIndividual ? 'Ishtirokchi imzosi: ____________________' : 'Sardor imzosi: ____________________', { align: 'right' });
        doc.text('Tashkilot muhri: ____________________', { align: 'right' });
        doc.end();
    });
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

// -------------------- BO'LIMLARNI SAHIFALASH (5 tadan) --------------------
const DEPTS_PER_PAGE = 5;
async function showDepartments(chatId, prefix, page = 0) {
    const depts = departments.departments;
    const totalPages = Math.ceil(depts.length / DEPTS_PER_PAGE);
    const start = page * DEPTS_PER_PAGE;
    const pageDepts = depts.slice(start, start + DEPTS_PER_PAGE);
    const buttons = pageDepts.map(d => ([{ text: d.name, callback_data: `${prefix}_${d.id}` }]));
    const navRow = [];
    for (let i = 0; i < totalPages; i++) {
        navRow.push({ text: i === page ? `📌 ${i+1}` : `${i+1}`, callback_data: `${prefix}_page_${i}` });
    }
    buttons.push(navRow);
    buttons.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
    await bot.sendMessage(chatId, `📌 Bo'limni tanlang (${page+1}/${totalPages}):`, { reply_markup: { inline_keyboard: buttons } });
    const sess = userSessions.get(chatId) || {};
    userSessions.set(chatId, { ...sess, deptPage: page });
}

// -------------------- XODIMLARNI SAHIFALASH (10 tadan) --------------------
async function showEmployees(chatId, deptId, action, teamCreationData, userId, excludeIds, page = 0) {
    const { items, total, totalPages } = getEmployeesByDepartment(deptId, excludeIds, page, 10);
    if (items.length === 0) {
        await bot.sendMessage(chatId, `❌ Bu bo'limda mavjud xodim yo'q.`);
        return;
    }
    const buttons = items.map(emp => ([{ text: emp.name, callback_data: `emp_${action}_${emp.id}` }]));
    if (totalPages > 1) {
        const nav = [];
        if (page > 0) nav.push({ text: "⬅️ Oldingi", callback_data: `emp_page_${action}_${deptId}_${page-1}` });
        if (page < totalPages-1) nav.push({ text: "Keyingi ➡️", callback_data: `emp_page_${action}_${deptId}_${page+1}` });
        if (nav.length) buttons.push(nav);
    }
    buttons.push([{ text: "⬅️ Bo'limlarga qaytish", callback_data: "back_to_depts" }, { text: "❌ Bekor qilish", callback_data: "cancel" }]);
    await bot.sendMessage(chatId, `🔎 ${total} ta xodim (${page+1}/${totalPages}):`, { reply_markup: { inline_keyboard: buttons } });
}

// -------------------- JAMOA YARATISH --------------------
async function askMemberName(chatId, session, memberNumber) {
    if (memberNumber === 1) {
        await bot.sendMessage(chatId, "👨‍💼 Sardorning to‘liq ismini kiriting (rasmiy hujjatdagidek):");
    } else {
        await bot.sendMessage(chatId, `👥 ${memberNumber}-a'zoning to‘liq ismini kiriting:`);
    }
    userSessions.set(chatId, { ...session, step: 'awaiting_member_name', memberIndex: memberNumber });
}

async function finalizeTeam(chatId, userId, session) {
    const { teamName, members } = session;
    if (members.length !== 5) {
        await bot.sendMessage(chatId, "❌ Xatolik: 5 a'zo to'liq emas.");
        userSessions.delete(chatId);
        return;
    }
    const newTeam = {
        teamId: Date.now(),
        teamName,
        captainName: members[0].name,
        captainDepartment: members[0].department,
        members: members.map((m, idx) => ({ id: m.id, name: m.name, position: m.position, department: m.department, role: idx === 0 ? 'Sardor' : 'A\'zo' })),
        createdBy: userId,
        createdAt: new Date().toISOString()
    };
    db.teams.push(newTeam);
    await saveDB();

    const pdfBuffer = await generateApplicationPDF({
        teamName, captainName: members[0].name, captainDepartment: members[0].department,
        members: members.map(m => ({ name: m.name, position: m.position, department: m.department }))
    }, false);
    await bot.sendDocument(chatId, pdfBuffer, { filename: `ariya_${newTeam.teamId}.pdf`, contentType: 'application/pdf', caption: `✅ "${teamName}" jamoasi ro'yxatdan o'tdi!\n\n📄 Ariza faylingiz. Iltimos, uni imzolab Yoshlar kengashiga topshiring.` });
    let membersList = members.map((m, i) => `${i+1}. ${m.name} (${m.department})`).join('\n');
    await bot.sendMessage(chatId, `🎉 Tabriklaymiz! "${teamName}" jamoasi ro'yxatdan o'tdi!\n\nJamoa tarkibi:\n${membersList}\n\nSana: ${new Date().toLocaleDateString('uz-UZ')}\n\nArizani yuklab oldingiz. Omad!`, getMainMenuKeyboard());
    userSessions.delete(chatId);
}

// -------------------- YAKKA RO'YXAT --------------------
async function finalizeIndividual(chatId, userId, deptId, name) {
    const emp = employees.employees.find(e => e.departmentId === deptId && e.name.toLowerCase() === name.trim().toLowerCase());
    const finalName = emp ? emp.name : name;
    const position = emp ? emp.position : '';
    const newIndividual = {
        id: Date.now(),
        employeeId: emp ? emp.id : null,
        name: finalName,
        departmentId: deptId,
        department: getDepartmentName(deptId),
        position: position,
        registeredAt: new Date().toISOString(),
        telegramUserId: userId
    };
    db.individuals.push(newIndividual);
    await saveDB();

    const pdfBuffer = await generateApplicationPDF({
        name: finalName, department: getDepartmentName(deptId), position, registeredAt: newIndividual.registeredAt
    }, true);
    await bot.sendDocument(chatId, pdfBuffer, { filename: `individual_${newIndividual.id}.pdf`, contentType: 'application/pdf', caption: `✅ Siz individual ro'yxatdan o'tdingiz!\n\n📄 Ariza faylingiz. Iltimos, uni imzolab Yoshlar kengashiga topshiring.` });
    await bot.sendMessage(chatId, "Arizani yuklab oldingiz. Turnirda omad!", getMainMenuKeyboard());
    userSessions.delete(chatId);
}

// -------------------- TASODIFIY JAMOA YARATISH (YAKKALARDAN) --------------------
async function createRandomTeams(chatId, userId) {
    if (db.individuals.length < 5) {
        await bot.sendMessage(chatId, "❌ Tasodifiy jamoa yaratish uchun kamida 5 ta yakka ishtirokchi kerak.");
        return false;
    }
    const shuffled = [...db.individuals];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const newTeams = [];
    const usedIds = new Set();
    let teamCounter = 1;
    for (let i = 0; i + 5 <= shuffled.length; i += 5) {
        const group = shuffled.slice(i, i + 5);
        const teamId = Date.now() + teamCounter;
        const teamName = `Random guruh ${teamCounter}`;
        const captain = group[0];
        const members = group.map((m, idx) => ({
            id: m.employeeId,
            name: m.name,
            position: m.position,
            department: m.department,
            role: idx === 0 ? 'Sardor' : 'A\'zo'
        }));
        const newTeam = {
            teamId, teamName,
            captainName: captain.name,
            captainDepartment: captain.department,
            members,
            createdBy: userId,
            createdAt: new Date().toISOString()
        };
        newTeams.push(newTeam);
        group.forEach(m => usedIds.add(m.id));
        teamCounter++;
    }
    const remaining = shuffled.filter(m => !usedIds.has(m.id));
    db.teams.push(...newTeams);
    db.individuals = remaining;
    await saveDB();
    for (const team of newTeams) {
        const captainIndividual = shuffled.find(m => m.name === team.captainName && m.department === team.captainDepartment);
        if (captainIndividual && captainIndividual.telegramUserId) {
            try {
                await bot.sendMessage(captainIndividual.telegramUserId,
                    `🎉 Tabriklaymiz! Siz "${team.teamName}" jamoasining sardori etib tayinlandingiz!\n\nJamoa tarkibi:\n${team.members.map((m,i) => `${i+1}. ${m.name} (${m.department})`).join('\n')}\n\nArizangizni /start orqali "Mening jamoam" tugmasidan yuklab olishingiz mumkin.`);
            } catch(e) {}
        }
    }
    await bot.sendMessage(chatId, `🎲 ${newTeams.length} ta tasodifiy jamoa yaratildi!\nQolgan yakka ishtirokchilar: ${remaining.length}`);
    return true;
}

// -------------------- BOTNI TOZALASH --------------------
async function resetBot(chatId) {
    db = { teams: [], individuals: [], registrationOpen: true };
    await saveDB();
    try {
        const files = await fs.readdir(__dirname);
        for (const file of files) {
            if (file.startsWith('temp_') || file.startsWith('ariya_') || file.startsWith('individual_')) {
                await fs.unlink(path.join(__dirname, file)).catch(()=>{});
            }
        }
    } catch(e) {}
    userSessions.clear();
    await bot.sendMessage(chatId, "✅ Bot to'liq tozalandi! Barcha jamoalar, yakkalar va vaqtinchalik fayllar o'chirildi.\n\nBotni qayta ishga tushirish shart emas, yangidan ro'yxatga olish mumkin.");
}

// -------------------- HANDLERLAR --------------------
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        "Assalomu alaykum! Siz SamAuto Zakovat o'yinida ro'yxatdan o'tish botiga xush keldingiz!\n\n" +
        "📌 **Jamoaviy ro'yxatdan o'tish**: 5 kishidan iborat jamoa tuzasiz (sardor + 4 a'zo).\n" +
        "📌 **Individual ro'yxatdan o'tish**: Jamoasi bo'lmagan ishtirokchilar uchun. Keyin admin tasodifiy jamoalarga guruhlaydi.\n" +
        "📌 **Mening jamoam**: Agar siz jamoa sardori bo'lsangiz, jamoangizning arizasini PDF shaklida yuklab olishingiz mumkin.\n\n" +
        "Quyidagi tugmalar orqali ro'yxatdan o'ting:",
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
    );
});

bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(chatId, "⛔ Bu buyruq faqat adminlar uchun.");
    const stats = `📊 **Statistika**\n• Jamoalar: ${db.teams.length}\n• Yakka ishtirokchilar: ${db.individuals.length}\n• Jami ishtirokchilar: ${db.teams.length * 5 + db.individuals.length}\n\nRo'yxatga olish holati: ${db.registrationOpen ? "✅ Ochiq" : "🔴 Yopiq"}`;
    const adminButtons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 Jamoalar ro'yxati", callback_data: "admin_teams_list" }],
                [{ text: "👤 Yakkalar ro'yxati", callback_data: "admin_individuals_list" }],
                [{ text: "🎲 Tasodifiy jamoalar yaratish", callback_data: "admin_random_teams" }],
                [{ text: "📁 Barcha arizalarni ZIP", callback_data: "admin_export_all_pdfs" }],
                [{ text: db.registrationOpen ? "🔒 Ro'yxatni yopish" : "🔓 Ro'yxatni ochish", callback_data: "admin_toggle_registration" }],
                [{ text: "🔄 Botni tozalash (RESET)", callback_data: "admin_reset_bot" }]
            ]
        }
    };
    await bot.sendMessage(chatId, stats, { parse_mode: 'Markdown', ...adminButtons });
});

bot.onText(/\/cancel/, (msg) => {
    const chatId = msg.chat.id;
    userSessions.delete(chatId);
    bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
});

// -------------------- CALLBACK QUERY --------------------
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const session = userSessions.get(chatId);
    bot.answerCallbackQuery(query.id).catch(()=>{});

    try {
        if (data === 'cancel') {
            userSessions.delete(chatId);
            await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
            return;
        }
        // Admin
        if (ADMIN_IDS.includes(userId)) {
            if (data === 'admin_teams_list') {
                let msg = db.teams.length ? "📋 Jamoalar:\n\n" + db.teams.map((t,i)=>`${i+1}. ${t.teamName}\n   Sardor: ${t.captainName}\n   A'zolar: ${t.members.length}\n   Sana: ${new Date(t.createdAt).toLocaleDateString()}\n`).join('\n') : "Hech qanday jamoa yo'q";
                await bot.sendMessage(chatId, msg);
                return;
            }
            if (data === 'admin_individuals_list') {
                let msg = db.individuals.length ? "👤 Yakkalar:\n\n" + db.individuals.map((ind,i)=>`${i+1}. ${ind.name} (${ind.department})\n   Ro'yxatdan o'tgan: ${new Date(ind.registeredAt).toLocaleDateString()}\n`).join('\n') : "Hech qanday yakka yo'q";
                await bot.sendMessage(chatId, msg);
                return;
            }
            if (data === 'admin_random_teams') {
                await createRandomTeams(chatId, userId);
                return;
            }
            if (data === 'admin_export_all_pdfs') {
                await bot.sendMessage(chatId, "⏳ Arizalar tayyorlanmoqda...");
                try {
                    const zipPath = path.join(__dirname, `arizalar_${Date.now()}.zip`);
                    const output = require('fs').createWriteStream(zipPath);
                    const archive = archiver('zip', { zlib: { level: 9 } });
                    output.on('close', async () => {
                        await bot.sendDocument(chatId, zipPath, { filename: 'barcha_arizalar.zip', caption: `📦 Barcha arizalar (${db.teams.length} ta jamoa + ${db.individuals.length} ta yakka) zip faylda.` });
                        await fs.unlink(zipPath);
                    });
                    archive.pipe(output);
                    for (const team of db.teams) {
                        const pdfBuffer = await generateApplicationPDF({
                            teamName: team.teamName,
                            captainName: team.captainName,
                            captainDepartment: team.captainDepartment,
                            members: team.members.map(m => ({ name: m.name, position: m.position, department: m.department }))
                        }, false);
                        archive.append(pdfBuffer, { name: `jamoa_${team.teamId}.pdf` });
                    }
                    for (const ind of db.individuals) {
                        const pdfBuffer = await generateApplicationPDF({
                            name: ind.name, department: ind.department, position: ind.position, registeredAt: ind.registeredAt
                        }, true);
                        archive.append(pdfBuffer, { name: `individual_${ind.id}.pdf` });
                    }
                    await archive.finalize();
                } catch (err) { console.error(err); await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`); }
                return;
            }
            if (data === 'admin_toggle_registration') {
                db.registrationOpen = !db.registrationOpen;
                await saveDB();
                await bot.sendMessage(chatId, `Ro'yxatga olish ${db.registrationOpen ? "ochiq" : "yopiq"}.`);
                return;
            }
            if (data === 'admin_reset_bot') {
                await resetBot(chatId);
                return;
            }
        }
        // Bo'lim sahifalash
        if (data.includes('_page_')) {
            const [prefix, pageStr] = data.split('_page_');
            const page = parseInt(pageStr);
            await showDepartments(chatId, prefix, page);
            return;
        }
        // Bo'lim tanlash (JAMOA)
        if (data.startsWith('team_captain_dept_')) {
            const deptId = parseInt(data.split('_').pop());
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return;
            }
            const newSession = { ...session, currentDeptId: deptId, currentRole: 'captain' };
            await showEmployees(chatId, deptId, 'captain', newSession.teamCreationData, userId, [], 0);
            userSessions.set(chatId, { ...newSession, step: 'selecting_employee' });
            return;
        }
        if (data.startsWith('team_member_dept_')) {
            const deptId = parseInt(data.split('_').pop());
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return;
            }
            const newSession = { ...session, currentDeptId: deptId, currentRole: 'member' };
            await showEmployees(chatId, deptId, 'member', newSession.teamCreationData, userId, session.members.map(m=>m.id), 0);
            userSessions.set(chatId, { ...newSession, step: 'selecting_employee' });
            return;
        }
        // Xodim tanlash
        if (data.startsWith('emp_')) {
            const parts = data.split('_');
            const action = parts[1];
            const empId = parseInt(parts[2]);
            if (!session || session.step !== 'selecting_employee') {
                await bot.sendMessage(chatId, "Vaqt tugadi. Qaytadan boshlang.");
                return;
            }
            const emp = getEmployee(empId);
            if (!emp || !isEmployeeAvailable(emp.id)) {
                await bot.sendMessage(chatId, `❌ Xodim band yoki mavjud emas.`);
                return;
            }
            const member = { id: emp.id, name: emp.name, position: emp.position, department: getDepartmentName(emp.departmentId) };
            const members = session.members || [];
            members.push(member);
            if (action === 'captain') {
                if (members.length === 5) {
                    await finalizeTeam(chatId, userId, { ...session, members });
                } else {
                    userSessions.set(chatId, { ...session, members, step: 'awaiting_department', currentRole: 'member' });
                    await bot.sendMessage(chatId, `✅ Sardor qo'shildi. Endi 2-a'zoning bo'limini tanlang:`);
                    await showDepartments(chatId, 'team_member_dept', 0);
                }
            } else {
                if (members.length === 5) {
                    await finalizeTeam(chatId, userId, { ...session, members });
                } else {
                    const nextIndex = members.length + 1;
                    userSessions.set(chatId, { ...session, members, step: 'awaiting_department' });
                    await bot.sendMessage(chatId, `✅ A'zo qo'shildi. Endi ${nextIndex}-a'zoning bo'limini tanlang:`);
                    await showDepartments(chatId, 'team_member_dept', 0);
                }
            }
            return;
        }
        // Xodim sahifalash
        if (data.startsWith('emp_page_')) {
            const parts = data.split('_');
            const action = parts[2];
            const deptId = parseInt(parts[3]);
            const page = parseInt(parts[4]);
            if (!session || session.step !== 'selecting_employee') return;
            await showEmployees(chatId, deptId, action, session.teamCreationData, userId, session.members?.map(m=>m.id) || [], page);
            return;
        }
        if (data === 'back_to_depts') {
            if (!session) return;
            await showDepartments(chatId, session.currentRole === 'captain' ? 'team_captain_dept' : 'team_member_dept', 0);
            userSessions.set(chatId, { ...session, step: 'awaiting_department' });
            return;
        }
        // YAKKA RO'YXAT
        if (data.startsWith('individual_dept_')) {
            const deptId = parseInt(data.split('_').pop());
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Individual ro'yxatga olish' tugmasini bosing.");
                return;
            }
            userSessions.set(chatId, { step: 'awaiting_individual_name', deptId, userId });
            await bot.sendMessage(chatId, "📝 Iltimos, to'liq ismingizni kiriting (rasmiy hujjatdagidek):");
            return;
        }
    } catch (err) {
        console.error('Callback xatosi:', err);
        await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
    }
});

// -------------------- MATNLI XABARLAR --------------------
bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;
    const userId = msg.from.id;
    const session = userSessions.get(chatId);

    if (text === "👥 Jamoani ro'yxatga olish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "❌ Ro'yxat yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'awaiting_team_name', teamName: '', members: [], userId });
        return bot.sendMessage(chatId, "🏷 Jamoa nomini kiriting:");
    }
    if (text === "👤 Individual ro'yxatga olish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "Ro'yxat yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'awaiting_department', userId });
        await showDepartments(chatId, 'individual_dept', 0);
        return;
    }
    if (text === "📄 Mening jamoam") {
        const userTeam = db.teams.find(t => t.createdBy === userId);
        if (!userTeam) return bot.sendMessage(chatId, "Siz jamoa sardori emassiz.");
        const pdf = await generateApplicationPDF({
            teamName: userTeam.teamName,
            captainName: userTeam.captainName,
            captainDepartment: userTeam.captainDepartment,
            members: userTeam.members.map(m => ({ name: m.name, position: m.position, department: m.department }))
        }, false);
        return bot.sendDocument(chatId, pdf, { filename: `ariya_${userTeam.teamId}.pdf`, contentType: 'application/pdf', caption: `📄 "${userTeam.teamName}" jamoasi arizasi` });
    }
    if (text === "ℹ️ Yordam") {
        return bot.sendMessage(chatId, "📌 **Yordam**\n\n• Jamoani ro'yxatga olish: 5 a'zo (sardor + 4).\n• Individual ro'yxatga olish: o'zingizni ro'yxatdan o'tkazing, keyin admin tasodifiy jamoalarga guruhlaydi.\n• Mening jamoam: PDF ariza yuklash.\n• Admin: /admin\n• Bekor qilish: /cancel", { parse_mode: 'Markdown' });
    }
    // Jamoa nomi
    if (session && session.step === 'awaiting_team_name') {
        if (text.length > 50) return bot.sendMessage(chatId, "Nomi 50 belgidan oshmasin.");
        session.teamName = text;
        session.step = 'awaiting_department';
        session.members = [];
        await bot.sendMessage(chatId, "Endi sardorning bo'limini tanlang:");
        await showDepartments(chatId, 'team_captain_dept', 0);
        return;
    }
    // Yakka ro'yxat: ism
    if (session && session.step === 'awaiting_individual_name') {
        if (text.length < 5) return bot.sendMessage(chatId, "❌ Ism familiya kamida 5 belgidan iborat bo'lishi kerak.");
        await finalizeIndividual(chatId, userId, session.deptId, text);
        return;
    }
});

// -------------------- SERVER --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda`));

loadData().then(() => console.log('✅ Bot ishga tushdi')).catch(console.error);
