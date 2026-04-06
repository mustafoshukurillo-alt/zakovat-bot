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

// ========== POLLING OPTIMALLASHTIRISH ==========
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: {
        interval: 500,
        timeout: 60,
        limit: 50,
        retryTimeout: 10000
    }
});

// Webhook ni o'chirish (bir marta)
(async () => {
    try {
        await bot.deleteWebHook();
        console.log('✅ Webhook o\'chirildi');
    } catch(e) {}
})();

// -------------------- MA'LUMOTLAR YO'LLARI --------------------
const DB_PATH = path.join(__dirname, 'db.json');
const EMPLOYEES_PATH = path.join(__dirname, 'employees.json');

// -------------------- BO'LIMLAR RO'YXATI (33 ta) --------------------
const DEPARTMENTS_LIST = [
    "Asbobsozlik sexi", "Avtobuslar yig'ish sexi", "Axborot-kommunikatsiya texnologiyalari va axborot xavfsizligi bo'limi",
    "Bo'yash sexi", "Buxgalteriya hisobi departamenti", "Elektr jabduqlar ishlab chiqarish sexi",
    "ERP-mahsulotni boshqarish bo'limi", "Integratsiya guruhi", "Integratsiyalashgan boshqaruv tizimi bo'limi",
    "Ishlab chiqarish jarayonlarini optimallashtirish bo'limi", "Ishlab chiqarish-mexanika sexi",
    "Ishlab chiqarishni rejalashtirish departamenti", "Istiqbol ishlanmalar departamenti",
    "Konstruktorlik ishlanmalar departamenti", "Kuzovlar ishlab chiqarish sexi", "Ma'muriy masalalar departamenti",
    "Markaziy zavod laboratoriyasi", "Marketing departamenti", "Mehnat muhofazasi, texnika xavfsizligi va yong'in xavfsizligi bo'limi",
    "Moddiy ta'minot departamenti", "Moliya-iqtisod departamenti", "Muhandislik ta'minoti departamenti",
    "Payvandlash sexi", "Plastmass detallar ishlab chiqarish sexi", "Rahbarlar yordamchilari",
    "Savdo va sotishdan keyingi xizmat departamenti", "Sifat nazorati departamenti", "Shassi va kabinalarni yig'ish sexi",
    "Tayyorlov sexi", "Texnologik ta'minot departamenti", "Xavfsizlik bo'limi",
    "Xodimlarni boshqarish (HR) departamenti", "Yuk avtomobillari kuzovlarini yig'ish sexi"
];

// -------------------- GLOBAL O'ZGARUVCHILAR --------------------
let db = { teams: [], individuals: [], registrationOpen: true };
let employees = { employees: [] };
const userSessions = new Map();

// -------------------- YUKLASH VA SAQLASH --------------------
async function loadData() {
    try {
        const dbRaw = await fs.readFile(DB_PATH, 'utf8');
        db = JSON.parse(dbRaw);
        console.log('✅ db.json yuklandi, jamoalar:', db.teams.length, 'yakkalar:', db.individuals.length);
    } catch {
        db = { teams: [], individuals: [], registrationOpen: true };
        await saveDB();
        console.log('🆕 db.json yaratildi');
    }
    try {
        const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
        employees = JSON.parse(empRaw);
        if (!employees.employees) employees.employees = [];
        console.log('✅ employees.json yuklandi, xodimlar soni:', employees.employees.length);
    } catch (err) {
        console.error('employees.json topilmadi:', err.message);
        employees = { employees: [] };
    }
}
async function saveDB() { await fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8'); }

// -------------------- XODIM QIDIRISH --------------------
function findEmployee(department, name) {
    const normalizedInput = name.trim().toLowerCase();
    let found = employees.employees.find(emp =>
        emp.department === department && emp.name.toLowerCase() === normalizedInput);
    if (found) return found;
    found = employees.employees.find(emp =>
        emp.department === department && emp.name.toLowerCase().includes(normalizedInput));
    return found;
}

// -------------------- PDF ARIZA YARATISH --------------------
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

            doc.font('Helvetica-Bold');
            doc.text('№', 50, doc.y);
            doc.text('F.I.SH.', 80, doc.y);
            doc.text('Lavozim', 250, doc.y);
            doc.text('Bo‘lim', 350, doc.y);
            doc.text('Imzo', 450, doc.y);
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
                if (currentY > 700) { doc.addPage(); currentY = 50; }
            }
        }
        doc.moveDown(2);
        doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, { align: 'right' });
        doc.text(isIndividual ? 'Ishtirokchi imzosi: ____________________' : 'Sardor imzosi: ____________________', { align: 'right' });
        doc.text('Tashkilot muhri: ____________________', { align: 'right' });
        doc.end();
    });
}

// -------------------- BO'LIMLARNI 4 XABARGA BO'LIB CHIQARISH --------------------
const DEPTS_PER_MESSAGE = 9; // 33/4 ≈ 8.25, har bir xabarda 9 tadan

async function showDepartmentsPaged(chatId, prefix, page = 0) {
    const totalMessages = Math.ceil(DEPARTMENTS_LIST.length / DEPTS_PER_MESSAGE);
    const start = page * DEPTS_PER_MESSAGE;
    const end = start + DEPTS_PER_MESSAGE;
    const pageDepts = DEPARTMENTS_LIST.slice(start, end);
    
    const buttons = pageDepts.map(dept => ([{ text: dept, callback_data: `${prefix}_${dept}` }]));
    
    const navRow = [];
    if (page > 0) navRow.push({ text: "⬅️ Oldingi", callback_data: `${prefix}_page_${page-1}` });
    if (page < totalMessages - 1) navRow.push({ text: "Keyingi ➡️", callback_data: `${prefix}_page_${page+1}` });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
    
    await bot.sendMessage(chatId, `📌 Bo'limni tanlang (${page+1}/${totalMessages}):`, { reply_markup: { inline_keyboard: buttons } });
}

// -------------------- RANDOM JAMOA YARATISH (INDIVIDUALLARDAN) --------------------
async function createRandomTeams(chatId, adminId) {
    if (db.individuals.length < 5) {
        await bot.sendMessage(chatId, "❌ Random jamoa yaratish uchun kamida 5 ta individual ishtirokchi kerak.");
        return false;
    }
    
    // Tasodifiy aralashtirish
    const shuffled = [...db.individuals];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    
    const newTeams = [];
    const usedIds = new Set();
    const formedIndividuals = [];
    
    for (let i = 0; i + 5 <= shuffled.length; i += 5) {
        const group = shuffled.slice(i, i + 5);
        const members = group.map(ind => ({
            name: ind.name,
            position: ind.position || '—',
            department: ind.department
        }));
        const teamId = Date.now() + i;
        newTeams.push({
            teamId: teamId,
            teamName: `Random guruh ${Math.floor(i/5) + 1}`,
            captainName: members[0].name,
            captainDepartment: members[0].department,
            members: members,
            createdBy: adminId,
            createdAt: new Date().toISOString()
        });
        group.forEach(ind => {
            usedIds.add(ind.id);
            formedIndividuals.push(ind);
        });
    }
    
    // Saqlash
    db.teams.push(...newTeams);
    db.individuals = db.individuals.filter(ind => !usedIds.has(ind.id));
    await saveDB();
    
    // Har bir ishtirokchiga xabar yuborish
    for (const team of newTeams) {
        const membersTelegramIds = team.members.map((_, idx) => {
            const original = shuffled.find(ind => ind.name === team.members[idx].name);
            return original?.telegramUserId;
        }).filter(id => id);
        
        const teamText = `🎉 Tabriklaymiz! Siz random jamoa tarkibiga kiritildingiz!\n\n🏷 Jamoa nomi: ${team.teamName}\n👨‍💼 Sardor: ${team.captainName}\n👥 A'zolar:\n${team.members.map((m,i) => `${i+1}. ${m.name} (${m.department})`).join('\n')}\n\n✅ Arizangiz avtomatik yaratildi.`;
        
        // PDF yaratish va yuborish (sardorga)
        const pdfBuffer = await generateApplicationPDF({
            teamName: team.teamName,
            captainName: team.captainName,
            captainDepartment: team.captainDepartment,
            members: team.members
        }, false);
        
        // Sardorga (birinchi a'zoga) PDF yuboramiz
        if (membersTelegramIds[0]) {
            try {
                await bot.sendDocument(membersTelegramIds[0], pdfBuffer, {
                    filename: `random_ariya_${team.teamId}.pdf`,
                    contentType: 'application/pdf',
                    caption: teamText
                });
            } catch(e) { console.error('Xabar yuborish xatosi:', e.message); }
        }
    }
    
    await bot.sendMessage(chatId, `🎉 ${newTeams.length} ta random jamoa yaratildi! Qolgan individual ishtirokchilar: ${db.individuals.length}`);
    return true;
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
    const teamMembers = members.map((m, idx) => ({
        name: m.name,
        position: m.position || '—',
        department: m.department,
        role: idx === 0 ? 'Sardor' : 'A\'zo'
    }));
    const newTeam = {
        teamId: Date.now(),
        teamName,
        captainName: members[0].name,
        captainDepartment: members[0].department,
        members: teamMembers,
        createdBy: userId,
        createdAt: new Date().toISOString()
    };
    db.teams.push(newTeam);
    await saveDB();

    const pdfBuffer = await generateApplicationPDF({
        teamName,
        captainName: members[0].name,
        captainDepartment: members[0].department,
        members: members.map(m => ({ name: m.name, position: m.position, department: m.department }))
    }, false);

    await bot.sendDocument(chatId, pdfBuffer, {
        filename: `ariya_${newTeam.teamId}.pdf`,
        contentType: 'application/pdf',
        caption: `✅ "${teamName}" jamoasi muvaffaqiyatli ro'yxatdan o'tdi!\n\n📄 Ariza faylingiz. Iltimos, uni imzolab Yoshlar kengashiga topshiring.`
    });
    
    let membersList = members.map((m, i) => `${i+1}. ${m.name} (${m.department})`).join('\n');
    await bot.sendMessage(chatId, `🎉 Tabriklaymiz! "${teamName}" jamoasi ro'yxatdan o'tdi!\n\nJamoa tarkibi:\n${membersList}\n\nSana: ${new Date().toLocaleDateString('uz-UZ')}\n\nArizani yuklab oldingiz. Omad!`, getMainMenuKeyboard());
    userSessions.delete(chatId);
}

// -------------------- YAKKA RO'YXAT --------------------
async function finalizeIndividual(chatId, userId, department, name) {
    const emp = findEmployee(department, name);
    const finalName = emp ? emp.name : name;
    const position = emp ? emp.position : '';
    const newIndividual = {
        id: Date.now(),
        name: finalName,
        department: department,
        position: position,
        registeredAt: new Date().toISOString(),
        telegramUserId: userId
    };
    db.individuals.push(newIndividual);
    await saveDB();

    const pdfBuffer = await generateApplicationPDF({
        name: finalName,
        department: department,
        position: position,
        registeredAt: newIndividual.registeredAt
    }, true);

    await bot.sendDocument(chatId, pdfBuffer, {
        filename: `individual_${newIndividual.id}.pdf`,
        contentType: 'application/pdf',
        caption: `✅ Siz individual ro'yxatdan o'tdingiz!\n\n📄 Ariza faylingiz. Iltimos, uni imzolab Yoshlar kengashiga topshiring.`
    });
    await bot.sendMessage(chatId, "Arizani yuklab oldingiz. Turnirda omad!", getMainMenuKeyboard());
    userSessions.delete(chatId);
}

// -------------------- BOT HANDLERLARI --------------------
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        "Assalomu alaykum! Siz SamAuto Zakovat o'yinida ro'yxatdan o'tish botiga xush keldingiz!\n\n" +
        "📌 **Jamoaviy ro'yxatdan o'tish**: 5 kishidan iborat jamoa tuzasiz (sardor + 4 a'zo).\n" +
        "📌 **Individual ro'yxatdan o'tish**: Jamoasi bo'lmagan ishtirokchilar uchun.\n" +
        "📌 **Mening jamoam**: Jamoa sardori uchun PDF ariza.\n\n" +
        "Quyidagi tugmalar orqali ro'yxatdan o'ting:",
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
    );
});

bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(chatId, "⛔ Faqat adminlar.");

    const stats = `📊 **Statistika**\n• Jamoalar: ${db.teams.length}\n• Yakka ishtirokchilar: ${db.individuals.length}\n• Jami: ${db.teams.length * 5 + db.individuals.length}\n\nRo'yxat: ${db.registrationOpen ? "✅ Ochiq" : "🔴 Yopiq"}`;

    const adminButtons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 Jamoalar", callback_data: "admin_teams" }],
                [{ text: "👤 Yakkalar", callback_data: "admin_individuals" }],
                [{ text: "🎲 Random jamoa", callback_data: "admin_random_teams" }],
                [{ text: "📁 Barcha PDF (ZIP)", callback_data: "admin_export_zip" }],
                [{ text: db.registrationOpen ? "🔒 Yopish" : "🔓 Ochish", callback_data: "admin_toggle" }]
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
    
    // Darhol callback query ga javob berish (takroriy xabarlarni oldini olish)
    bot.answerCallbackQuery(query.id).catch(() => {});
    
    try {
        if (data === 'cancel') {
            userSessions.delete(chatId);
            await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
            return;
        }
        
        // Admin
        if (ADMIN_IDS.includes(userId)) {
            if (data === 'admin_teams') {
                let msg = db.teams.length ? "📋 Jamoalar:\n\n" + db.teams.map((t,i)=>`${i+1}. ${t.teamName}\n   Sardor: ${t.captainName}\n   Sana: ${new Date(t.createdAt).toLocaleDateString()}\n`).join('\n') : "Hech qanday jamoa yo'q";
                await bot.sendMessage(chatId, msg);
                return;
            }
            if (data === 'admin_individuals') {
                let msg = db.individuals.length ? "👤 Yakkalar:\n\n" + db.individuals.map((ind,i)=>`${i+1}. ${ind.name} (${ind.department})`).join('\n') : "Hech qanday yakka yo'q";
                await bot.sendMessage(chatId, msg);
                return;
            }
            if (data === 'admin_random_teams') {
                await createRandomTeams(chatId, userId);
                return;
            }
            if (data === 'admin_export_zip') {
                await bot.sendMessage(chatId, "⏳ ZIP tayyorlanmoqda...");
                try {
                    const archiver = require('archiver');
                    const zipPath = path.join(__dirname, `arizalar_${Date.now()}.zip`);
                    const output = require('fs').createWriteStream(zipPath);
                    const archive = archiver('zip', { zlib: { level: 9 } });
                    output.on('close', async () => {
                        await bot.sendDocument(chatId, zipPath, { filename: 'barcha_arizalar.zip', caption: `📦 Barcha arizalar (${db.teams.length} jamoa + ${db.individuals.length} yakka)` });
                        await fs.unlink(zipPath);
                    });
                    archive.pipe(output);
                    for (const team of db.teams) {
                        const pdf = await generateApplicationPDF({
                            teamName: team.teamName,
                            captainName: team.captainName,
                            captainDepartment: team.captainDepartment,
                            members: team.members
                        }, false);
                        archive.append(pdf, { name: `jamoa_${team.teamId}.pdf` });
                    }
                    for (const ind of db.individuals) {
                        const pdf = await generateApplicationPDF({
                            name: ind.name,
                            department: ind.department,
                            position: ind.position,
                            registeredAt: ind.registeredAt
                        }, true);
                        archive.append(pdf, { name: `individual_${ind.id}.pdf` });
                    }
                    await archive.finalize();
                } catch (err) {
                    await bot.sendMessage(chatId, `❌ ZIP yaratishda xatolik: ${err.message}`);
                }
                return;
            }
            if (data === 'admin_toggle') {
                db.registrationOpen = !db.registrationOpen;
                await saveDB();
                await bot.sendMessage(chatId, `Ro'yxat ${db.registrationOpen ? "ochiq" : "yopiq"}`);
                return;
            }
        }
        
        // Bo'lim sahifalash
        if (data.includes('_page_')) {
            const parts = data.split('_page_');
            const prefix = parts[0];
            const page = parseInt(parts[1]);
            await showDepartmentsPaged(chatId, prefix, page);
            return;
        }
        
        // JAMOA: sardor bo'limi
        if (data.startsWith('team_captain_dept_') && !data.includes('_page_')) {
            const department = data.slice(18);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return;
            }
            userSessions.set(chatId, { ...session, currentDepartment: department, currentRole: 'captain', step: 'awaiting_member_name', memberIndex: 1 });
            await bot.sendMessage(chatId, "👨‍💼 Sardorning to'liq ismini kiriting:");
            return;
        }
        
        // JAMOA: a'zo bo'limi
        if (data.startsWith('team_member_dept_') && !data.includes('_page_')) {
            const department = data.slice(17);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return;
            }
            const nextIndex = (session.members?.length || 0) + 1;
            userSessions.set(chatId, { ...session, currentDepartment: department, currentRole: 'member', step: 'awaiting_member_name', memberIndex: nextIndex });
            await bot.sendMessage(chatId, `👥 ${nextIndex}-a'zoning to'liq ismini kiriting:`);
            return;
        }
        
        // YAKKA: bo'lim
        if (data.startsWith('individual_dept_') && !data.includes('_page_')) {
            const department = data.slice(16);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Avval 'Individual ro'yxatga olish' tugmasini bosing.");
                return;
            }
            userSessions.set(chatId, { step: 'awaiting_individual_name', department, userId });
            await bot.sendMessage(chatId, "📝 To'liq ismingizni kiriting:");
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
    
    // Asosiy menyu
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
        await showDepartmentsPaged(chatId, 'individual_dept', 0);
        return;
    }
    if (text === "📄 Mening jamoam") {
        const userTeam = db.teams.find(t => t.createdBy === userId);
        if (!userTeam) return bot.sendMessage(chatId, "Siz jamoa sardori emassiz.");
        const pdf = await generateApplicationPDF({
            teamName: userTeam.teamName,
            captainName: userTeam.captainName,
            captainDepartment: userTeam.captainDepartment,
            members: userTeam.members
        }, false);
        return bot.sendDocument(chatId, pdf, { filename: `ariya_${userTeam.teamId}.pdf`, contentType: 'application/pdf' });
    }
    if (text === "ℹ️ Yordam") {
        return bot.sendMessage(chatId, "📌 **Yordam**\n• Jamoa: 5 a'zo (sardor + 4)\n• Yakka: o'zingizni ro'yxatga olish\n• Mening jamoam: PDF ariza\n• Admin: /admin\n• Bekor qilish: /cancel", { parse_mode: 'Markdown' });
    }
    
    // Jamoa nomi
    if (session && session.step === 'awaiting_team_name') {
        if (text.length > 50) return bot.sendMessage(chatId, "Nomi 50 belgidan oshmasin.");
        session.teamName = text;
        session.step = 'awaiting_department';
        session.members = [];
        await bot.sendMessage(chatId, "Endi sardorning bo'limini tanlang:");
        await showDepartmentsPaged(chatId, 'team_captain_dept', 0);
        return;
    }
    
    // A'zo ismini qabul qilish
    if (session && session.step === 'awaiting_member_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Kamida 5 harf.");
        const emp = findEmployee(session.currentDepartment, name);
        const newMember = { name: emp ? emp.name : name, position: emp ? emp.position : '', department: session.currentDepartment };
        session.members.push(newMember);
        
        if (session.members.length === 5) {
            await finalizeTeam(chatId, userId, session);
        } else {
            const nextIndex = session.members.length + 1;
            await bot.sendMessage(chatId, `✅ A'zo qo'shildi. Endi ${nextIndex}-a'zoning bo'limini tanlang:`);
            await showDepartmentsPaged(chatId, 'team_member_dept', 0);
        }
        return;
    }
    
    // Yakka ro'yxat: ism
    if (session && session.step === 'awaiting_individual_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Kamida 5 harf.");
        await finalizeIndividual(chatId, userId, session.department, name);
        return;
    }
});

// -------------------- SERVER --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP ${PORT}`));

loadData().then(() => console.log('✅ Bot ishga tushdi')).catch(console.error);
