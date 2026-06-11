import { spawn } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const apiPort = process.env.PORT || '3000';
const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${apiPort}`;
const processes = [];
let shuttingDown = false;

function startProcess(label, command, args, env = {}) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });

  processes.push(child);

  child.on('error', (error) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.error(`Failed to start ${label}: ${error.message}`);
    stopProcesses(child);
    process.exitCode = 1;
  });

  child.on('exit', (code, signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    const reason = signal ? `signal ${signal}` : `code ${code}`;
    console.error(`${label} exited with ${reason}; stopping dev processes.`);
    stopProcesses(child);
    process.exitCode = code ?? 1;
  });
}

function stopProcesses(exitedChild) {
  for (const child of processes) {
    if (child !== exitedChild && !child.killed) {
      child.kill('SIGTERM');
    }
  }
}

function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  stopProcesses();
  setTimeout(() => process.exit(0), 200).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

startProcess('API server', process.execPath, ['server.js'], {
  NODE_ENV: 'development',
  PORT: apiPort,
});

startProcess('Vite dev server', npmCommand, ['run', 'dev:client'], {
  VITE_API_TARGET: apiTarget,
});
