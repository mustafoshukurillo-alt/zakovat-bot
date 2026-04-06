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

// Polling konfiguratsiyasi - takroriy xabarlarni oldini olish
const bot = new TelegramBot(BOT_TOKEN, { 
    polling: {
        interval: 500,
        timeout: 60,
        limit: 50,
        retryTimeout: 10000
    }
});

// Webhook ni o'chirish (bir marta ishga tushganda)
(async () => {
    try {
        await bot.deleteWebHook();
        console.log('✅ Webhook o\'chirildi');
    } catch (e) {}
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
        console.error('employees.json topilmadi yoki xato:', err.message);
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

        doc.fontSize(18).font('Helvetica-Bold').text('SAM AUTO ZAKOVAT TURNIRI', { align: 'center' });
        doc.moveDown(0.5).fontSize(16).text('QATNASHISH UCHUN ARIZA', { align: 'center' });
        doc.moveDown(1.5);

        if (isIndividual) {
            doc.fontSize(12).text(`Ishtirokchi: ${teamData.name}`, { underline: true });
            doc.text(`Bo'lim: ${teamData.department}`);
            doc.text(`Lavozim: ${teamData.position || '—'}`);
            doc.text(`Ro'yxatga olingan sana: ${new Date(teamData.registeredAt).toLocaleString('uz-UZ')}`);
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
                if (currentY > 700) {
                    doc.addPage();
                    currentY = 50;
                    doc.font('Helvetica-Bold');
                    doc.text('№', 50, currentY);
                    doc.text('F.I.SH.', 80, currentY);
                    doc.text('Lavozim', 250, currentY);
                    doc.text('Bo‘lim', 350, currentY);
                    doc.text('Imzo', 450, currentY);
                    doc.moveDown(0.5);
                    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
                    currentY = doc.y;
                    doc.font('Helvetica');
                }
            }
        }

        doc.moveDown(2);
        doc.font('Helvetica-Bold');
        doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, { align: 'right' });
        doc.moveDown(0.5);
        if (isIndividual) {
            doc.text('Ishtirokchi imzosi: ____________________', { align: 'right' });
        } else {
            doc.text('Sardor imzosi: ____________________', { align: 'right' });
        }
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

// -------------------- BO'LIMLARNI 4 TA SAHIFAGA BO'LISH --------------------
const DEPARTMENTS_PER_PAGE = Math.ceil(DEPARTMENTS_LIST.length / 4); // 9 tadan (33/4=8.25 -> 9)

async function showDepartments(chatId, prefix, page = 0) {
    const totalPages = 4;
    const start = page * DEPARTMENTS_PER_PAGE;
    const end = start + DEPARTMENTS_PER_PAGE;
    const pageDepts = DEPARTMENTS_LIST.slice(start, end);
    
    const buttons = [];
    for (let i = 0; i < pageDepts.length; i++) {
        buttons.push([{ text: pageDepts[i], callback_data: `${prefix}_${pageDepts[i]}` }]);
    }
    
    // Navigatsiya tugmalari (4 ta sahifa)
    const navRow = [];
    for (let i = 0; i < totalPages; i++) {
        navRow.push({ text: i === page ? `📌 ${i+1}` : `${i+1}`, callback_data: `${prefix}_page_${i}` });
    }
    buttons.push(navRow);
    buttons.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
    
    await bot.sendMessage(chatId, `📌 Iltimos, bo'limni tanlang (${page+1}/${totalPages} sahifa):`, { reply_markup: { inline_keyboard: buttons } });
    
    const session = userSessions.get(chatId) || {};
    userSessions.set(chatId, { ...session, deptPage: page, deptPrefix: prefix });
}

// -------------------- TASODIFIY JAMOA YARATISH (YAKKALARDAN) --------------------
async function createRandomTeams(chatId, userId) {
    if (db.individuals.length < 5) {
        await bot.sendMessage(chatId, "❌ Tasodifiy jamoa yaratish uchun kamida 5 ta yakka ishtirokchi kerak.");
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
    let teamCounter = 1;
    
    for (let i = 0; i + 5 <= shuffled.length; i += 5) {
        const group = shuffled.slice(i, i + 5);
        const teamId = Date.now() + teamCounter;
        const teamName = `Random guruh ${teamCounter}`;
        const captain = group[0];
        
        const newTeam = {
            teamId: teamId,
            teamName: teamName,
            captainName: captain.name,
            captainDepartment: captain.department,
            members: group.map((m, idx) => ({
                name: m.name,
                position: m.position || '—',
                department: m.department,
                role: idx === 0 ? 'Sardor' : 'A\'zo'
            })),
            createdBy: userId,
            createdAt: new Date().toISOString()
        };
        newTeams.push(newTeam);
        group.forEach(m => usedIds.add(m.id));
        teamCounter++;
    }
    
    // Qolgan yakkalarni saqlash
    const remaining = shuffled.filter(m => !usedIds.has(m.id));
    
    // Jamoalarni qo'shish
    db.teams.push(...newTeams);
    db.individuals = remaining;
    await saveDB();
    
    // Har bir jamoa sardoriga xabar yuborish
    for (const team of newTeams) {
        // Sardor Telegram ID sini topish (individual ro'yxatda saqlangan)
        const captainOriginal = shuffled.find(m => m.name === team.captainName && m.department === team.captainDepartment);
        if (captainOriginal && captainOriginal.telegramUserId) {
            try {
                await bot.sendMessage(captainOriginal.telegramUserId, 
                    `🎉 Tabriklaymiz! Siz "${team.teamName}" jamoasining sardori etib tayinlandingiz!\n\nJamoa tarkibi:\n${team.members.map((m,i) => `${i+1}. ${m.name} (${m.department})`).join('\n')}\n\nArizangizni /start orqali "Mening jamoam" tugmasidan yuklab olishingiz mumkin.`);
            } catch(e) {}
        }
    }
    
    await bot.sendMessage(chatId, `🎲 ${newTeams.length} ta tasodifiy jamoa yaratildi!\nQolgan yakka ishtirokchilar: ${remaining.length}`);
    return true;
}

// -------------------- RESET BOT (TOZALASH) --------------------
async function resetBot(chatId) {
    // Bazani tozalash
    db = { teams: [], individuals: [], registrationOpen: true };
    await saveDB();
    // Vaqtinchalik fayllarni o'chirish
    try {
        const files = await fs.readdir(__dirname);
        for (const file of files) {
            if (file.startsWith('temp_') || file.startsWith('ariya_') || file.startsWith('individual_')) {
                await fs.unlink(path.join(__dirname, file)).catch(()=>{});
            }
        }
    } catch(e) {}
    // Sessiyalarni tozalash
    userSessions.clear();
    await bot.sendMessage(chatId, "✅ Bot to'liq tozalandi! Barcha jamoalar, yakkalar va vaqtinchalik fayllar o'chirildi.\n\nBotni qayta ishga tushirish shart emas, yangidan ro'yxatga olish mumkin.");
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
        "📌 **Jamoaviy ro'yxatdan o'tish**: 5 kishidan iborat jamoa tuzasiz (sardor + 4 a'zo). Har bir a'zo uchun bo'lim va to'liq ism kiritiladi.\n" +
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
    if (userSessions.has(chatId)) userSessions.delete(chatId);
    bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
});

// -------------------- CALLBACK QUERY --------------------
bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const userId = query.from.id;
    const data = query.data;
    const session = userSessions.get(chatId);
    
    // Darhol callback query ga javob berish (takroriy xabarlarning oldini olish)
    bot.answerCallbackQuery(query.id).catch(() => {});
    
    try {
        if (data === 'cancel') {
            userSessions.delete(chatId);
            await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
            return;
        }

        // Admin
        if (ADMIN_IDS.includes(userId)) {
            if (data === 'admin_teams_list') {
                if (db.teams.length === 0) await bot.sendMessage(chatId, "Hech qanday jamoa yo'q.");
                else {
                    let msg = "📋 **Jamoalar ro'yxati:**\n\n";
                    db.teams.forEach((t, i) => {
                        msg += `${i+1}. ${t.teamName}\n   Sardor: ${t.captainName}\n   A'zolar: ${t.members.length} kishi\n   Ro'yxatdan o'tgan: ${new Date(t.createdAt).toLocaleDateString('uz-UZ')}\n\n`;
                    });
                    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                }
                return;
            }
            if (data === 'admin_individuals_list') {
                if (db.individuals.length === 0) await bot.sendMessage(chatId, "Hech qanday yakka ishtirokchi yo'q.");
                else {
                    let msg = "👤 **Yakka ishtirokchilar ro'yxati:**\n\n";
                    db.individuals.forEach((ind, i) => {
                        msg += `${i+1}. ${ind.name} (${ind.department})\n   Ro'yxatdan o'tgan: ${new Date(ind.registeredAt).toLocaleDateString('uz-UZ')}\n\n`;
                    });
                    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
                }
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
                            name: ind.name,
                            department: ind.department,
                            position: ind.position,
                            registeredAt: ind.registeredAt
                        }, true);
                        archive.append(pdfBuffer, { name: `individual_${ind.id}.pdf` });
                    }
                    await archive.finalize();
                } catch (err) {
                    console.error(err);
                    await bot.sendMessage(chatId, `❌ Xatolik: ${err.message}`);
                }
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

        // Bo'lim sahifalash (4 ta sahifa)
        if (data.includes('_page_')) {
            const parts = data.split('_page_');
            const prefix = parts[0];
            const page = parseInt(parts[1]);
            await showDepartments(chatId, prefix, page);
            return;
        }

        // JAMOA YARATISH: bo'lim tanlash
        if (data.startsWith('team_captain_dept_') && !data.includes('_page_')) {
            const department = data.slice(18);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return;
            }
            const newSession = { ...session, currentDepartment: department, currentRole: 'captain' };
            await askMemberName(chatId, newSession, 1);
            return;
        }
        
        if (data.startsWith('team_member_dept_') && !data.includes('_page_')) {
            const department = data.slice(17);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return;
            }
            const newSession = { ...session, currentDepartment: department, currentRole: 'member' };
            const nextIndex = (session.members?.length || 0) + 1;
            await askMemberName(chatId, newSession, nextIndex);
            return;
        }

        // YAKKA RO'YXAT: bo'lim tanlash
        if (data.startsWith('individual_dept_') && !data.includes('_page_')) {
            const department = data.slice(16);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Iltimos, avval 'Individual ro'yxatga olish' tugmasini bosing.");
                return;
            }
            userSessions.set(chatId, { step: 'awaiting_individual_name', department, userId });
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

    // Asosiy menyu
    if (text === "👥 Jamoani ro'yxatga olish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "❌ Ro'yxatga olish yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'awaiting_team_name', teamName: '', members: [], userId });
        return bot.sendMessage(chatId, "🏷 Jamoa nomini kiriting:");
    }
    if (text === "👤 Individual ro'yxatga olish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "Ro'yxatga olish yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'awaiting_department', userId });
        await showDepartments(chatId, 'individual_dept', 0);
        return;
    }
    if (text === "📄 Mening jamoam") {
        const userTeam = db.teams.find(t => t.createdBy === userId);
        if (!userTeam) return bot.sendMessage(chatId, "Siz jamoa sardori emassiz yoki jamoa yaratmagansiz.");
        const pdfBuffer = await generateApplicationPDF({
            teamName: userTeam.teamName,
            captainName: userTeam.captainName,
            captainDepartment: userTeam.captainDepartment,
            members: userTeam.members.map(m => ({ name: m.name, position: m.position, department: m.department }))
        }, false);
        return bot.sendDocument(chatId, pdfBuffer, { filename: `ariya_${userTeam.teamId}.pdf`, contentType: 'application/pdf', caption: `📄 "${userTeam.teamName}" jamoasi arizasi` });
    }
    if (text === "ℹ️ Yordam") {
        return bot.sendMessage(chatId, "📌 **Yordam**\n\n• **Jamoani ro'yxatga olish**: 5 a'zo (sardor + 4). Har bir a'zo uchun bo'lim va to'liq ism kiritiladi.\n• **Individual ro'yxatga olish**: o'zingizning bo'limingiz va ismingiz. Keyin admin tasodifiy jamoalarga guruhlaydi.\n• **Mening jamoam**: faqat jamoa sardori uchun PDF ariza yuklash.\n• **Admin**: /admin\n• **Bekor qilish**: /cancel", { parse_mode: 'Markdown' });
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

    // A'zo ismini qabul qilish
    if (session && session.step === 'awaiting_member_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Ism familiya kamida 5 belgidan iborat bo'lishi kerak.");
        const department = session.currentDepartment;
        const emp = findEmployee(department, name);
        const finalName = emp ? emp.name : name;
        const position = emp ? emp.position : '';
        const newMember = { name: finalName, position: position, department: department };
        session.members.push(newMember);

        if (session.currentRole === 'captain') {
            if (session.members.length < 5) {
                session.currentRole = 'member';
                await bot.sendMessage(chatId, `✅ Sardor qo'shildi. Endi 2-a'zoning bo'limini tanlang:`);
                await showDepartments(chatId, 'team_member_dept', 0);
            } else {
                await finalizeTeam(chatId, userId, session);
            }
        } else {
            if (session.members.length < 5) {
                const nextIndex = session.members.length + 1;
                await bot.sendMessage(chatId, `✅ A'zo qo'shildi. Endi ${nextIndex}-a'zoning bo'limini tanlang:`);
                await showDepartments(chatId, 'team_member_dept', 0);
            } else {
                await finalizeTeam(chatId, userId, session);
            }
        }
        return;
    }

    // Yakka ro'yxat: ism kiritish
    if (session && session.step === 'awaiting_individual_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Ism familiya kamida 5 belgidan iborat bo'lishi kerak.");
        await finalizeIndividual(chatId, userId, session.department, name);
        return;
    }
});

// -------------------- SERVER --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP server ${PORT} portda`));

loadData().then(() => console.log('✅ Bot ishga tushdi')).catch(console.error);
