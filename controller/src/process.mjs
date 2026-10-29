import { spawn } from 'node:child_process';

export async function command(executable, args, { cwd, env = process.env, input, timeout = 120000, limit = 16 * 1024 * 1024, encoding = 'utf8' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let size = 0, failure;
    const timer = setTimeout(() => { failure = new Error(`${executable} timed out`); child.kill('SIGKILL'); }, timeout);
    const collect = target => data => {
      size += data.length;
      if (size > limit) { failure = new Error(`${executable} output limit exceeded`); child.kill('SIGKILL'); }
      else target.push(data);
    };
    child.stdout.on('data', collect(stdout)); child.stderr.on('data', collect(stderr));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code !== 0) reject(Object.assign(new Error(`${executable} exited ${code}`), { exitCode: code, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') }));
      else resolve({ stdout: encoding === null ? Buffer.concat(stdout) : Buffer.concat(stdout).toString(encoding), stderr: Buffer.concat(stderr).toString('utf8') });
    });
    child.stdin.end(input);
  });
}
