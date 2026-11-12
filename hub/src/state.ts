// Per-user Claude Code status, aggregated over all of the user's sessions.
// Direct port of class State / view in claude-desk/cdesk.py (the tested reference), with the
// client sending pre-trimmed events (PROTOCOL.md section 4).
import { hhmm, oneLine, trunc } from "./util.js";

export const DONE_SECS = 10;
export const WORKING_TTL = 15 * 60;
export const NEEDS_TTL = 60 * 60;
export const SESSION_TTL = 6 * 3600;
export const WAIT_TTL = 3 * 3600;
export const MAX_SESSIONS = 64;
const NEEDS_TYPES = new Set(["permission_prompt", "elicitation_dialog", "elicitation_url_dialog", "agent_needs_input"]);

export interface HookEvent {
  e?: unknown; sid?: unknown; project?: unknown; tool?: unknown; detail?: unknown;
  tid?: unknown; ntype?: unknown; msg?: unknown;
}

interface Pending { detail: string; ck: string; since: number }
interface Session {
  pending: Record<string, Pending>;
  generic: { detail: string; since: number } | null;
  done: number;
  active: number;
  project: string;
  ts: number;
}
export type Sessions = Record<string, Session>;

export interface View { s: "idle" | "working" | "needs" | "done"; p: string; d: string; f: string; t: number; w: number; wp: string }

const str = (v: unknown, n: number) => trunc(oneLine(v), n);

/** Content key for a tool call (fallback when tid is missing): tool + ":" + detail. */
const toolKey = (tool: string, detail: string) => tool + ":" + detail;

function describeTool(tool: string, detail: string) {
  return detail ? `Allow ${tool || "a tool"}: ${detail}` : `Allow ${tool || "a tool"}?`;
}

/** Applies one hook event to the user's sessions (mutates and returns them). */
export function applyEvent(sessions: Sessions, ev: HookEvent, now: number): Sessions {
  const name = typeof ev.e === "string" ? ev.e : "";
  const sid = str(ev.sid, 128) || "default";
  const project = str(ev.project, 64) || "claude code";
  const tool = str(ev.tool, 64);
  const detail = str(ev.detail, 120);
  const tid = str(ev.tid, 128);

  if (!sessions[sid]) {
    // keep memory bounded: drop the least recently touched session
    const ids = Object.keys(sessions);
    if (ids.length >= MAX_SESSIONS) {
      ids.sort((a, b) => sessions[a].ts - sessions[b].ts);
      delete sessions[ids[0]];
    }
    sessions[sid] = { pending: {}, generic: null, done: 0, active: now, project, ts: now };
  }
  const s = sessions[sid];
  s.project = project;
  s.ts = now;

  switch (name) {
    case "UserPromptSubmit":
      Object.assign(s, { pending: {}, generic: null, done: 0, active: now });
      break;
    case "PermissionRequest": {
      const key = tid || toolKey(tool, detail);
      s.pending[key] = { detail: describeTool(tool, detail), ck: toolKey(tool, detail), since: now };
      s.active = now;
      break;
    }
    case "PostToolUse":
    case "PreToolUse":
      if (name === "PostToolUse") {
        const ck = toolKey(tool, detail);
        for (const [k, p] of Object.entries(s.pending)) {
          if ((tid && k === tid) || p.ck === ck) delete s.pending[k];
        }
        if (Object.keys(s.pending).length === 0) s.generic = null;
      }
      s.active = now;
      break;
    case "Notification": {
      const ntype = str(ev.ntype, 64);
      const msg = str(ev.msg, 80);
      const needs = NEEDS_TYPES.has(ntype) || (!ntype && msg.toLowerCase().includes("permission"));
      if (needs && Object.keys(s.pending).length === 0) s.generic = { detail: msg || "Needs your input", since: now };
      break;
    }
    case "Stop":
      Object.assign(s, { pending: {}, generic: null, done: now, active: now });
      break;
    case "SessionEnd":
      delete sessions[sid];
      break;
  }
  return sessions;
}

/** Drops stale sessions (mutates) and computes what the screen should show. */
export function computeView(sessions: Sessions, now: number, tz: string): View {
  for (const [sid, s] of Object.entries(sessions)) if (now - s.ts > SESSION_TTL) delete sessions[sid];

  const waits: [number, string, string][] = [];
  const done: [number, string][] = [];
  const waiting: [number, string][] = [];
  let working = false;
  let lastActive = 0;
  for (const s of Object.values(sessions)) {
    for (const p of Object.values(s.pending)) if (now - p.since < NEEDS_TTL) waits.push([p.since, s.project, p.detail]);
    if (s.generic && now - s.generic.since < NEEDS_TTL) waits.push([s.generic.since, s.project, s.generic.detail]);
    if (s.done && now - s.done < DONE_SECS) done.push([s.done, s.project]);
    if (s.done && now - s.done < WAIT_TTL) waiting.push([s.done, s.project]);
    if (now - s.active < WORKING_TTL && !s.done) {
      working = true;
      lastActive = Math.max(lastActive, s.active);
    }
  }
  const cmp = (a: (number | string)[], b: (number | string)[]) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i] ? 1 : -1;
    return 0;
  };
  waiting.sort(cmp);
  const w = waiting.length, wp = w ? trunc(waiting[0][1], 32) : "";
  if (waits.length) {
    waits.sort(cmp); // newest request first (same tuple ordering as Python's sort(reverse=True))
    const [t, proj, detail] = waits[0];
    const extra = waits.length > 1 ? `+${waits.length - 1} more waiting · ` : "";
    return { s: "needs", p: trunc(proj, 32), d: trunc(detail, 80), f: trunc(extra + hhmm(t, tz), 40), t: Math.floor(t), w, wp };
  }
  if (done.length) {
    done.sort(cmp);
    const [t, proj] = done[0];
    return { s: "done", p: trunc(proj, 32), d: "Finished", f: hhmm(t, tz), t: Math.floor(t), w, wp };
  }
  if (working) return { s: "working", p: "", d: "", f: "", t: Math.floor(lastActive), w, wp };
  return { s: "idle", p: "", d: "", f: "", t: 0, w, wp };
}

/** Key used to decide whether the published view changed. */
export const viewKey = (v: View) => `${v.s}\u0000${v.p}\u0000${v.d}\u0000${v.f}\u0000${v.w ?? 0}`;
