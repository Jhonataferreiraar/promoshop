function waitForExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
  });
}

function signalChild(child, signal, processGroup) {
  if (processGroup && process.platform !== 'win32' && Number.isInteger(child.pid)) {
    process.kill(-child.pid, signal);
    return;
  }
  child.kill(signal);
}

export async function terminateChildProcess(child, {
  gracefulTimeoutMs = 7_000,
  forcedTimeoutMs = 2_000,
  processGroup = false
} = {}) {
  if (!child || child.exitCode !== null) return { exited: true, forced: false };

  const gracefulExit = waitForExit(child, gracefulTimeoutMs);
  try {
    signalChild(child, 'SIGTERM', processGroup);
  } catch {
    return { exited: child.exitCode !== null, forced: false };
  }
  if (await gracefulExit) return { exited: true, forced: false };

  const forcedExit = waitForExit(child, forcedTimeoutMs);
  try {
    signalChild(child, 'SIGKILL', processGroup);
  } catch {
    return { exited: child.exitCode !== null, forced: true };
  }
  const exited = await forcedExit;
  return { exited, forced: true };
}
