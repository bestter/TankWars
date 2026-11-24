/** Fabrique paresseuse du contexte partagé. `null` laisse le son silencieux. */
export type EnsureAudioContext = () => AudioContext | null;

/** Enregistre une source prête à démarrer sur l'horloge du contexte. */
export type ScheduleAudioSource = (start: (time: number) => void) => void;
