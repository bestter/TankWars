/** Start a rendered local game; the returned disposer cancels even an already queued frame. */
export function startCanvasLoop(render: () => void): () => void {
  let active = true;
  let frame: number | undefined;
  const draw = () => {
    if (!active) return;
    render();
    if (active) frame = requestAnimationFrame(draw);
  };
  draw();
  return () => { active = false; if (frame !== undefined) cancelAnimationFrame(frame); };
}
