const FRAMES = ["◇", "◈", "◆", "◈"];

export function animationEnabled(stream = process.stdout, env = process.env) {
  return Boolean(stream.isTTY && !env.IVA_NO_ANIM && !env.NO_COLOR && env.TERM !== "dumb");
}

export function createTerminalProgress({
  stream = process.stdout,
  env = process.env,
  intervalMs = 90,
  verbose = false,
} = {}) {
  const animate = animationEnabled(stream, env) && !verbose;
  let timer = null;
  let frame = 0;
  let active = null;
  let cursorHidden = false;
  const signals = ["SIGINT", "SIGTERM"];

  const hideCursor = () => {
    if (!animate || cursorHidden) return;
    stream.write("\x1b[?25l");
    cursorHidden = true;
  };
  const showCursor = () => {
    if (!cursorHidden) return;
    stream.write("\x1b[?25h");
    cursorHidden = false;
  };
  const draw = () => {
    if (!active) return;
    const text = `${FRAMES[frame++ % FRAMES.length]} ${active}`;
    stream.write(animate ? `\r\x1b[2K${text}` : `${text}\n`);
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const finishLine = (symbol, text) => {
    stopTimer();
    if (animate && active) stream.write("\r\x1b[2K");
    active = null;
    showCursor();
    stream.write(`${symbol} ${text}\n`);
  };

  const api = {
    start(text) {
      if (active) finishLine("✓", active);
      active = text;
      frame = 0;
      hideCursor();
      draw();
      if (animate) timer = setInterval(draw, intervalMs);
    },
    done(text) {
      finishLine("✓", text);
    },
    fail(text) {
      finishLine("⚠️", text);
    },
    info(text) {
      if (active && animate) stream.write("\r\x1b[2K");
      stream.write(`${text}\n`);
      if (active && animate) draw();
    },
    dispose() {
      stopTimer();
      if (animate && active) stream.write("\r\x1b[2K");
      active = null;
      showCursor();
      for (const signal of signals) process.removeListener(signal, signalHandlers[signal]);
    },
  };
  const signalHandlers = Object.fromEntries(signals.map((signal) => [signal, () => {
    api.dispose();
    process.kill(process.pid, signal);
  }]));
  if (animate) for (const signal of signals) process.once(signal, signalHandlers[signal]);
  return api;
}

export { FRAMES as SPINNER_FRAMES };
