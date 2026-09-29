// Ten rounds in the one chalet (BOUWPLAN 2.0 table). Coordinates: Babylon frame (x east, z = -north), metres.
// Room assignment: kind1 = CH. ENFANTS 1 (south, R05), kind2 = CH. ENFANTS 2 (north, R09) - source-based (D36).
import type { LightState } from '../engine/world';

export interface Spawn { room: string; resting?: boolean; near?: [number, number, number]; }
export interface RoundDef {
  id: string; title: string; place: string; light: LightState; intro: string; objective: string;
  player: { x: number; z: number; yaw: number };
  mosquitoes: Spawn[]; alert: number; hostDrive: number; rest: [number, number]; speed: number;
  doors?: Record<string, number>;            // initial door angles (rad), default closed; within each door's opening, leaves clear of each other (tests/doors.test.ts)
  incoming?: { count: number; every: number; untilDoorClosed: string; from: [number, number, number] };
  silenceEnd?: boolean; limitRoom?: string | null;
}

const N = Math.PI / 2;    // yaw facing north (-z)
export const ROUNDS: RoundDef[] = [
  { id: 'r1', title: 'Eerste mug', place: 'Woonkamer', light: 'dag', intro: 'Een zacht gezoem boven de bank.', objective: 'Vind de mug en sla raak',
    player: { x: 4.05, z: -1.75, yaw: N }, mosquitoes: [{ room: 'woon', resting: true, near: [3.6, 1.55, -3.72] }], alert: 0.45, hostDrive: 0.15, rest: [8, 16], speed: 0.42,
    doors: { terras: 0 } },
  // r2: on the corner wall-cabinet front above the hood; at z 1.7 / y 3.2 she sat behind the hood's side (no line of sight, D46);
  // 1.95 m high was out of reach of the real arm over the worktop (D48): 10 cm lower, reachable leaning in ~16 cm
  { id: 'r2', title: 'Keukenranden', place: 'Keuken', light: 'dag', intro: 'Ze houdt van de kastjes.', objective: 'Sla de mug in de keuken',
    player: { x: 4.3, z: -2.2, yaw: 0.35 }, mosquitoes: [{ room: 'woon', resting: true, near: [5.9, 1.85, -3.42] }], alert: 0.65, hostDrive: 0.2, rest: [3, 7], speed: 0.5 },
  { id: 'r3', title: 'Gordijn en raam', place: 'Terrasdeur', light: 'dag', intro: 'Op glas en stof voelt een klap anders.', objective: 'Twee muggen bij raam en gordijn',
    player: { x: 4.4, z: -1.6, yaw: -N }, mosquitoes: [{ room: 'woon', resting: true, near: [4.2, 1.4, -0.1] }, { room: 'woon', resting: true, near: [3.3, 1.5, -3.73] }],
    alert: 0.7, hostDrive: 0.25, rest: [4, 9], speed: 0.5 },
  { id: 'r4', title: 'Deur dicht', place: 'Entree en veranda', light: 'dag', intro: 'De terrasdeur staat open. Er komen er meer binnen.', objective: 'Sluit de terrasdeur en ruim ze op',
    player: { x: 4.0, z: -2.3, yaw: -N }, mosquitoes: [{ room: 'woon' }], alert: 0.7, hostDrive: 0.3, rest: [4, 10], speed: 0.55,
    doors: { terras: 1.45 }, incoming: { count: 3, every: 9, untilDoorClosed: 'terras', from: [4.8, 1.5, 1.2] } },
  { id: 'r5', title: 'Tussen de bedden', place: 'Tweepersoonskamer 1', light: 'dag', intro: 'In de kinderkamer bij het raam.', objective: 'Zoek rond de bedden',
    player: { x: 3.0, z: -1.6, yaw: Math.PI }, mosquitoes: [{ room: 'kind1', resting: true, near: [0.1, 1.2, -0.95] }], alert: 0.75, hostDrive: 0.3, rest: [5, 12], speed: 0.5,
    doors: { kind1: 1.5 } },
  { id: 'r6', title: 'Waar zit ze?', place: 'Tweepersoonskamer 2', light: 'dag', intro: 'Luister goed: welke kamer?', objective: 'Vind de mug op geluid',
    player: { x: 4.2, z: -1.5, yaw: N }, mosquitoes: [{ room: 'kind2' }], alert: 0.8, hostDrive: 0.35, rest: [4, 9], speed: 0.52, doors: { kind2: 0.35 }, limitRoom: 'kind2' },
  { id: 'r7', title: 'Glas en spiegeling', place: 'Badkamer', light: 'dag', intro: 'Achter glas raak je niets.', objective: 'Twee muggen in de badkamer',
    player: { x: 5.9, z: -1.0, yaw: 0 }, mosquitoes: [{ room: 'bad', resting: true, near: [7.9, 1.6, -0.3] }, { room: 'bad', resting: true, near: [7.25, 1.45, -0.09] }],
    alert: 0.8, hostDrive: 0.3, rest: [5, 11], speed: 0.5, doors: { bad: 1.5, douche: 0 }, limitRoom: 'bad' },
  // r8: 10 cm further north on the east wall: the old spot could only be reached across the bed (D48)
  { id: 'r8', title: 'Schemer', place: 'Ouderslaapkamer', light: 'avond', intro: 'Het wordt donker. Eén leeslamp.', objective: 'Vind haar in de schemer',
    player: { x: 5.6, z: -1.6, yaw: 0 }, mosquitoes: [{ room: 'ouder', resting: true, near: [8.4, 1.5, -3.2] }, { room: 'ouder' }], alert: 0.85, hostDrive: 0.4, rest: [5, 12], speed: 0.52,
    doors: { ouder: 1.5 } },
  // r9/r10: the wc and kids-room-1 doors hinge 7 cm apart in one corner and both open into the living room: with kids room 1
  // wide open (80 deg) the wc door can stand only ajar (<= 0.21 rad; both at 1.4 put the leaves through each other and
  // locked both doors). Kids room 2 opens to 54 deg before the corner sofa (measured, world.measureMaxOpen).
  { id: 'r9', title: 'Nog één mug', place: 'Het hele chalet', light: 'nacht', intro: 'Eén laatste. Slim en schichtig.', objective: 'Nog één',
    player: { x: 4.3, z: -1.9, yaw: N }, mosquitoes: [{ room: 'woon' }], alert: 1.15, hostDrive: 0.5, rest: [6, 14], speed: 0.6,
    doors: { kind1: 1.4, kind2: 0.9, ouder: 1.4, bad: 1.4, wc: 0.2 }, silenceEnd: true },
  { id: 'r10', title: 'Rust in het chalet', place: 'Alle kamers', light: 'nacht', intro: 'Vijf muggen verspreid door het chalet.', objective: 'Maak het chalet muggenvrij',
    player: { x: 4.3, z: -1.9, yaw: N }, mosquitoes: [{ room: 'woon' }, { room: 'kind1' }, { room: 'kind2' }, { room: 'ouder' }, { room: 'bad', resting: true }],
    alert: 1.0, hostDrive: 0.45, rest: [5, 14], speed: 0.56, doors: { kind1: 1.4, kind2: 0.9, ouder: 1.4, bad: 1.4, wc: 0.2 } },
];
