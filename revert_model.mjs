import fs from 'fs';
import path from 'path';

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);

    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git' && file !== 'dist') {
                results = results.concat(walk(fullPath));
            }
        } else {
            if (fullPath.endsWith('.ts') || fullPath.endsWith('.js') || fullPath.endsWith('.mjs')) {
                results.push(fullPath);
            }
        }
    });
    return results;
}

const allFiles = walk(path.join(process.cwd()));
let modifiedCount = 0;

for (const file of allFiles) {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('gemini-2.5-flash')) {
        const newContent = content.replaceAll('gemini-2.5-flash', 'gemini-2.5-flash');
        fs.writeFileSync(file, newContent, 'utf8');
        console.log(`Reverted in ${file}`);
        modifiedCount++;
    }
}
console.log(`\nReverted model in ${modifiedCount} files!`);
