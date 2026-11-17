const { spawn } = require('node:child_process');
const { Writable } = require('node:stream');

const transparentSpawn = (exec, spawnParms = [], env, cwd, opts = {}, custom = null) => {
  const errors = [];
  let useEnv = undefined;
  if (env === muteTSpawn) {
    useEnv = process.env;
    custom = muteTSpawn;
  } else if (env === nullTSpawn) {
    useEnv = process.env;
    custom = nullTSpawn;
  } else {
    useEnv = env || process.env;
  }

  const child = spawn(exec, spawnParms, { ...opts, env: useEnv, cwd });
  const promise = new Promise((resolve, reject) => {
    const defaultLog = (...args) => custom && typeof custom.log === 'function' ? custom.log : console.log(...args);
    const defaultStdOut = () => child.stdout && child.stdout.pipe(process.stdout);
    const defaultStdErr = () => child.stderr && child.stderr.pipe(process.stderr);

    if (custom) {
      if (typeof custom === 'function') {
        custom = custom();
      }
      custom.stdout ? child.stdout.pipe(custom.stdout) : defaultStdOut();
      custom.stderr ? child.stderr.pipe(custom.stderr) : defaultStdErr();
    } else {
      defaultStdOut();
      defaultStdErr();
    }

    defaultLog(`\nStarting ${exec} ${spawnParms.join(' ')}`);
    const execStartTime = new Date().getTime();

    child.on('error', (error) => {
      errors.push(error);
    });
    child.on('exit', (code) => {
      const isNonZero = !!(code === 0 || code === null);
      const execPath = exec.includes('/') && exec.split('/').length > 1 && exec.startsWith('/') ? exec.split('/').slice(0, -1).join('/') : '';
      defaultLog(` - ${execPath ? exec.replace(`${execPath}/`, '') : exec} ${spawnParms.join(' ')}` +
        `${execPath ? `\n   - Exec Path: ${execPath}` : ``}` +
        `${execPath ? `\n   - Full Exec: ${exec}` : ``}` +
        `${cwd && cwd.split('/').length > 1 ? `\n   - Exec CWD: ${cwd}` : ``}` +
        `\n   - Exit code is: ${code} ${isNonZero ? `✅` : `❌`}` +
        `\n   - Duration: ${((new Date().getTime() - execStartTime) / 1000).toFixed(2)}s`
      );
      if (errors.length > 0) {
        defaultLog(` - Error${errors.length === 1 ? '' : 's'}: `,);
        errors.forEach((error, n) => {
          defaultLog(` - Error ${n+1}: `, error);
        });
      }
      if (isNonZero) {
        resolve({ exec, spawnParms });
        return;
      }
      reject(new Error(`Exit code is: ${code}`));
    });
  })
  return { promise, child };
};

const muteTSpawn = () => {
  const devNull = new Writable({ write: (_c, _e, cb) => cb() });
  return {
    stdout: devNull,
    stderr: process.stderr // This keeps the standard error path
  };
};

const nullTSpawn = () => {
  const devNull = new Writable({ write: (_c, _e, cb) => cb() });
  return {
    log: () => null,
    stdout: devNull,
    stderr: process.stderr // This keeps the standard error path
  };
};

const silentSpawn = (exec, spawnParms, env, cwd, opts, custom = nullTSpawn) => transparentSpawn(exec, spawnParms, env, cwd, opts, custom);
module.exports = { transparentSpawn, muteTSpawn, silentSpawn };
