import { spawn, execSync } from 'node:child_process';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const apiPort = process.env.PORT || '3000';
const apiTarget = process.env.VITE_API_TARGET || `http://localhost:${apiPort}`;
const processes = [];
let shuttingDown = false;

function freePort(port) {
  try {
    if (process.platform === 'win32') {
      const result = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
      const pids = [...new Set(result.trim().split('\n').map(line => line.trim().split(/\s+/).pop()).filter(Boolean))];
      for (const pid of pids) {
        try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch { /* already gone */ }
      }
    } else {
      const pids = execSync(`lsof -ti tcp:${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
      if (pids) {
        for (const pid of pids.split('\n').filter(Boolean)) {
          try {
            execSync(`kill -TERM ${pid}`, { stdio: 'ignore' });
          } catch {
            /* already gone */
          }
        }
        // Allow graceful shutdown before force-kill
        try {
          execSync('sleep 0.5', { stdio: 'ignore' });
        } catch {
          /* ignore */
        }
        const remaining = execSync(`lsof -ti tcp:${port}`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore'],
        }).trim();
        if (remaining) {
          execSync(`kill -9 ${remaining.split('\n').join(' ')}`, { stdio: 'ignore' });
          console.log(`Freed port ${port} (killed PID ${remaining.replace(/\n/g, ', ')}).`);
        } else {
          console.log(`Freed port ${port} (SIGTERM).`);
        }
      }
    }
  } catch {
    // Port is not in use or kill failed — proceed anyway
  }
}

freePort(apiPort);

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
