const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const root = path.resolve(__dirname, '../..');
const destination = process.argv[2];
const modules = [];
function addModule(id, source) {
  modules.push(JSON.stringify(id) + ': function(module,exports,require){\n' + source + '\n}');
}
function collect(directory) {
  for (const entry of fs.readdirSync(path.join(root, directory), { withFileTypes: true })) {
    const relative = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) collect(relative);
    else if (entry.name.endsWith('.ts')) {
      const source = fs.readFileSync(path.join(root, relative), 'utf8');
      const output = ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
      }).outputText;
      addModule('/' + relative.slice(0, -3), output);
    }
  }
}
collect('src');
collect('native');
addModule(
  '/index',
  ts.transpileModule(fs.readFileSync(path.join(root, 'index.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
  }).outputText,
);
for (const name of ['buffer', 'base64-js', 'ieee754']) {
  addModule(name, fs.readFileSync(require.resolve(name + '/'), 'utf8'));
}
const bufferVersion = require('buffer/package.json').version;
const vectors = JSON.parse(
  fs.readFileSync(path.join(root, 'tests/algorithm-vectors.json'), 'utf8'),
);
const original = JSON.parse(fs.readFileSync(path.join(root, 'tests/vectors.json'), 'utf8'));
const boot = `
// The host owns the microtask pump; this fixture does not install RN's timer module.
let nextImmediate = 1;
const immediates = new Map();
globalThis.setImmediate = (callback, ...args) => {
 const id = nextImmediate++;
 immediates.set(id, () => callback(...args));
 queueMicrotask(() => {
   const task = immediates.get(id);
   immediates.delete(id);
   if(task) task();
 });
 return id;
};
globalThis.clearImmediate = (id) => { immediates.delete(id); };
const modules={${modules.join(',\n')}};
const cache=Object.create(null);
function load(request,parent='/index') {
 if(request==='react-native-nitro-modules') return {NitroModules:NitroModulesProxy};
 if(request==='react-native') return {Platform:{OS:'ios'},TurboModuleRegistry:{getEnforcing(){throw Error('Unexpected TurboModule request')}}};
 let id=request;
 if(id[0]==='.') {
   const parts=(parent.slice(0,parent.lastIndexOf('/'))+'/'+id).split('/');
   const normalized=[];
   for(const part of parts) { if(!part||part==='.')continue; if(part==='..')normalized.pop();else normalized.push(part); }
   id='/'+normalized.join('/');
 }
 if(cache[id]) return cache[id].exports;
 if(!modules[id]) throw new Error('Missing module '+id+' from '+parent);
 const module={exports:{}}; cache[id]=module;
 modules[id](module,module.exports,(next)=>load(next,id));
 return module.exports;
}
const api=load('/index');
const runFileHashForTest=load('/src/runFileHash').default;
const normalize=load('/src/normalizeHashInput').default;
const Buffer=load('buffer').Buffer;
const VECTORS=${JSON.stringify(vectors.vectors)};
const ORIGINAL=${JSON.stringify(original.strings)};
const BUFFER_VERSION=${JSON.stringify(bufferVersion)};
`;
fs.writeFileSync(
  destination,
  boot +
    fs.readFileSync(path.join(__dirname, 'range-suite.js'), 'utf8') +
    '\n' +
    fs.readFileSync(path.join(__dirname, 'extensions-suite.js'), 'utf8'),
);
