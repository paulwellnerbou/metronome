// The scheduler's heartbeat. It lives in a worker because browsers throttle
// main-thread timers in a background tab to one per second — far longer than
// the scheduler looks ahead, so the beat would stutter as soon as you switched
// tabs.
let id = null;

onmessage = (e) => {
  clearInterval(id);
  id = e.data > 0 ? setInterval(() => postMessage(0), e.data) : null;
};
