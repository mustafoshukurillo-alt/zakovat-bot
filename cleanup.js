const fs = require('fs').promises;
const path = require('path');

// -------------------- YO'LLAR --------------------
const DB_PATH = path.join(__dirname, 'db.json');
const EMPLOYEES_PATH = path.join(__dirname, 'employees.json');
const APPLICATIONS_DIR = path.join(__dirname, 'applications');
const TEMP_FILES_PATTERN = /^temp_.*\.(csv|json|pdf)$/;

async function cleanup() {
    console.log('🧹 Tozalash boshlandi...\n');

    // 1. db.json ni tozalash (jamoalar va yakkalarni o'chirish)
    try {
        const defaultDB = {
            teams: [],
            individuals: [],
            registrationOpen: true
        };
        await fs.writeFile(DB_PATH, JSON.stringify(defaultDB, null, 2), 'utf8');
        console.log('✅ db.json tozalandi (jamoalar va yakkalar o\'chirildi)');
    } catch (err) {
        console.log('❌ db.json tozalashda xatolik:', err.message);
    }

    // 2. applications papkasini tozalash (agar mavjud bo'lsa)
    try {
        const exists = await fs.access(APPLICATIONS_DIR).then(() => true).catch(() => false);
        if (exists) {
            const files = await fs.readdir(APPLICATIONS_DIR);
            for (const file of files) {
                await fs.unlink(path.join(APPLICATIONS_DIR, file));
            }
            console.log(`✅ applications papkasi tozalandi (${files.length} ta fayl o\'chirildi)`);
        } else {
            console.log('ℹ️ applications papkasi mavjud emas');
        }
    } catch (err) {
        console.log('❌ applications papkasini tozalashda xatolik:', err.message);
    }

    // 3. Vaqtinchalik fayllarni o'chirish (temp_*)
    try {
        const files = await fs.readdir(__dirname);
        let deletedCount = 0;
        for (const file of files) {
            if (TEMP_FILES_PATTERN.test(file) || file.startsWith('temp_') || file.startsWith('ariya_') || file.startsWith('individual_')) {
                await fs.unlink(path.join(__dirname, file));
                deletedCount++;
            }
        }
        console.log(`✅ Vaqtinchalik fayllar tozalandi (${deletedCount} ta fayl o\'chirildi)`);
    } catch (err) {
        console.log('❌ Vaqtinchalik fayllarni o\'chirishda xatolik:', err.message);
    }

    // 4. employees.json ni tekshirish (o'chirmaymiz, faqat mavjudligini)
    try {
        const empRaw = await fs.readFile(EMPLOYEES_PATH, 'utf8');
        const employees = JSON.parse(empRaw);
        console.log(`✅ employees.json mavjud, xodimlar soni: ${employees.employees?.length || 0}`);
    } catch {
        console.log('⚠️ employees.json topilmadi, bot uni avtomatik yaratadi');
    }

    console.log('\n🎉 Tozalash tugallandi!');
    console.log('Endi botni qayta ishga tushirishingiz mumkin.');
}

// Ishga tushirish
cleanup().catch(console.error);
