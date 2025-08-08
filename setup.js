const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');

const DATA_DIR = path.join(__dirname, 'data');
const ADMIN_FILE = path.join(DATA_DIR, 'admin.json');

function hashPassword(password, salt) {
    return crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512').toString('hex');
}

async function setupAdmin() {
    try {
        await fs.access(ADMIN_FILE);
        console.log('管理员密码已存在，无需重复设置。');
        return;
    } catch (error) {
        console.log('开始设置管理员密码:');
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('请输入新密码: ', async (password) => {
            if (password) {
                const salt = crypto.randomBytes(16).toString('hex');
                const hash = hashPassword(password, salt);
                const adminConfig = { salt, hash };
                await fs.mkdir(DATA_DIR, { recursive: true });
                await fs.writeFile(ADMIN_FILE, JSON.stringify(adminConfig, null, 2));
                console.log('管理员密码已成功设置并保存到 data/admin.json。');
            } else {
                console.log('密码不能为空。');
            }
            rl.close();
        });
    }
}

setupAdmin();