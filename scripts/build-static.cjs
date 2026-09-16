// Only browser assets are public. Repository data, tests and server source stay out of dist.
const fs = require('node:fs');
const path = require('node:path');
const files = ['index.html', 'manifest.json', 'icon.svg', 'sw.js',
  'assets/intelligence-core.js', 'assets/intelligence-ui.js', 'assets/intelligence.css'];
function build(root = path.resolve(__dirname, '..')) {
  const out = path.join(root, 'dist');
  fs.rmSync(out, {recursive: true, force: true});
  files.forEach(file => { fs.mkdirSync(path.dirname(path.join(out, file)), {recursive: true}); fs.copyFileSync(path.join(root, file), path.join(out, file)); });
  return files;
}
if (require.main === module) { build(); console.log('Built 7 public assets; data and server files excluded.'); }
module.exports = {build, files};
