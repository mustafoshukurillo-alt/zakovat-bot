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

// -------------------- BO'LIMLAR RO'YXATI --------------------
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
        console.log('✅ db.json yuklandi, jamoalar:', db.teams.length);
    } catch {
        db = { teams: [], individuals: [], registrationOpen: true };
        await saveDB();
    }
    try {
        const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
        employees = JSON.parse(empRaw);
        if (!employees.employees) employees.employees = [];
        console.log('✅ employees.json yuklandi, xodimlar:', employees.employees.length);
    } catch (err) {
        console.log('employees.json topilmadi, bo\'sh bazadan foydalaniladi');
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
            }
        }

        doc.moveDown(2);
        doc.text(`Sana: ${new Date().toLocaleDateString('uz-UZ')}`, { align: 'right' });
        doc.text(isIndividual ? 'Ishtirokchi imzosi: ____________________' : 'Sardor imzosi: ____________________', { align: 'right' });
        doc.text('Tashkilot muhri: ____________________', { align: 'right' });
        doc.end();
    });
}

// -------------------- BO'LIMLARNI SAHIFALASH --------------------
const DEPTS_PER_PAGE = 12;

async function showDepartments(chatId, prefix, page = 0) {
    const totalPages = Math.ceil(DEPARTMENTS_LIST.length / DEPTS_PER_PAGE);
    const start = page * DEPTS_PER_PAGE;
    const end = start + DEPTS_PER_PAGE;
    const pageDepts = DEPARTMENTS_LIST.slice(start, end);
    
    const buttons = pageDepts.map(dept => ([{ text: dept, callback_data: `${prefix}_${dept}` }]));
    
    const navRow = [];
    if (page > 0) navRow.push({ text: "⬅️ Oldingi", callback_data: `${prefix}_page_${page-1}` });
    if (page < totalPages - 1) navRow.push({ text: "Keyingi ➡️", callback_data: `${prefix}_page_${page+1}` });
    if (navRow.length) buttons.push(navRow);
    buttons.push([{ text: "❌ Bekor qilish", callback_data: "cancel" }]);
    
    await bot.sendMessage(chatId, `📌 Bo'limni tanlang (${page+1}/${totalPages}):`, { reply_markup: { inline_keyboard: buttons } });
    
    const session = userSessions.get(chatId) || {};
    userSessions.set(chatId, { ...session, deptPage: page });
}

// -------------------- ASOSIY MENYU --------------------
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

// -------------------- BOT HANDLERLARI --------------------
bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id,
        "Assalomu alaykum! Siz SamAuto Zakovat o'yinida ro'yxatdan o'tish botiga xush keldingiz!\n\n" +
        "📌 **Jamoaviy ro'yxatdan o'tish**: 5 kishidan iborat jamoa (sardor + 4 a'zo)\n" +
        "📌 **Individual ro'yxatdan o'tish**: Jamoasi bo'lmagan ishtirokchilar uchun\n" +
        "📌 **Mening jamoam**: Jamoa sardori uchun PDF ariza\n\n" +
        "Quyidagi tugmalar orqali ro'yxatdan o'ting:",
        { parse_mode: 'Markdown', ...getMainMenuKeyboard() }
    );
});

bot.onText(/\/admin/, async (msg) => {
    const chatId = msg.chat.id;
    if (!ADMIN_IDS.includes(msg.from.id)) return bot.sendMessage(chatId, "⛔ Faqat adminlar.");
    
    const stats = `📊 **Statistika**\n• Jamoalar: ${db.teams.length}\n• Yakka: ${db.individuals.length}\n• Jami: ${db.teams.length * 5 + db.individuals.length}\n\nRo'yxat: ${db.registrationOpen ? "✅ Ochiq" : "🔴 Yopiq"}`;
    
    const adminButtons = {
        reply_markup: {
            inline_keyboard: [
                [{ text: "📋 Jamoalar", callback_data: "admin_teams" }],
                [{ text: "👤 Yakkalar", callback_data: "admin_individuals" }],
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

    try {
        if (data === 'cancel') {
            userSessions.delete(chatId);
            await bot.sendMessage(chatId, "Bekor qilindi.", getMainMenuKeyboard());
            return bot.answerCallbackQuery(query.id);
        }

        // Admin
        if (ADMIN_IDS.includes(userId)) {
            if (data === 'admin_teams') {
                let msg = db.teams.length ? "📋 Jamoalar:\n\n" + db.teams.map((t,i)=>`${i+1}. ${t.teamName}\n   Sardor: ${t.captainName}\n   Sana: ${new Date(t.createdAt).toLocaleDateString()}\n`).join('\n') : "Hech qanday jamoa yo'q";
                await bot.sendMessage(chatId, msg);
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_individuals') {
                let msg = db.individuals.length ? "👤 Yakkalar:\n\n" + db.individuals.map((ind,i)=>`${i+1}. ${ind.name} (${ind.department})`).join('\n') : "Hech qanday yakka yo'q";
                await bot.sendMessage(chatId, msg);
                return bot.answerCallbackQuery(query.id);
            }
            if (data === 'admin_toggle') {
                db.registrationOpen = !db.registrationOpen;
                await saveDB();
                await bot.sendMessage(chatId, `Ro'yxat ${db.registrationOpen ? "ochiq" : "yopiq"}`);
                return bot.answerCallbackQuery(query.id);
            }
        }

        // Bo'lim sahifalash
        if (data.includes('_page_')) {
            const parts = data.split('_page_');
            const prefix = parts[0];
            const page = parseInt(parts[1]);
            await showDepartments(chatId, prefix, page);
            return bot.answerCallbackQuery(query.id);
        }

        // JAMOA: sardor bo'limi
        if (data.startsWith('team_captain_dept_')) {
            const department = data.slice(18);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return bot.answerCallbackQuery(query.id);
            }
            userSessions.set(chatId, { ...session, currentDepartment: department, currentRole: 'captain', step: 'awaiting_member_name', memberIndex: 1 });
            await bot.sendMessage(chatId, "👨‍💼 Sardorning to'liq ismini kiriting:");
            return bot.answerCallbackQuery(query.id);
        }

        // JAMOA: a'zo bo'limi
        if (data.startsWith('team_member_dept_')) {
            const department = data.slice(17);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Avval 'Jamoani ro'yxatga olish' tugmasini bosing.");
                return bot.answerCallbackQuery(query.id);
            }
            const nextIndex = (session.members?.length || 0) + 1;
            userSessions.set(chatId, { ...session, currentDepartment: department, currentRole: 'member', step: 'awaiting_member_name', memberIndex: nextIndex });
            await bot.sendMessage(chatId, `👥 ${nextIndex}-a'zoning to'liq ismini kiriting:`);
            return bot.answerCallbackQuery(query.id);
        }

        // YAKKA: bo'lim
        if (data.startsWith('individual_dept_')) {
            const department = data.slice(16);
            if (!session || session.step !== 'awaiting_department') {
                await bot.sendMessage(chatId, "Avval 'Individual ro'yxatga olish' tugmasini bosing.");
                return bot.answerCallbackQuery(query.id);
            }
            userSessions.set(chatId, { step: 'awaiting_individual_name', department, userId });
            await bot.sendMessage(chatId, "📝 To'liq ismingizni kiriting:");
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

    // JAMOA YARATISH
    if (text === "👥 Jamoani ro'yxatga olish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "❌ Ro'yxat yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'awaiting_team_name', teamName: '', members: [], userId });
        return bot.sendMessage(chatId, "🏷 Jamoa nomini kiriting:");
    }

    // YAKKA RO'YXAT
    if (text === "👤 Individual ro'yxatga olish") {
        if (!db.registrationOpen) return bot.sendMessage(chatId, "Ro'yxat yopilgan.");
        if (userSessions.has(chatId)) return bot.sendMessage(chatId, "Avvalgi jarayon tugallanmagan. /cancel");
        userSessions.set(chatId, { step: 'awaiting_department', userId });
        await showDepartments(chatId, 'individual_dept', 0);
        return;
    }

    // Mening jamoam
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
        await showDepartments(chatId, 'team_captain_dept', 0);
        return;
    }

    // A'zo ismini qabul qilish
    if (session && session.step === 'awaiting_member_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Kamida 5 harf.");
        
        const emp = findEmployee(session.currentDepartment, name);
        const newMember = { 
            name: emp ? emp.name : name, 
            position: emp ? emp.position : '', 
            department: session.currentDepartment 
        };
        session.members.push(newMember);

        if (session.members.length === 5) {
            // Jamoa to'liq, yakunlash
            const newTeam = {
                teamId: Date.now(),
                teamName: session.teamName,
                captainName: session.members[0].name,
                captainDepartment: session.members[0].department,
                members: session.members,
                createdBy: userId,
                createdAt: new Date().toISOString()
            };
            db.teams.push(newTeam);
            await saveDB();

            const pdf = await generateApplicationPDF({
                teamName: newTeam.teamName,
                captainName: newTeam.captainName,
                captainDepartment: newTeam.captainDepartment,
                members: newTeam.members
            }, false);

            await bot.sendDocument(chatId, pdf, { filename: `ariya_${newTeam.teamId}.pdf`, contentType: 'application/pdf', caption: `✅ "${newTeam.teamName}" jamoasi ro'yxatdan o'tdi!` });
            
            let list = session.members.map((m,i) => `${i+1}. ${m.name} (${m.department})`).join('\n');
            await bot.sendMessage(chatId, `🎉 Tabriklaymiz!\n\nJamoa: ${session.teamName}\nSana: ${new Date().toLocaleDateString()}\n\nTarkib:\n${list}\n\nArizani imzolab Yoshlar kengashiga topshiring!`, getMainMenuKeyboard());
            userSessions.delete(chatId);
        } else {
            // Keyingi a'zo
            const nextIndex = session.members.length + 1;
            await bot.sendMessage(chatId, `✅ A'zo qo'shildi. Endi ${nextIndex}-a'zoning bo'limini tanlang:`);
            await showDepartments(chatId, 'team_member_dept', 0);
        }
        return;
    }

    // Yakka ro'yxat: ism
    if (session && session.step === 'awaiting_individual_name') {
        const name = text.trim();
        if (name.length < 5) return bot.sendMessage(chatId, "❌ Kamida 5 harf.");
        
        const emp = findEmployee(session.department, name);
        const finalName = emp ? emp.name : name;
        const position = emp ? emp.position : '';
        
        const newIndividual = {
            id: Date.now(),
            name: finalName,
            department: session.department,
            position: position,
            registeredAt: new Date().toISOString(),
            telegramUserId: userId
        };
        db.individuals.push(newIndividual);
        await saveDB();

        const pdf = await generateApplicationPDF({
            name: finalName,
            department: session.department,
            position: position,
            registeredAt: newIndividual.registeredAt
        }, true);

        await bot.sendDocument(chatId, pdf, { filename: `individual_${newIndividual.id}.pdf`, contentType: 'application/pdf', caption: `✅ Siz ro'yxatdan o'tdingiz!` });
        await bot.sendMessage(chatId, "Arizani imzolab Yoshlar kengashiga topshiring!", getMainMenuKeyboard());
        userSessions.delete(chatId);
        return;
    }
});

// -------------------- SERVER --------------------
const app = express();
app.get('/', (req, res) => res.send('Zakovat bot ishlayapti'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`HTTP ${PORT}`));

loadData().then(() => console.log('✅ Bot ishga tushdi')).catch(console.error);
