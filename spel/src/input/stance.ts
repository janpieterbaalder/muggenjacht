// The posture slider's scale (input.ts reads it, main.ts draws the knob). Its own module: the start screen loads
// without the game code (G-17).

/** The toes take the top STANCE_UP of the slider's track, standing is the mark there, bending down the rest. */
export const STANCE_UP = 0.25;
/** slider position (0 top .. 1 bottom) of a posture (-1 low .. 1 on the toes), and back */
export const stanceToTrack = (s: number) => (s >= 0 ? STANCE_UP * (1 - s) : STANCE_UP + (1 - STANCE_UP) * -s);
export const trackToStance = (f: number) => (f <= STANCE_UP ? 1 - Math.max(0, f) / STANCE_UP : -Math.min(1, (f - STANCE_UP) / (1 - STANCE_UP)));
