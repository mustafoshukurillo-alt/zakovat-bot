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

// -------------------- GLOBAL O'ZGARUVCHILAR --------------------
let db = { teams: [], individuals: [], registrationOpen: true };
let departments = { departments: [] };
const userSessions = new Map();

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
}
async function saveDB() { await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }

// -------------------- PDF ARIZA (jamoa uchun, imzolar o'ngda) --------------------
async function generateTeamApplicationPDF(teamData) {
    return new Promise((resolve, reject) => {
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));
        doc.on('end', () => resolve(Buffer.concat(chunks)));
        doc.on('error', reject);

        doc.font('Times-Roman');
        doc.fontSize(18).font('Times-Bold').text('SAM AUTO ZAKOVAT TURNIRI', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(16).text('QATNASHISH UCHUN ARIZA', { align: 'center' });
        doc.moveDown(1.5);

        doc.fontSize(12).font('Times-Roman');
        doc.text(`Jamoa nomi: ${teamData.teamName}`, { underline: true });
        doc.text(`Sardor: ${teamData.captainName} (yoshi ${teamData.captainAge})`);
        doc.text(`A'zolar soni: ${teamData.members.length} nafar`);
        doc.moveDown(1);

        // Jadval sarlavhasi
        const startY = doc.y;
        doc.font('Times-Bold');
        doc.text('№', 50, startY);
        doc.text('F.I.SH.', 80, startY);
        doc.text('Yoshi', 250, startY);
        doc.text('Bo‘lim', 300, startY);
        doc.text('Imzo', 450, startY);
        doc.moveDown(0.5);
        doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
        doc.font('Times-Roman');

        let currentY = doc.y;
        for (let i = 0; i < teamData.members.length; i++) {
            const m = teamData.members[i];
            doc.text(`${i+1}`, 50, currentY+5);
            doc.text(m.name, 80, currentY+5, { width: 160 });
            doc.text(`${m.age}`, 250, currentY+5, { width: 40 });
            doc.text(m.department, 300, currentY+5, { width: 140 });
            doc.text('__________', 450, currentY+5);  // imzo o'ng tomonda
            currentY += 25;
            if (currentY > 700) {
                doc.addPage();
                currentY = 50;
                doc.font('Times-Bold');
                doc.text('№', 50, currentY);
                doc.text('F.I.SH.', 80, currentY);
                doc.text('Yoshi', 250, currentY);
                doc.text('Bo‘lim', 300, currentY);
                doc.text('Imzo', 450, currentY);
                doc.moveDown(0.5);
                doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
                currentY = doc.y;
                doc.font('Times-Roman');
            }
        }

        doc.moveDown(3);
        doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, { align: 'right' });
        doc.moveDown(1);
        doc.text('Sardor imzosi: ____________________', 50, doc.y);  // chap tomonda
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

// -------------------- BO'LIMLARNI SAHIFALASH (11 tadan) --------------------
const DEPTS_PER_PAGE = 11;
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

// -------------------- JAMOA YARATISH --------------------
async function askMemberName(chatId, session, memberNumber) {
    if (memberNumber === 1) {
        await bot.sendMessage(chatId, "👨‍💼 Sardorning to‘liq ismini kiriting (F.I.SH.):");
    } else {
        await bot.sendMessage(chatId, `👥 ${memberNumber}-a'zoning to‘liq ismini kiriting:`);
    }
    userSessions.set(chatId, { ...session, step: 'awaiting_name', memberIndex: memberNumber });
}

async function askAge(chatId, session) {
    await bot.sendMessage(chatId, "📅 Yoshingizni kiriting (masalan: 25):");
    userSessions.set(chatId, { ...session, step: 'awaiting_age' });
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
        captainAge: members[0].age,
        captainDepartment: members[0].department,
        members: members.map((m, idx) => ({ name: m.name, age: m.age, department: m.department, role: idx === 0 ? 'Sardor' : 'A\'zo' })),
        createdBy: userId,
        createdAt: new Date().toISOString()
    };
    db.teams.push(newTeam);
    await saveDB();

    const pdfBuffer = await generateTeamApplicationPDF({
        teamName,
        captainName: members[0].name,
        captainAge: members[0].age,
        captainDepartment: members[0].department,
        members: members.map(m => ({ name: m.name, age: m.age, department: m.department }))
    });
    await bot.sendDocument(chatId, pdfBuffer, { 
        filename: `ariya_${newTeam.teamId}.pdf`, 
        contentType: 'application/pdf', 
        caption: `✅ "${teamName}" jamoasi muvaffaqiyatli ro'yxatdan o'tdi!\n\n📄 Ariza faylingiz. Iltimos, uni imzolab Yoshlar kengashiga topshiring.` 
    });
    let membersList = members.map((m, i) => `${i+1}. ${m.name} (${m.age} yosh, ${m.department})`).join('\n');
    await bot.sendMessage(chatId, `🎉 Tabriklaymiz! "${teamName}" jamoasi ro'yxatdan o'tdi!\n\nJamoa tarkibi:\n${membersList}\n\nSana: ${new Date().toLocaleDateString('uz-UZ')}\n\nArizani yuklab oldingiz. Omad!`, getMainMenuKeyboard());
    userSessions.delete(chatId);
}

// -------------------- JAMOANI TAHRIRLASH --------------------
async function showTeamEditMenu(chatId, team, userId) {
    const teamIndex = db.teams.findIndex(t => t.teamId === team.teamId);
    if (teamIndex === -1) {
        await bot.sendMessage(chatId, "❌ Jamoa topilmadi.");
        return;
    }
    let msg = `📝 *Jamoani tahrirlash*: ${team.teamName}\n\n`;
    msg += `1. Jamoa nomini o'zgartirish\n`;
    msg += `2. A'zolarni tahrirlash\n`;
    msg += `3. Jamoani butunlay o'chirish\n\n`;
    msg += `Raqamni yuboring (1/2/3):`;
    userSessions.set(chatId, { step: 'edit_team_choice', teamId: team.teamId, userId });
    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

async function editTeamName(chatId, team, newName) {
    const teamIndex = db.teams.findIndex(t => t.teamId === team.teamId);
    if (teamIndex === -1) return;
    db.teams[teamIndex].teamName = newName;
    await saveDB();
    await bot.sendMessage(chatId, `✅ Jamoa nomi "${newName}" ga o'zgartirildi.`, getMainMenuKeyboard());
    userSessions.delete(chatId);
}

async function editMember(chatId, team, memberIndex, newName, newAge, newDeptId) {
    const teamIndex = db.teams.findIndex(t => t.teamId === team.teamId);
    if (teamIndex === -1) return;
    const dept = departments.departments.find(d => d.id === newDeptId);
    if (!dept) return;
    db.teams[teamIndex].members[memberIndex] = {
        name: newName,
        age: newAge,
        department: dept.name,
        role: memberIndex === 0 ? 'Sardor' : 'A\'zo'
    };
    if (memberIndex === 0) {
        db.teams[teamIndex].captainName = newName;
        db.teams[teamIndex].captainAge = newAge;
        db.teams[teamIndex].captainDepartment = dept.name;
    }
    await saveDB();
    await bot.sendMessage(chatId, `✅ A'zo ${memberIndex+1} tahrirlandi.`, getMainMenuKeyboard());
    userSessions.delete(chatId);
}

async function deleteTeam(chatId, team) {
    const teamIndex = db.teams.findIndex(t => t.teamId === team.teamId);
    if (teamIndex === -1) return;
    db.teams.splice(teamIndex, 1);
    await saveDB();
    await bot.sendMessage(chatId, `✅ Jamoa o'chirildi.`, getMainMenuKeyboard());
    userSessions.delete(chatId);
}

// -------------------- YAKKA RO'YXAT (faqat ma'lumot saqlanadi) --------------------
async function finalizeIndividual(chatId, userId, deptId, name, age) {
    const department = departments.departments.find(d => d.id === deptId).name;
    const newIndividual = {
        id: Date.now(),
        name: name,
        age: age,
        departmentId: deptId,
        department: department,
        registeredAt: new Date().toISOString(),
        telegramUserId: userId
    };
    db.individuals.push(newIndividual);
    await saveDB();

    await bot.sendMessage(chatId, `✅ Siz individual ro'yxatdan o'tdingiz!\n\n📌 Ma'lumotlaringiz saqlandi. Admin tasodifiy jamoalarga guruhlagach, sizga jamoa sardori etib tayinlangan taqdirda xabar keladi.`, getMainMenuKeyboard());
    userSessions.delete(chatId);
}

// -------------------- TASODIFIY JAMOA YARATISH (yakkalardan) --------------------
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
        const teamName = `RTeam${teamCounter}`;
        const captain = group[0];
        const members = group.map((m, idx) => ({
            name: m.name,
            age: m.age,
            department: m.department,
            role: idx === 0 ? 'Sardor' : 'A\'zo'
        }));
        const newTeam = {
            teamId, teamName,
            captainName: captain.name,
            captainAge: captain.age,
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
                    `🎉 Tabriklaymiz! Siz "${team.teamName}" jamoasi sardori etib tayinlandingiz!\n\nJamoa tarkibi:\n${team.members.map((m,i) => `${i+1}. ${m.name} (${m.age} yosh, ${m.department})`).join('\n')}\n\n📄 Arizani "Mening jamoam" bo'limidan yuklab oling va imzolab Yoshlar kengashiga topshiring.`);
            } catch(e) {}
        }
    }
    await bot.sendMessage(chatId, `🎲 ${newTeams.length} ta tasodifiy jamoa yaratildi!\nQolgan yakka ishtirokchilar: ${remaining.length}\n\nHar bir jamoa sardoriga xabar yuborildi.`);
    return true;
}

// -------------------- BARCHA JAMOALAR PDF ZIP --------------------
async function exportAllTeamsPDF(chatId) {
    if (db.teams.length === 0) {
        await bot.sendMessage(chatId, "❌ Hech qanday jamoa yo'q.");
        return;
    }
    await bot.sendMessage(chatId, "⏳ Arizalar tayyorlanmoqda...");
    try {
        const zipPath = path.join(__dirname, `jamoalar_arizalari_${Date.now()}.zip`);
        const output = require('fs').createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', async () => {
            await bot.sendDocument(chatId, zipPath, { filename: 'barcha_jamoalar_arizalari.zip', caption: `📦 Barcha jamoa arizalari (${db.teams.length} ta jamoa) zip faylda.` });
            await fs.unlink(zipPath);
        });
        archive.pipe(output);
        for (const team of db.teams) {
            const pdfBuffer = await generateTeamApplicationPDF({
                teamName: team.teamName,
                captainName: team.captainName,
                captainAge: team.captainAge,
                captainDepartment: team.captainDepartment,
                members: team.members.map(m => ({ name: m.name, age: m.age, department: m.department }))
            });
            archive.append(pdfBuffer, { name: `jamoa_${team.teamId}_${team.teamName}.pdf` });
        }
        await archive.finalize();
    } catch (err) { console.error(err); await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`); }
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
        "📌 **Individual ro'yxatdan o'tish**: Jamoasi bo'lmagan ishtirokchilar uchun. Admin tasodifiy jamoalarga guruhlaydi.\n" +
        "📌 **Mening jamoam**: Jamoangizni ko'rish, tahrirlash, o'chirish va PDF arizani yuklab olish.\n\n" +
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
                [{ text: "📁 Barcha jamoa arizalarini ZIP", callback_data: "admin_export_all_teams" }],
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
                let msg = db.teams.length ? "📋 Jamoalar:\n\n" + db.teams.map((t,i)=>`${i+1}. ${t.teamName}\n   Sardor: ${t.captainName} (${t.captainAge} yosh)\n   A'zolar: ${t.members.length}\n   Sana: ${new Date(t.createdAt).toLocaleDateString()}\n`).join('\n') : "Hech qanday jamoa yo'q";
                await bot.sendMessage(chatId, msg);
                return;
            }
            if (data === 'admin_individuals_list') {
                let msg = db.individuals.length ? "👤 Yakkalar:\n\n" + db.individuals.map((ind,i)=>`${i+1}. ${ind.name} (${ind.age} yosh, ${ind.department})\n   Ro'yxatdan o'tgan: ${new Date(ind.registeredAt).toLocaleDateString()}\n`).join('\n') : "Hech qanday yakka yo'q";
                await bot.sendMessage(chatId, msg);
                return;
            }
            if (data === 'admin_random_teams') {
                await createRandomTeams(chatId, userId);
                return;
            }
            if (data === 'admin_export_all_teams') {
                await exportAllTeamsPDF(chatId);
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
        // JAMOA: bo'lim tanlash
        if (data.startsWith('team_captain_dept_') || data.startsWith('team_member_dept_')) {
            const parts = data.split('_');
            const role = parts[2];
            const deptId = parseInt(parts[3]);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return;
            }
            const newSession = { ...session, currentDeptId: deptId, currentRole: role };
            userSessions.set(chatId, { ...newSession, step: 'awaiting_name' });
            await askMemberName(chatId, newSession, role === 'captain' ? 1 : (session.members.length + 1));
            return;
        }
        // YAKKA: bo'lim tanlash
        if (data.startsWith('individual_dept_')) {
            const deptId = parseInt(data.split('_').pop());
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Individual ro'yxatga olish' tugmasini bosing.");
                return;
            }
            userSessions.set(chatId, { step: 'awaiting_individual_name', deptId, userId });
            await bot.sendMessage(chatId, "📝 Iltimos, to'liq ismingizni kiriting (F.I.SH.):");
            return;
        }
        // Mening jamoam tahrirlash tugmalari
        if (data.startsWith('edit_team_')) {
            const action = data.split('_')[2];
            const teamId = parseInt(data.split('_')[3]);
            const team = db.teams.find(t => t.teamId === teamId);
            if (!team) {
                await bot.sendMessage(chatId, "❌ Jamoa topilmadi.");
                return;
            }
            if (action === 'name') {
                userSessions.set(chatId, { step: 'edit_team_name', teamId: teamId, userId });
                await bot.sendMessage(chatId, "✏️ Yangi jamoa nomini kiriting:");
            } else if (action === 'member') {
                userSessions.set(chatId, { step: 'edit_member_choice', teamId: teamId, userId });
                let msg = "✏️ Qaysi a'zoni tahrirlamoqchisiz?\n\n";
                team.members.forEach((m, idx) => {
                    msg += `${idx+1}. ${m.name} (${m.age} yosh, ${m.department})\n`;
                });
                msg += "\nRaqamni yuboring (1-5):";
                await bot.sendMessage(chatId, msg);
            } else if (action === 'delete') {
                await deleteTeam(chatId, team);
            }
            return;
        }
        // A'zo tahrirlash uchun bo'lim tanlash
        if (data.startsWith('edit_member_dept_')) {
            const deptId = parseInt(data.split('_').pop());
            if (!session || session.step !== 'edit_member_dept') return;
            session.currentDeptId = deptId;
            userSessions.set(chatId, { ...session, step: 'edit_member_name' });
            await bot.sendMessage(chatId, "✏️ Yangi ism familiyani kiriting:");
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
        if (!userTeam) return bot.sendMessage(chatId, "Siz jamoa sardori emassiz yoki jamoa yaratmagansiz.");
        // Jamoa ma'lumotlarini ko'rsatish
        let teamInfo = `🏷 *${userTeam.teamName}*\n\n`;
        teamInfo += `👨‍💼 Sardor: ${userTeam.captainName} (${userTeam.captainAge} yosh, ${userTeam.captainDepartment})\n`;
        teamInfo += `👥 A'zolar:\n`;
        userTeam.members.forEach((m, idx) => {
            teamInfo += `${idx+1}. ${m.name} (${m.age} yosh, ${m.department})\n`;
        });
        teamInfo += `\n📅 Yaratilgan: ${new Date(userTeam.createdAt).toLocaleDateString()}`;
        const editButtons = {
            reply_markup: {
                inline_keyboard: [
                    [{ text: "✏️ Jamoa nomini o'zgartirish", callback_data: `edit_team_name_${userTeam.teamId}` }],
                    [{ text: "👥 A'zolarni tahrirlash", callback_data: `edit_team_member_${userTeam.teamId}` }],
                    [{ text: "🗑 Jamoani o'chirish", callback_data: `edit_team_delete_${userTeam.teamId}` }],
                    [{ text: "📄 PDF arizani yuklab olish", callback_data: `download_pdf_${userTeam.teamId}` }]
                ]
            }
        };
        await bot.sendMessage(chatId, teamInfo, { parse_mode: 'Markdown', ...editButtons });
        return;
    }
    if (text === "ℹ️ Yordam") {
        return bot.sendMessage(chatId, "📌 **Yordam**\n\n• Jamoani ro'yxatga olish: 5 a'zo (sardor + 4).\n• Individual ro'yxatga olish: o'zingizni ro'yxatdan o'tkazing, keyin admin tasodifiy jamoalarga guruhlaydi.\n• Mening jamoam: Jamoangizni ko'rish, tahrirlash, o'chirish va PDF yuklash.\n• Admin: /admin\n• Bekor qilish: /cancel", { parse_mode: 'Markdown' });
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

    // Ism (jamoa)
    if (session && session.step === 'awaiting_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Ism familiya kamida 5 belgidan iborat bo'lishi kerak.");
        session.currentName = name;
        userSessions.set(chatId, { ...session, step: 'awaiting_age' });
        await bot.sendMessage(chatId, "📅 Yoshingizni kiriting (masalan: 25):");
        return;
    }

    // Yosh (jamoa)
    if (session && session.step === 'awaiting_age') {
        const age = parseInt(text);
        if (isNaN(age) || age < 16 || age > 100) return bot.sendMessage(chatId, "❌ Yoshingizni to'g'ri kiriting (16-100 oralig'ida).");
        const department = departments.departments.find(d => d.id === session.currentDeptId).name;
        const newMember = { name: session.currentName, age: age, department: department, departmentId: session.currentDeptId };
        const members = [...(session.members || []), newMember];
        
        if (session.currentRole === 'captain') {
            if (members.length === 5) {
                await finalizeTeam(chatId, userId, { ...session, members });
            } else {
                userSessions.set(chatId, { ...session, members, step: 'awaiting_department' });
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

    // Individual ro'yxat: ism
    if (session && session.step === 'awaiting_individual_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Ism familiya kamida 5 belgidan iborat bo'lishi kerak.");
        session.individualName = name;
        userSessions.set(chatId, { ...session, step: 'awaiting_individual_age' });
        await bot.sendMessage(chatId, "📅 Yoshingizni kiriting (masalan: 25):");
        return;
    }

    // Individual ro'yxat: yosh
    if (session && session.step === 'awaiting_individual_age') {
        const age = parseInt(text);
        if (isNaN(age) || age < 16 || age > 100) return bot.sendMessage(chatId, "❌ Yoshingizni to'g'ri kiriting (16-100 oralig'ida).");
        await finalizeIndividual(chatId, userId, session.deptId, session.individualName, age);
        return;
    }

    // Tahrirlash: jamoa nomi
    if (session && session.step === 'edit_team_name') {
        const team = db.teams.find(t => t.teamId === session.teamId);
        if (!team) return bot.sendMessage(chatId, "❌ Jamoa topilmadi.");
        await editTeamName(chatId, team, text);
        return;
    }

    // Tahrirlash: a'zo raqami tanlash
    if (session && session.step === 'edit_member_choice') {
        const memberNum = parseInt(text);
        if (isNaN(memberNum) || memberNum < 1 || memberNum > 5) return bot.sendMessage(chatId, "❌ 1 dan 5 gacha raqam kiriting.");
        const team = db.teams.find(t => t.teamId === session.teamId);
        if (!team) return bot.sendMessage(chatId, "❌ Jamoa topilmadi.");
        session.memberIndex = memberNum - 1;
        userSessions.set(chatId, { ...session, step: 'edit_member_dept' });
        await bot.sendMessage(chatId, "✏️ Yangi bo'limni tanlang:");
        await showDepartments(chatId, 'edit_member_dept', 0);
        return;
    }

    // Tahrirlash: a'zo ismi
    if (session && session.step === 'edit_member_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Ism familiya kamida 5 belgidan iborat bo'lishi kerak.");
        session.newName = name;
        userSessions.set(chatId, { ...session, step: 'edit_member_age' });
        await bot.sendMessage(chatId, "📅 Yangi yoshni kiriting:");
        return;
    }

    // Tahrirlash: a'zo yoshi
    if (session && session.step === 'edit_member_age') {
        const age = parseInt(text);
        if (isNaN(age) || age < 16 || age > 100) return bot.sendMessage(chatId, "❌ Yoshingizni to'g'ri kiriting (16-100 oralig'ida).");
        const team = db.teams.find(t => t.teamId === session.teamId);
        if (!team) return bot.sendMessage(chatId, "❌ Jamoa topilmadi.");
        await editMember(chatId, team, session.memberIndex, session.newName, age, session.currentDeptId);
        return;
    }

    // PDF yuklab olish
    if (session && session.step === 'download_pdf') {
        const team = db.teams.find(t => t.teamId === session.teamId);
        if (!team) return bot.sendMessage(chatId, "❌ Jamoa topilmadi.");
        const pdf = await generateTeamApplicationPDF({
            teamName: team.teamName,
            captainName: team.captainName,
            captainAge: team.captainAge,
            captainDepartment: team.captainDepartment,
            members: team.members.map(m => ({ name: m.name, age: m.age, department: m.department }))
        });
        await bot.sendDocument(chatId, pdf, { filename: `ariya_${team.teamId}.pdf`, contentType: 'application/pdf', caption: `📄 "${team.teamName}" jamoasi arizasi` });
        userSessions.delete(chatId);
        return;
    }
});

// PDF yuklab olish uchun alohida callback
bot.on('callback_query', async (query) => {
    if (query.data && query.data.startsWith('download_pdf_')) {
        const teamId = parseInt(query.data.split('_')[2]);
        const team = db.teams.find(t => t.teamId === teamId);
        if (!team) {
            await bot.answerCallbackQuery(query.id);
            await bot.sendMessage(query.message.chat.id, "❌ Jamoa topilmadi.");
            return;
        }
        const pdf = await generateTeamApplicationPDF({
            teamName: team.teamName,
            captainName: team.captainName,
            captainAge: team.captainAge,
            captainDepartment: team.captainDepartment,
            members: team.members.map(m => ({ name: m.name, age: m.age, department: m.department }))
        });
        await bot.sendDocument(query.message.chat.id, pdf, { filename: `ariya_${team.teamId}.pdf`, contentType: 'application/pdf', caption: `📄 "${team.teamName}" jamoasi arizasi` });
        await bot.answerCallbackQuery(query.id);
    }
});

// -------------------- SERVER --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda`));

loadData().then(() => console.log('✅ Bot ishga tushdi')).catch(console.error);
