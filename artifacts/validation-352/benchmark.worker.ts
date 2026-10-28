import { benchmark } from "./benchmark";
self.onmessage = async () => {
  try { self.postMessage({ rows: await benchmark(true) }); }
  catch (error) { self.postMessage({ error: String(error) }); }
};
