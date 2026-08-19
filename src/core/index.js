/**
 * The pure decision kernel: no filesystem, no clock of its own, no Claude Code
 * knowledge. Everything here is a function of its arguments, which is why it is
 * the only part worth unit-testing exhaustively.
 *
 * Anything that touches a disk or an external contract lives in ../io.
 */
export * from './profiles.js';
export * from './detect.js';
export * from './policy.js';
export * from './format.js';
