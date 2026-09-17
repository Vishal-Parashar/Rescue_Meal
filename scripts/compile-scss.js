const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const scssRoot = path.join(projectRoot, 'public', 'scss');
const cssRoot = path.join(projectRoot, 'public', 'css');
const entryRoot = path.join(__dirname, '.scss-entry');
const dashboards = ['admin', 'delivery-partner', 'food-producer', 'ngo'];
const watch = process.argv.includes('--watch');

fs.mkdirSync(entryRoot, { recursive: true });
fs.mkdirSync(path.join(cssRoot, 'dashboards'), { recursive: true });

const mappings = [
  `${path.join(scssRoot, 'styles.scss')}:${path.join(cssRoot, 'styles.css')}`,
];

for (const dashboard of dashboards) {
  const entryFile = path.join(entryRoot, `${dashboard}.scss`);
  const dashboardFile = path.join(scssRoot, 'dashboards', `${dashboard}.scss`);
  fs.writeFileSync(
    entryFile,
    `@import "${path.relative(path.dirname(entryFile), path.join(scssRoot, 'styles.scss')).replace(/\\/g, '/')}";\n@import "${path.relative(path.dirname(entryFile), dashboardFile).replace(/\\/g, '/')}";\n`,
    'utf8',
  );
  mappings.push(`${entryFile}:${path.join(cssRoot, 'dashboards', `${dashboard}.css`)}`);
}

const args = watch ? ['--watch', ...mappings] : mappings;
const result = spawnSync('sass', args, {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: true,
});

process.exit(result.status === null ? 1 : result.status);
